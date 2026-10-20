import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:43173';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const screenshotDir = resolve('artifacts', 'screenshots');
await mkdir(screenshotDir, { recursive: true });

async function freePort() {
  const server = createServer();
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  const { port } = server.address();
  await new Promise((accept) => server.close(accept));
  return port;
}

async function waitForJson(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(`Browser endpoint did not become ready: ${url}`);
}

function cdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  const opened = new Promise((accept, reject) => {
    socket.addEventListener('open', accept, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    if (message.error) promise.reject(new Error(message.error.message));
    else promise.resolve(message.result);
  });
  return {
    opened,
    close: () => socket.close(),
    async send(method, params = {}) {
      await opened;
      const id = nextId++;
      const result = new Promise((accept, reject) => pending.set(id, { resolve: accept, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
  };
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(client, expression, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function screenshot(client, name) {
  await new Promise((accept) => setTimeout(accept, 250));
  const metrics = await client.send('Page.getLayoutMetrics');
  const { contentSize } = metrics;
  const capture = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(contentSize.width), height: Math.ceil(contentSize.height), scale: 1 },
  });
  await writeFile(join(screenshotDir, name), Buffer.from(capture.data, 'base64'));
}

const debugPort = await freePort();
const profile = await mkdtemp(join(tmpdir(), 'notice-action-chrome-'));
const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

let client;
try {
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' }).then((response) => response.json());
  client = cdpClient(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const nativeFetch = window.fetch.bind(window);
    const credentialState = { configured: false, saved: false };
    window.__credentialApiState = credentialState;
    window.__credentialApiPayload = null;
    window.__incrementalParseCalls = 0;
    window.__incrementalMergePayloads = [];
    window.__incrementalFinalizePayloads = [];
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    window.fetch = (url, options = {}) => {
      const path = new URL(String(url), window.location.href).pathname;
      if (path === '/api/health') {
        const capability = new URL(window.location.href).searchParams.has('legacy_health') ? {} : {
          credential_management_version: 1,
          credential_storage_available: true,
          credential_storage_error: false,
        };
        return json({
          ok: true,
          ...capability,
          live_parse_configured: credentialState.configured,
          credentials_saved: credentialState.saved,
        });
      }
      if (path === '/api/credentials/clear') {
        const completeClear = () => {
          credentialState.configured = false;
          credentialState.saved = false;
          window.__credentialApiPayload = null;
          return json({ ok: true, credential_management_version: 1, credential_storage_available: true, credential_storage_error: false, live_parse_configured: false, credentials_saved: false });
        };
        if (window.__holdCredentialClear) {
          return new Promise((resolve) => { window.__releaseCredentialClear = () => resolve(completeClear()); });
        }
        return completeClear();
      }
      if (path === '/api/credentials') {
        if (window.__failCredentialSave) {
          window.__credentialFailureIntercepted = true;
          return Promise.resolve(new Response(JSON.stringify({ ok: false, error: { message: '加密存储暂时不可用' } }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        window.__credentialApiPayload = JSON.parse(options.body || '{}');
        credentialState.configured = true;
        credentialState.saved = true;
        return json({ ok: true, credential_management_version: 1, credential_storage_available: true, credential_storage_error: false, live_parse_configured: true, credentials_saved: true });
      }
      if (path === '/api/parse' && window.__rejectParseCredentials) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: false,
          error: {
            code: 'TEXTIN_CREDENTIALS_INVALID',
            message: 'TextIn 拒绝了当前 AppID / Secret Code。请在“解析设置”中重新保存工作台里的最新凭据。',
          },
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (path === '/api/parse' && window.__mockIncrementalUpload) {
        const parseCall = ++window.__incrementalParseCalls;
        const filename = new URL(String(url), window.location.href).searchParams.get('filename') || '通知材料';
        return options.body.arrayBuffer().then((buffer) => {
          let hash = Array.from(filename).reduce((value, character) => ((value * 31) + character.codePointAt(0)) >>> 0, 0);
          for (const byte of new Uint8Array(buffer)) hash = ((hash * 31) + byte) >>> 0;
          return json({
            ok: true,
            document: {
              document_id: 'incremental-' + hash.toString(16),
              name: filename,
              issued_at: '2026-10-' + String(20 + parseCall).padStart(2, '0') + 'T09:00:00+08:00',
              markdown: filename,
              elements: [{ element_id: 'element-' + parseCall, page_number: 1, text: filename }],
            },
          });
        });
      }
      if (path === '/api/merge' && window.__mockIncrementalUpload) {
        const payload = JSON.parse(options.body || '{}');
        window.__incrementalMergePayloads.push(payload);
        return nativeFetch('/api/demo?child_name=' + encodeURIComponent('林小满') + '&participating=true')
          .then((response) => response.json())
          .then((body) => {
            const incremental = payload.documents.length > 1;
            const currentEvent = payload.context.current_event || {};
            const event = incremental
              ? { ...body.analysis.event, meet_location: '图书馆门口' }
              : body.analysis.event;
            const changes = incremental
              ? body.analysis.changes.map((change) => {
                  if (change.id === 'event_date') return { ...change, before: currentEvent.date, after: event.date };
                  if (change.id === 'meet_time') return { ...change, before: currentEvent.meet_time, after: event.meet_time };
                  if (change.id === 'meet_location') return { ...change, before: currentEvent.meet_location, after: event.meet_location };
                  return change;
                })
              : body.analysis.changes;
            return json({
              ...body,
              analysis: {
                ...body.analysis,
                event,
                changes,
                documents: payload.documents.map(({ document_id, name, issued_at }) => ({ document_id, name, issued_at })),
                summary: { ...body.analysis.summary, document_count: payload.documents.length },
              },
            });
          });
      }
      if (path === '/api/finalize' && window.__mockIncrementalUpload) {
        window.__incrementalFinalizePayloads.push(JSON.parse(options.body || '{}'));
      }
      return nativeFetch(url, options);
    };
  })();` });
  await client.send('Page.navigate', { url: origin });
  await waitFor(client, "document.readyState === 'complete'");
  await waitFor(client, "document.querySelector('#service-status')?.textContent.includes('示例模式可用')");
  const emptyDashboard = await evaluate(client, "({ visible: !document.querySelector('#view-dashboard').hidden, empty: !document.querySelector('#dashboard-empty').hidden, onboardingSteps: document.querySelectorAll('#onboarding-flow li').length, materialsReady: ['学校通知', '分组表', '群聊截图'].every((word) => document.querySelector('#onboarding-materials').textContent.includes(word)), quickDemoVisible: Boolean(document.querySelector('#quick-demo-button').offsetParent), demoSafe: document.querySelector('#demo-safety-note').textContent.includes('不会保存'), dashboardDataHidden: document.querySelector('#dashboard-content').hidden, family: document.querySelector('#current-family').textContent, settingsVisible: Boolean(document.querySelector('#credentials-button').offsetParent), helpVisible: Boolean(document.querySelector('#help-button').offsetParent), currentNav: document.querySelector('.primary-nav [data-view=\"dashboard\"]').getAttribute('aria-current'), overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth), analyzeDisabled: document.querySelector('#analyze-button').disabled, analyzeLabel: document.querySelector('#analyze-button').textContent, liveModeNote: !document.querySelector('#live-mode-note').hidden })");
  assert.deepEqual(emptyDashboard, {
    visible: true,
    empty: true,
    onboardingSteps: 3,
    materialsReady: true,
    quickDemoVisible: true,
    demoSafe: true,
    dashboardDataHidden: true,
    family: '尚未选择家庭',
    settingsVisible: true,
    helpVisible: true,
    currentNav: 'page',
    overflow: 0,
    analyzeDisabled: true,
    analyzeLabel: '下一步：解析并整理',
    liveModeNote: true,
  });
  await screenshot(client, '00-dashboard-empty-desktop.png');

  await evaluate(client, "document.querySelector('#credentials-button').click(); true");
  await waitFor(client, "document.querySelector('#credentials-dialog').open && document.activeElement.id === 'credentials-app-id'");
  assert.deepEqual(await evaluate(client, "({ appId: document.querySelector('#credentials-app-id').value, secret: document.querySelector('#credentials-secret-code').value, formAutocomplete: document.querySelector('#credentials-form').autocomplete, secretAutocomplete: document.querySelector('#credentials-secret-code').autocomplete, encryptedNote: document.querySelector('#credentials-dialog').textContent.includes('Windows DPAPI') && document.querySelector('#credentials-dialog').textContent.includes('当前 Windows 用户') })"), {
    appId: '',
    secret: '',
    formAutocomplete: 'off',
    secretAutocomplete: 'off',
    encryptedNote: true,
  });
  await evaluate(client, `(() => {
    document.querySelector('#credentials-app-id').value = 'browser-test-app';
    document.querySelector('#credentials-secret-code').value = 'browser-test-secret';
    document.querySelector('#credentials-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#credentials-dialog').open && document.querySelector('#service-status').textContent.includes('在线解析已就绪')");
  await waitFor(client, "document.activeElement.id === 'credentials-button'");
  assert.deepEqual(await evaluate(client, `({
    requestShape: Object.keys(window.__credentialApiPayload || {}).sort().join(','),
    configured: window.__credentialApiState.configured,
    analyzeEnabled: !document.querySelector('#analyze-button').disabled,
    noteHidden: document.querySelector('#live-mode-note').hidden,
    fieldsCleared: document.querySelector('#credentials-app-id').value === '' && document.querySelector('#credentials-secret-code').value === '',
    noSecretInDom: !document.documentElement.outerHTML.includes('browser-test-secret'),
    noSecretInStorage: !Object.values(localStorage).some((value) => value.includes('browser-test-secret')),
    focusRestored: document.activeElement.id === 'credentials-button',
  })`), {
    requestShape: 'app_id,secret_code',
    configured: true,
    analyzeEnabled: true,
    noteHidden: true,
    fieldsCleared: true,
    noSecretInDom: true,
    noSecretInStorage: true,
    focusRestored: true,
  });
  await evaluate(client, `(() => {
    document.querySelector('#dashboard-start-button').click();
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7'], 'invalid-credentials.pdf', { type: 'application/pdf' }));
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#child-name').value = '林小满';
    document.querySelector('#class-name').value = '三（2）班';
    window.__rejectParseCredentials = true;
    document.querySelector('#upload-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "document.querySelector('#credentials-dialog').open && document.querySelector('#credentials-status').classList.contains('is-error')");
  assert.deepEqual(await evaluate(client, `({
    settingsMessage: document.querySelector('#credentials-status').textContent,
    globalMessage: document.querySelector('#global-message').textContent,
    fileState: document.querySelector('#file-list .file-state').textContent,
    fieldsBlank: document.querySelector('#credentials-app-id').value === '' && document.querySelector('#credentials-secret-code').value === '',
  })`), {
    settingsMessage: 'TextIn 拒绝了当前 AppID / Secret Code。请在“解析设置”中重新保存工作台里的最新凭据。',
    globalMessage: 'invalid-credentials.pdf：TextIn 拒绝了当前 AppID / Secret Code。请在“解析设置”中重新保存工作台里的最新凭据。',
    fileState: '解析失败',
    fieldsBlank: true,
  });
  await evaluate(client, "window.__rejectParseCredentials = false; document.querySelector('#credentials-close').click(); document.querySelector('.primary-nav [data-view=\"dashboard\"]').click(); true");
  await waitFor(client, "!document.querySelector('#credentials-dialog').open");
  await evaluate(client, "document.querySelector('#credentials-button').click(); window.confirm = () => true; window.__holdCredentialClear = true; document.querySelector('#credentials-clear').click(); true");
  await waitFor(client, "document.querySelector('#credentials-clear').textContent.includes('正在清除')");
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  assert.deepEqual(await evaluate(client, "({ dialogOpen: document.querySelector('#credentials-dialog').open, saveLabel: document.querySelector('#credentials-save').textContent })"), {
    dialogOpen: false,
    saveLabel: '保存并启用',
  });
  await evaluate(client, "document.querySelector('#credentials-button').click(); true");
  await waitFor(client, "document.querySelector('#credentials-dialog').open");
  assert.equal(await evaluate(client, "document.querySelector('#credentials-save').disabled && document.querySelector('#credentials-clear').disabled"), true);
  await evaluate(client, "window.__releaseCredentialClear(); true");
  await waitFor(client, "document.querySelector('#service-status').textContent.includes('示例模式可用')");
  assert.deepEqual(await evaluate(client, "({ configured: window.__credentialApiState.configured, analyzeDisabled: document.querySelector('#analyze-button').disabled, noteVisible: !document.querySelector('#live-mode-note').hidden, appId: document.querySelector('#credentials-app-id').value, secret: document.querySelector('#credentials-secret-code').value })"), {
    configured: false,
    analyzeDisabled: true,
    noteVisible: true,
    appId: '',
    secret: '',
  });
  assert.equal(await evaluate(client, "document.querySelector('#credentials-dialog').open && !document.querySelector('#credentials-save').disabled"), true);
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await waitFor(client, "!document.querySelector('#credentials-dialog').open && document.activeElement.id === 'credentials-button'");

  await evaluate(client, "window.__failCredentialSave = true; document.querySelector('#credentials-button').click(); true");
  await waitFor(client, "document.querySelector('#credentials-dialog').open && !document.querySelector('#credentials-save').disabled");
  await evaluate(client, `(() => {
    document.querySelector('#credentials-app-id').value = 'retry-app';
    document.querySelector('#credentials-secret-code').value = 'retry-secret';
    document.querySelector('#credentials-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "window.__credentialFailureIntercepted === true");
  await waitFor(client, "document.querySelector('#credentials-dialog').open && document.querySelector('#credentials-status').classList.contains('is-error')");
  assert.deepEqual(await evaluate(client, "({ message: document.querySelector('#credentials-status').textContent, saveEnabled: !document.querySelector('#credentials-save').disabled })"), {
    message: '加密存储暂时不可用',
    saveEnabled: true,
  });
  await evaluate(client, "window.__failCredentialSave = false; document.querySelector('#credentials-close').click(); true");
  await waitFor(client, "!document.querySelector('#credentials-dialog').open && document.activeElement.id === 'credentials-button'");

  await evaluate(client, "document.querySelector('#help-button').click(); true");
  await waitFor(client, "document.querySelector('#help-dialog').open");
  assert.deepEqual(await evaluate(client, "({ flow: ['上传', '确认', '清单'].every((word) => document.querySelector('#help-dialog').textContent.includes(word)), result: document.querySelector('#help-dialog').textContent.includes('行动清单') })"), { flow: true, result: true });
  await screenshot(client, '00-help-desktop.png');
  await evaluate(client, "document.querySelector('#help-close').click(); true");
  await waitFor(client, "!document.querySelector('#help-dialog').open");
  await waitFor(client, "document.activeElement.id === 'help-button'");
  await evaluate(client, "document.querySelector('#help-button').click(); true");
  await waitFor(client, "document.querySelector('#help-dialog').open");
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await waitFor(client, "!document.querySelector('#help-dialog').open");
  await waitFor(client, "document.activeElement.id === 'help-button'");
  await evaluate(client, "document.querySelector('#help-button').click(); document.querySelector('#help-start-button').click(); true");
  await waitFor(client, "document.querySelector('#discard-dialog').open");
  await evaluate(client, "document.querySelector('#discard-confirm').click(); true");
  await waitFor(client, "!document.querySelector('#step-upload').hidden");
  await waitFor(client, "document.activeElement.id === 'upload-title'");
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"dashboard\"]').click(); true");

  await client.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  assert.deepEqual(await evaluate(client, "({ overflow: document.documentElement.scrollWidth - window.innerWidth, steps: document.querySelectorAll('#onboarding-flow li').length, minButtonHeight: Math.min(...[...document.querySelectorAll('button:not([hidden])')].filter((button) => button.offsetParent).map((button) => button.getBoundingClientRect().height)), settingsVisible: Boolean(document.querySelector('#credentials-button').offsetParent), settingsLabel: document.querySelector('#credentials-button').getAttribute('aria-label'), helpVisible: Boolean(document.querySelector('#help-button').offsetParent) })"), { overflow: 0, steps: 3, minButtonHeight: 44, settingsVisible: true, settingsLabel: '解析设置', helpVisible: true });
  await screenshot(client, '00-dashboard-mobile.png');
  await evaluate(client, "document.querySelector('#help-button').click(); true");
  await waitFor(client, "document.querySelector('#help-dialog').open");
  assert.deepEqual(await evaluate(client, "({ overflow: document.documentElement.scrollWidth - window.innerWidth, minButtonHeight: Math.min(...[...document.querySelectorAll('#help-dialog button')].filter((button) => button.offsetParent).map((button) => button.getBoundingClientRect().height)) })"), { overflow: 0, minButtonHeight: 44 });
  await screenshot(client, '00-help-mobile.png');
  await evaluate(client, "document.querySelector('#help-close').click(); true");
  await evaluate(client, "document.querySelector('#credentials-button').click(); true");
  await waitFor(client, "document.querySelector('#credentials-dialog').open");
  assert.deepEqual(await evaluate(client, "({ overflow: document.documentElement.scrollWidth - window.innerWidth, minButtonHeight: Math.min(...[...document.querySelectorAll('#credentials-dialog button')].filter((button) => button.offsetParent).map((button) => button.getBoundingClientRect().height)) })"), { overflow: 0, minButtonHeight: 44 });
  await screenshot(client, '00-credentials-mobile.png');
  await evaluate(client, "document.querySelector('#credentials-close').click(); true");
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  await evaluate(client, "document.querySelector('#dashboard-start-button').click(); true");
  assert.deepEqual(await evaluate(client, "({ uploadVisible: !document.querySelector('#step-upload').hidden, goal: document.querySelector('#upload-step-goal').textContent.includes('先上传一份') && document.querySelector('#upload-step-goal').textContent.includes('继续追加'), currentNav: document.querySelector('.primary-nav [data-view=\"upload\"]').getAttribute('aria-current') })"), { uploadVisible: true, goal: true, currentNav: 'page' });
  await screenshot(client, '01-upload-desktop.png');

  await evaluate(client, `(() => {
    document.querySelector('#child-name').value = '林小满';
    document.querySelector('#class-name').value = '三（2）班';
    const transfer = new DataTransfer();
    for (let index = 0; index < 21; index += 1) {
      transfer.items.add(new File(['%PDF-'], '材料-' + index + '.pdf', { type: 'application/pdf' }));
    }
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#upload-form').dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitFor(client, "document.querySelector('#global-message').textContent.includes('最多纳入 20 份')");

  await evaluate(client, "window.__draftWarning = ''; window.confirm = (message) => { window.__draftWarning = message; return true; }; document.querySelector('.primary-nav [data-view=\"dashboard\"]').click(); document.querySelector('#quick-demo-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  assert.deepEqual(await evaluate(client, "({ warned: window.__draftWarning.includes('放弃'), files: document.querySelector('#notice-files').files.length })"), { warned: true, files: 0 });
  const confirm = await evaluate(client, `({
    cards: document.querySelectorAll('.change-card').length,
    date: document.querySelector('#event-preview').textContent.includes('2026-10-26'),
    trash: document.querySelector('#change-list').textContent.includes('加厚垃圾袋'),
    oldLocation: document.querySelector('#change-list').textContent.includes('学校东门'),
    fee: document.querySelector('#payment-title').textContent === '128 元活动费',
  })`);
  assert.deepEqual(confirm, { cards: 5, date: true, trash: true, oldLocation: true, fee: true });
  assert.deepEqual(await evaluate(client, "({ guide: ['新通知', '旧通知', '原文片段'].every((word) => document.querySelector('#decision-guide').textContent.includes(word)), acceptLabel: document.querySelector('.decision-row [data-decision=\"true\"]').textContent, rejectLabel: document.querySelector('.decision-row [data-decision=\"false\"]').textContent })"), {
    guide: true,
    acceptLabel: '按新通知执行',
    rejectLabel: '仍按旧通知执行',
  });
  assert.deepEqual(await evaluate(client, `({
    finalizeDisabled: document.querySelector('#finalize-button').disabled,
    decidedChanges: document.querySelectorAll('.decision-row [aria-pressed="true"]').length,
  })`), { finalizeDisabled: true, decidedChanges: 0 });
  await screenshot(client, '02-confirm-desktop.png');

  await evaluate(client, "document.querySelector('.evidence-button').click(); true");
  await waitFor(client, "document.querySelector('#evidence-dialog').open");
  assert.equal(await evaluate(client, "document.querySelector('#evidence-content').textContent.includes('原定10月23日')"), true);
  await evaluate(client, "document.querySelector('#evidence-dialog').close(); true");

  await evaluate(client, `(() => {
    document.querySelectorAll('.decision-row [data-decision="true"]').forEach((button) => button.click());
    return document.querySelector('#finalize-button').disabled;
  })()`);
  assert.equal(await evaluate(client, "document.querySelector('#finalize-button').disabled"), true);
  await evaluate(client, "document.querySelector('[name=\"submission-receipt\"][value=\"submitted\"]').click(); true");
  assert.equal(await evaluate(client, "document.querySelector('#finalize-button').disabled"), true);
  await evaluate(client, "document.querySelector('[name=\"submission-payment\"][value=\"submitted\"]').click(); true");
  assert.equal(await evaluate(client, "document.querySelector('#finalize-button').disabled"), false);
  await evaluate(client, "document.querySelector('#finalize-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-plan').hidden");
  assert.equal(await evaluate(client, "['勾选', '日历', '证据'].every((word) => document.querySelector('#result-next-actions').textContent.includes(word))"), true);
  const plan = await evaluate(client, `(() => {
    const event = document.querySelector('#final-event').textContent;
    const active = document.querySelector('.plan-group.active').textContent;
    const conditional = document.querySelector('.plan-group.conditional').textContent;
    const cancelled = document.querySelector('.plan-group.cancelled').textContent;
    return {
      finalDate: event.includes('2026-10-26'),
      newTime: event.includes('08:00'),
      newLocation: event.includes('体育馆北门'),
      noOldDate: !active.includes('10月23日'),
      noOldTime: !active.includes('07:30'),
      noOldLocation: !active.includes('学校东门'),
      hat: active.includes('蓝色帽子'),
      noTrash: !active.includes('加厚垃圾袋'),
      cancelledTrash: cancelled.includes('加厚垃圾袋'),
      condition: conditional.includes('不能参加'),
      timelineCount: document.querySelectorAll('#change-timeline .timeline-item').length,
      minButtonHeight: Math.min(...[...document.querySelectorAll('button:not([hidden])')].filter((button) => button.offsetParent).map((button) => button.getBoundingClientRect().height)),
      successToast: document.querySelector('#toast-text').textContent.includes('示例清单已生成'),
    };
  })()`);
  assert.deepEqual(plan, {
    finalDate: true,
    newTime: true,
    newLocation: true,
    noOldDate: true,
    noOldTime: true,
    noOldLocation: true,
    hat: true,
    noTrash: true,
    cancelledTrash: true,
    condition: true,
    timelineCount: 5,
    minButtonHeight: 44,
    successToast: true,
  });
  await screenshot(client, '03-plan-desktop.png');

  const persisted = await evaluate(client, "(() => { const raw = localStorage.getItem('notice-action.history.v1') || ''; const records = JSON.parse(raw || '[]'); return { historyCards: document.querySelectorAll('.history-card').length, records: records.length, demoNotice: document.querySelector('#demo-safety-note').textContent.includes('不会保存'), currentNav: document.querySelector('.primary-nav [data-view=\"plan\"]').getAttribute('aria-current') }; })()");
  assert.deepEqual(persisted, { historyCards: 0, records: 0, demoNotice: true, currentNav: 'page' });
  await evaluate(client, "document.querySelector('.plan-group.active .task-toggle').click(); true");
  assert.deepEqual(await evaluate(client, "({ activeCount: document.querySelectorAll('.plan-group.active .todo').length, doneCount: document.querySelectorAll('.plan-group.done .todo').length, completed: document.querySelector('.plan-group.done .task-toggle')?.getAttribute('aria-pressed') })"), { activeCount: 1, doneCount: 4, completed: 'true' });
  assert.equal(await evaluate(client, "JSON.parse(localStorage.getItem('notice-action.history.v1') || '[]').length"), 0);
  await evaluate(client, `(async () => {
    const demo = await fetch('/api/demo?child_name=' + encodeURIComponent('林小满') + '&participating=true').then((response) => response.json());
    const changeDecisions = Object.fromEntries(demo.analysis.changes.map(({ id }) => [id, true]));
    const submissionStates = Object.fromEntries((demo.analysis.needs_confirmation || []).map(({ kind }) => [kind, 'submitted']));
    const finalized = await fetch('/api/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysis: demo.analysis, decisions: { change_decisions: changeDecisions, submission_states: submissionStates } }),
    }).then((response) => response.json());
    const history = await import('/history.js');
    const fixturePlan = { ...finalized.plan, student: { ...finalized.plan.student, name: '周青禾', class_name: '五（1）班' } };
    let records = history.upsertPlan([], fixturePlan, '2026-10-16T12:00:00.000Z');
    records = history.setTaskCompleted(records, records[0].id, records[0].active_todos[0].id, true);
    history.persistHistory(localStorage, records);
    return true;
  })()`);

  await client.send('Page.reload', { ignoreCache: true });
  await waitFor(client, "document.readyState === 'complete'");
  await waitFor(client, "document.querySelector('#service-status')?.textContent.includes('示例模式可用')");
  await waitFor(client, "document.querySelectorAll('.history-card').length === 1");
  const restoredDashboard = await evaluate(client, "({ dashboardVisible: !document.querySelector('#view-dashboard').hidden, historyCards: document.querySelectorAll('.history-card').length, active: document.querySelector('#dashboard-active-count').textContent, changes: document.querySelector('#dashboard-change-count').textContent, documents: document.querySelector('#dashboard-document-count').textContent, history: document.querySelector('#dashboard-history-count').textContent, family: document.querySelector('#current-family').textContent, clearVisible: !document.querySelector('#clear-history-button').hidden, currentNav: document.querySelector('.primary-nav [data-view=\"dashboard\"]').getAttribute('aria-current') })");
  assert.deepEqual(restoredDashboard, {
    dashboardVisible: true,
    historyCards: 1,
    active: '1',
    changes: '5',
    documents: '4',
    history: '1',
    family: '周青禾 · 五（1）班',
    clearVisible: true,
    currentNav: 'page',
  });
  await screenshot(client, '04-dashboard-history-desktop.png');

  await evaluate(client, "document.querySelector('.history-card .text-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-plan').hidden");
  assert.deepEqual(await evaluate(client, "({ completed: document.querySelector('.plan-group.done .task-toggle')?.getAttribute('aria-pressed'), timelineCount: document.querySelectorAll('#change-timeline .timeline-item').length })"), { completed: 'true', timelineCount: 5 });
  await evaluate(client, "document.querySelector('#append-material-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-upload').hidden");
  const restoredAppend = await evaluate(client, `({
    title: document.querySelector('#upload-title').textContent,
    warnsAboutOriginal: document.querySelector('#upload-step-goal').textContent.includes('需重传 4 份历史原材料'),
    asksForAll: document.querySelector('#upload-step-goal').textContent.includes('必须重传'),
    listedOriginals: document.querySelectorAll('#file-list .is-required').length,
    name: document.querySelector('#child-name').value,
    className: document.querySelector('#class-name').value,
    identityLocked: !document.querySelector('#identity-mode-note').hidden
      && document.querySelector('#identity-mode-note').textContent.includes('沿用原清单'),
    actionLabel: document.querySelector('#analyze-button').textContent,
  })`);
  assert.deepEqual(restoredAppend, {
    title: '追加同一活动的材料',
    warnsAboutOriginal: true,
    asksForAll: true,
    listedOriginals: 4,
    name: '周青禾',
    className: '五（1）班',
    identityLocked: true,
    actionLabel: '重新比对并找出新变化',
  });
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"plan\"]').click(); true");
  await waitFor(client, "!document.querySelector('#step-plan').hidden");
  await evaluate(client, `(() => {
    window.__icsText = '';
    URL.createObjectURL = (blob) => { blob.text().then((value) => { window.__icsText = value; }); return 'blob:mock'; };
    HTMLAnchorElement.prototype.click = () => {};
    document.querySelector('#ics-button').click();
    return true;
  })()`);
  await waitFor(client, "window.__icsText.includes('BEGIN:VCALENDAR')");
  const calendar = await evaluate(client, "({ keepsPending: window.__icsText.includes('体育馆北门'), omitsCompleted: !window.__icsText.includes('准备研学个人物品'), importHint: document.querySelector('#toast-text').textContent.includes('打开文件完成导入') })");
  assert.deepEqual(calendar, { keepsPending: true, omitsCompleted: true, importHint: true });

  await evaluate(client, `(() => {
    const key = 'notice-action.history.v1';
    window.__savedHistory = localStorage.getItem(key);
    localStorage.setItem(key, '[]');
    window.dispatchEvent(new StorageEvent('storage', { key }));
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#view-dashboard').hidden");
  assert.deepEqual(await evaluate(client, "({ cards: document.querySelectorAll('.history-card').length, family: document.querySelector('#current-family').textContent })"), {
    cards: 0,
    family: '尚未选择家庭',
  });
  await evaluate(client, `(() => {
    const key = 'notice-action.history.v1';
    localStorage.setItem(key, window.__savedHistory);
    window.dispatchEvent(new StorageEvent('storage', { key }));
    return true;
  })()`);
  await waitFor(client, "document.querySelectorAll('.history-card').length === 1");
  await evaluate(client, "document.querySelector('.history-card .text-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-plan').hidden");
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"evidence\"]').click(); true");
  await waitFor(client, "!document.querySelector('#view-evidence').hidden");
  const evidenceCenter = await evaluate(client, "({ sources: document.querySelectorAll('.source-card').length, quotes: document.querySelectorAll('.source-quote').length, currentNav: document.querySelector('.primary-nav [data-view=\"evidence\"]').getAttribute('aria-current'), overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) })");
  assert.equal(evidenceCenter.sources, 4);
  assert.ok(evidenceCenter.quotes > 5);
  assert.equal(evidenceCenter.currentNav, 'page');
  assert.equal(evidenceCenter.overflow, 0);
  await screenshot(client, '05-evidence-desktop.png');
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"plan\"]').click(); true");
  await waitFor(client, "!document.querySelector('#step-plan').hidden");

  await client.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  const mobile = await evaluate(client, `({
    viewport: window.innerWidth,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    minButtonHeight: Math.min(...[...document.querySelectorAll('button:not([hidden])')].filter((button) => button.offsetParent).map((button) => button.getBoundingClientRect().height)),
    currentNav: document.querySelector('.mobile-nav [data-view="plan"]').getAttribute('aria-current'),
  })`);
  assert.deepEqual(mobile, { viewport: 360, overflow: 0, minButtonHeight: 44, currentNav: 'page' });
  await screenshot(client, '06-plan-mobile.png');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, "document.querySelector('#restart-button').click(); document.querySelector('#participating').click(); document.querySelector('#demo-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  const nonParticipantConfirm = await evaluate(client, `({
    participating: document.querySelector('#participating').checked,
    paymentHidden: document.querySelector('#payment-confirmation').hidden,
    receiptVisible: !document.querySelector('#receipt-confirmation').hidden,
  })`);
  assert.deepEqual(nonParticipantConfirm, { participating: false, paymentHidden: true, receiptVisible: true });
  await evaluate(client, `(() => {
    document.querySelectorAll('.decision-row [data-decision="true"]').forEach((button) => button.click());
    document.querySelector('[name="submission-receipt"][value="submitted"]').click();
    document.querySelector('#finalize-button').click();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#step-plan').hidden");
  const nonParticipant = await evaluate(client, `(() => {
    const active = document.querySelector('.plan-group.active').textContent;
    const conditional = document.querySelector('.plan-group.conditional').textContent;
    return {
      contactTeacher: active.includes('联系班主任'),
      noPreparation: !active.includes('准备研学个人物品'),
      noAttendance: !active.includes('集合'),
      noPayment: !active.includes('缴纳活动费'),
      noConditional: conditional.includes('没有条件待办'),
    };
  })()`);
  assert.deepEqual(nonParticipant, { contactTeacher: true, noPreparation: true, noAttendance: true, noPayment: true, noConditional: true });
  assert.equal(await evaluate(client, "JSON.parse(localStorage.getItem('notice-action.history.v1') || '[]').length"), 1);
  await evaluate(client, "document.querySelector('#restart-button').click(); document.querySelector('#demo-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  await evaluate(client, `(() => {
    document.querySelectorAll('.decision-row [data-decision="true"]').forEach((button) => button.click());
    document.querySelector('[name="submission-receipt"][value="submitted"]').click();
    document.querySelector('[name="submission-payment"][value="submitted"]').click();
    const originalFetch = window.fetch;
    window.__historyBeforeRace = localStorage.getItem('notice-action.history.v1');
    window.__raceStarted = false;
    window.__raceAborted = false;
    window.__raceFinished = false;
    window.__restoreFetch = () => { window.fetch = originalFetch; };
    window.fetch = (url, options) => {
      if (String(url) !== '/api/finalize') return originalFetch(url, options);
      window.__raceStarted = true;
      return new Promise((resolve, reject) => {
        window.__releaseFinalize = () => originalFetch(url, { ...options, signal: undefined }).then(
          (response) => { window.__raceFinished = true; resolve(response); },
          (error) => { window.__raceFinished = true; reject(error); },
        );
        options?.signal?.addEventListener('abort', () => {
          window.__raceAborted = true;
        }, { once: true });
      });
    };
    document.querySelector('#finalize-button').click();
    return true;
  })()`);
  await waitFor(client, "window.__raceStarted");
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"dashboard\"]').click(); true");
  await waitFor(client, "!document.querySelector('#view-dashboard').hidden");
  assert.equal(await evaluate(client, "window.__raceAborted"), true);
  await evaluate(client, "window.__releaseFinalize(); true");
  await waitFor(client, "window.__raceFinished");
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"confirm\"]').click(); true");
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  assert.equal(await evaluate(client, "document.querySelector('#finalize-button').disabled"), false);
  assert.deepEqual(await evaluate(client, "({ aborted: window.__raceAborted, historyUntouched: localStorage.getItem('notice-action.history.v1') === window.__historyBeforeRace, quiet: !document.querySelector('#global-message').textContent.includes('Aborted') })"), {
    aborted: true,
    historyUntouched: true,
    quiet: true,
  });
  await evaluate(client, "window.__raceStarted = false; window.__raceAborted = false; window.__raceFinished = false; document.querySelector('#finalize-button').click(); true");
  await waitFor(client, "window.__raceStarted");
  assert.equal(await evaluate(client, "window.confirm = () => true; document.querySelector('#help-button').click(); document.querySelector('#help-demo-button').click(); window.__raceAborted"), true);
  await evaluate(client, "window.__releaseFinalize(); true");
  await waitFor(client, "window.__raceFinished");
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  assert.deepEqual(await evaluate(client, "({ historyUntouched: localStorage.getItem('notice-action.history.v1') === window.__historyBeforeRace, quiet: !document.querySelector('#global-message').textContent.includes('Aborted') })"), {
    historyUntouched: true,
    quiet: true,
  });
  await evaluate(client, "window.__restoreFetch(); true");
  await evaluate(client, `(async () => {
    const history = await import('/history.js');
    const records = history.loadHistory(localStorage);
    const second = { ...records[0], student: { ...records[0].student, name: '吴初夏' } };
    const nextSavedAt = new Date(Date.parse(records[0].saved_at) + 1_000).toISOString();
    history.persistHistory(localStorage, history.upsertPlan(records, second, nextSavedAt));
    window.dispatchEvent(new StorageEvent('storage', { key: history.HISTORY_KEY }));
    return true;
  })()`);
  await waitFor(client, "document.querySelectorAll('.history-card').length === 2");
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"dashboard\"]').click(); true");
  await waitFor(client, "!document.querySelector('#view-dashboard').hidden");
  await evaluate(client, "window.confirm = () => true; document.querySelector('.history-card .delete-button').click(); true");
  await waitFor(client, "document.querySelectorAll('.history-card').length === 1");
  assert.deepEqual(await evaluate(client, "({ cards: document.querySelectorAll('.history-card').length, family: document.querySelector('#current-family').textContent })"), {
    cards: 1,
    family: '周青禾 · 五（1）班',
  });
  await evaluate(client, "document.querySelector('#clear-history-button').click(); true");
  await waitFor(client, "document.querySelectorAll('.history-card').length === 0");
  const deletedHistory = await evaluate(client, "({ cards: document.querySelectorAll('.history-card').length, empty: !document.querySelector('#dashboard-empty').hidden, clearHidden: document.querySelector('#clear-history-button').hidden, stored: JSON.parse(localStorage.getItem('notice-action.history.v1') || '[]').length, family: document.querySelector('#current-family').textContent })");
  assert.deepEqual(deletedHistory, { cards: 0, empty: true, clearHidden: true, stored: 0, family: '尚未选择家庭' });

  await evaluate(client, `(() => {
    document.querySelector('#credentials-button').click();
    document.querySelector('#credentials-app-id').value = 'incremental-test-app';
    document.querySelector('#credentials-secret-code').value = 'incremental-test-secret';
    document.querySelector('#credentials-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#credentials-dialog').open && document.querySelector('#service-status').textContent.includes('在线解析已就绪')");
  await evaluate(client, "document.querySelector('#new-notice-button').click(); window.__mockIncrementalUpload = true; true");
  await evaluate(client, `(() => {
    const first = new DataTransfer();
    first.items.add(new File(['%PDF-1.7'], '先选的基础通知.pdf', { type: 'application/pdf', lastModified: 1 }));
    const second = new DataTransfer();
    second.items.add(new File(['%PDF-1.7 update'], '后选的补充说明.pdf', { type: 'application/pdf', lastModified: 2 }));
    const input = document.querySelector('#notice-files');
    input.files = first.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.files = second.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.deepEqual(await evaluate(client, "({ count: document.querySelectorAll('#file-list li').length, label: document.querySelector('#selected-file-count').textContent })"), {
    count: 2,
    label: '2 份待解析',
  });
  await evaluate(client, "document.querySelector('#file-list .file-remove').click(); true");
  assert.deepEqual(await evaluate(client, `({
    count: document.querySelectorAll('#file-list li').length,
    label: document.querySelector('#selected-file-count').textContent,
    remaining: document.querySelector('#file-list .file-name b').textContent,
    removeLabel: document.querySelector('#file-list .file-remove').getAttribute('aria-label'),
    removeHeight: Math.round(document.querySelector('#file-list .file-remove').getBoundingClientRect().height),
  })`), {
    count: 1,
    label: '1 份待解析',
    remaining: '后选的补充说明.pdf',
    removeLabel: '移除后选的补充说明.pdf',
    removeHeight: 44,
  });

  await evaluate(client, "document.querySelector('#new-notice-button').click(); true");
  await waitFor(client, "document.querySelector('#discard-dialog').open");
  await screenshot(client, '01b-discard-dialog-desktop.png');
  assert.deepEqual(await evaluate(client, `({
    title: document.querySelector('#discard-title').textContent,
    keepsDraft: document.querySelectorAll('#file-list li').length,
    cancelFocused: document.activeElement.id === 'discard-cancel',
    minButtonHeight: Math.min(...[...document.querySelectorAll('#discard-dialog button')].map((button) => button.getBoundingClientRect().height)),
  })`), {
    title: '要开始新的整理吗？',
    keepsDraft: 1,
    cancelFocused: true,
    minButtonHeight: 44,
  });
  await evaluate(client, "document.querySelector('#discard-cancel').click(); true");
  await waitFor(client, "!document.querySelector('#discard-dialog').open && document.activeElement.id === 'new-notice-button'");
  assert.equal(await evaluate(client, "document.querySelectorAll('#file-list li').length"), 1);
  await evaluate(client, "document.querySelector('#new-notice-button').click(); true");
  await waitFor(client, "document.querySelector('#discard-dialog').open");
  await evaluate(client, "document.querySelector('#discard-confirm').click(); true");
  await waitFor(client, "!document.querySelector('#discard-dialog').open && document.querySelectorAll('#file-list li').length === 0");

  await evaluate(client, `(() => {
    document.querySelector('#child-name').value = '林小满';
    document.querySelector('#class-name').value = '三（2）班';
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7 base'], '基础通知.pdf', { type: 'application/pdf', lastModified: 3 }));
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#upload-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  assert.equal(await evaluate(client, "window.__incrementalParseCalls"), 1);
  await evaluate(client, `(() => {
    document.querySelector('#back-button').click();
    const className = document.querySelector('#class-name');
    className.value = '三（3）班';
    className.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const invalidatedIdentity = await evaluate(client, `({
    confirmDisabled: document.querySelector('.primary-nav [data-view="confirm"]').disabled,
    finalizeDisabled: document.querySelector('#finalize-button').disabled,
    changeCountHidden: document.querySelector('#nav-change-count').hidden,
  })`);
  assert.deepEqual(invalidatedIdentity, { confirmDisabled: true, finalizeDisabled: true, changeCountHidden: true });
  await evaluate(client, "document.querySelector('#upload-form').requestSubmit(); true");
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  assert.deepEqual(await evaluate(client, `({
    parseCalls: window.__incrementalParseCalls,
    className: window.__incrementalMergePayloads.at(-1).context.student.class_name,
  })`), { parseCalls: 1, className: '三（3）班' });
  await evaluate(client, `(() => {
    document.querySelector('#back-button').click();
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7 extra'], '刚补充的通知.pdf', { type: 'application/pdf', lastModified: 31 }));
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const invalidatedDraft = await evaluate(client, `({
    confirmDisabled: document.querySelector('.primary-nav [data-view="confirm"]').disabled,
    finalizeDisabled: document.querySelector('#finalize-button').disabled,
    changeCountHidden: document.querySelector('#nav-change-count').hidden,
  })`);
  assert.deepEqual(invalidatedDraft, { confirmDisabled: true, finalizeDisabled: true, changeCountHidden: true });
  await evaluate(client, "document.querySelector('#new-notice-button').click(); true");
  await waitFor(client, "document.querySelector('#discard-dialog').open");
  await evaluate(client, "document.querySelector('#discard-confirm').click(); true");
  await waitFor(client, "!document.querySelector('#discard-dialog').open && document.querySelectorAll('#file-list li').length === 0");
  await evaluate(client, `(() => {
    document.querySelector('#child-name').value = '林小满';
    document.querySelector('#class-name').value = '三（2）班';
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7 base'], '基础通知.pdf', { type: 'application/pdf', lastModified: 3 }));
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#upload-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  await evaluate(client, `(() => {
    document.querySelectorAll('.decision-row [data-decision="true"]').forEach((button) => button.click());
    document.querySelector('[name="submission-receipt"][value="not_submitted"]').click();
    document.querySelector('[name="submission-payment"][value="not_submitted"]').click();
    document.querySelector('#finalize-button').click();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#step-plan').hidden");
  assert.equal(await evaluate(client, "Boolean(document.querySelector('#append-material-button'))"), true);
  await evaluate(client, `(() => {
    const titles = ['提交电子回执', '缴纳活动费', '准备研学个人物品'];
    document.querySelectorAll('.plan-group.active .todo').forEach((todo) => {
      if (titles.some((title) => todo.querySelector('b').textContent.includes(title))) {
        todo.querySelector('.task-toggle').click();
      }
    });
    return true;
  })()`);
  await evaluate(client, "document.querySelector('#append-material-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-upload').hidden");
  assert.deepEqual(await evaluate(client, `({
    title: document.querySelector('#upload-title').textContent,
    guidance: document.querySelector('#upload-step-goal').textContent,
    name: document.querySelector('#child-name').value,
    className: document.querySelector('#class-name').value,
  })`), {
    title: '追加同一活动的材料',
    guidance: '1已纳入 1 份材料这次只选择新增或修改后的通知，系统会和已解析材料重新比对。',
    name: '林小满',
    className: '三（2）班',
  });
  await evaluate(client, `(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7 change'], '改期通知.pdf', { type: 'application/pdf', lastModified: 4 }));
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#upload-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  const incrementalUpload = await evaluate(client, `({
    parseCalls: window.__incrementalParseCalls,
    mergeCalls: window.__incrementalMergePayloads.length,
    mergedDocuments: window.__incrementalMergePayloads.at(-1).documents.map((document) => document.name),
    currentEvent: window.__incrementalMergePayloads.at(-1).context.current_event,
    completedActions: window.__incrementalMergePayloads.at(-1).context.completed_actions.map((action) => action.kind),
    visibleChanges: document.querySelectorAll('#change-list .change-card').length,
    summary: document.querySelector('#change-summary-pill').textContent,
  })`);
  assert.deepEqual(incrementalUpload, {
    parseCalls: 3,
    mergeCalls: 4,
    mergedDocuments: ['基础通知.pdf', '改期通知.pdf'],
    currentEvent: { date: '2026-10-26', meet_time: '08:00', meet_location: '体育馆北门' },
    completedActions: ['receipt', 'payment'],
    visibleChanges: 1,
    summary: '1 项变化',
  });
  await evaluate(client, `(async () => {
    const history = await import('/history.js');
    const records = history.loadHistory(localStorage);
    const unrelated = { ...records[0], student: { ...records[0].student, name: '旁路记录' } };
    const older = new Date(Date.parse(records[0].saved_at) - 1_000).toISOString();
    history.persistHistory(localStorage, history.upsertPlan(records, unrelated, older));
    return true;
  })()`);
  await evaluate(client, `(() => {
    document.querySelectorAll('.decision-row [data-decision="true"]').forEach((button) => button.click());
    document.querySelector('[name="submission-receipt"][value="submitted"]')?.click();
    document.querySelector('[name="submission-payment"][value="submitted"]')?.click();
    document.querySelector('#finalize-button').click();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#step-plan').hidden");
  assert.deepEqual(await evaluate(client, `({
    completedTaskPreserved: Boolean(document.querySelector('.plan-group.done .task-toggle[aria-pressed="true"]')),
    historyRecords: JSON.parse(localStorage.getItem('notice-action.history.v1') || '[]').length,
    materialCount: JSON.parse(localStorage.getItem('notice-action.history.v1') || '[]')[0].documents.length,
    timelineCount: document.querySelectorAll('#change-timeline .timeline-item').length,
    keepsLocationHistory: ['学校东门', '体育馆北门', '图书馆门口'].every((place) => document.querySelector('#change-timeline').textContent.includes(place)),
    allChangesAccepted: Object.values(window.__incrementalFinalizePayloads.at(-1).decisions.change_decisions).length === 5
      && Object.values(window.__incrementalFinalizePayloads.at(-1).decisions.change_decisions).every(Boolean),
  })`), {
    completedTaskPreserved: true,
    historyRecords: 2,
    materialCount: 2,
    timelineCount: 6,
    keepsLocationHistory: true,
    allChangesAccepted: true,
  });
  await client.send('Page.reload', { ignoreCache: true });
  await waitFor(client, "document.querySelectorAll('.history-card').length === 2");
  await evaluate(client, `(() => {
    window.__mockIncrementalUpload = true;
    document.querySelector('#credentials-button').click();
    document.querySelector('#credentials-app-id').value = 'incremental-test-app';
    document.querySelector('#credentials-secret-code').value = 'incremental-test-secret';
    document.querySelector('#credentials-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#credentials-dialog').open && document.querySelector('#service-status').textContent.includes('在线解析已就绪')");
  await evaluate(client, "document.querySelector('.history-card .text-button').click(); document.querySelector('#append-material-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-upload').hidden");
  assert.deepEqual(await evaluate(client, `({
    requiredCount: document.querySelectorAll('#file-list .is-required').length,
    requiredNames: Array.from(document.querySelectorAll('#file-list .is-required b')).map((node) => node.textContent),
  })`), {
    requiredCount: 2,
    requiredNames: ['基础通知.pdf', '改期通知.pdf'],
  });
  await evaluate(client, `(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7 third'], '再次改期.pdf', { type: 'application/pdf', lastModified: 5 }));
    transfer.items.add(new File(['not the original'], '基础通知.pdf', { type: 'application/pdf', lastModified: 30 }));
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#upload-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "document.querySelector('#global-message').textContent.includes('基础通知.pdf') && document.querySelector('#global-message').textContent.includes('改期通知.pdf')");
  assert.equal(await evaluate(client, "window.__incrementalMergePayloads.length"), 0);
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"plan\"]').click(); document.querySelector('#append-material-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-upload').hidden");
  await evaluate(client, `(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7 third'], '再次改期.pdf', { type: 'application/pdf', lastModified: 5 }));
    transfer.items.add(new File(['%PDF-1.7 base'], '基础通知.pdf', { type: 'application/pdf', lastModified: 3 }));
    transfer.items.add(new File(['%PDF-1.7 change'], '改期通知.pdf', { type: 'application/pdf', lastModified: 4 }));
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#upload-form').requestSubmit();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  const fallbackAppend = await evaluate(client, `({
    mergeCalls: window.__incrementalMergePayloads.length,
    mergedDocuments: window.__incrementalMergePayloads.at(-1).documents.map(({ name }) => name),
  })`);
  assert.deepEqual(fallbackAppend, {
    mergeCalls: 1,
    mergedDocuments: ['再次改期.pdf', '基础通知.pdf', '改期通知.pdf'],
  });
  await evaluate(client, `(async () => {
    document.querySelectorAll('.decision-row [data-decision="true"]').forEach((button) => button.click());
    document.querySelector('[name="submission-receipt"][value="submitted"]')?.click();
    document.querySelector('[name="submission-payment"][value="submitted"]')?.click();
    const records = JSON.parse(localStorage.getItem('notice-action.history.v1'));
    records[0] = { ...records[0], saved_at: new Date(Date.parse(records[0].saved_at) + 60_000).toISOString() };
    localStorage.setItem('notice-action.history.v1', JSON.stringify(records));
    document.querySelector('#finalize-button').click();
    return true;
  })()`);
  await waitFor(client, "document.querySelector('#global-message').textContent.includes('另一个窗口更新')");
  assert.equal(await evaluate(client, "window.__incrementalFinalizePayloads.length"), 0);
  await evaluate(client, "window.__mockIncrementalUpload = false; document.querySelector('.primary-nav [data-view=\"dashboard\"]').click(); window.confirm = () => true; document.querySelector('#clear-history-button').click(); true");
  await waitFor(client, "document.querySelectorAll('.history-card').length === 0");

  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__parseStarted = false;
    window.__parseAborted = false;
    window.__mergeCalls = 0;
    window.fetch = (url, options = {}) => {
      const value = String(url);
      if (value === '/api/health') {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, live_parse_configured: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (value.startsWith('/api/parse')) {
        window.__parseStarted = true;
        return new Promise((resolve, reject) => {
          window.__releaseParse = () => {
            resolve(new Response(JSON.stringify({ ok: true, document: {} }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
            setTimeout(() => { window.__parseSettled = true; }, 0);
          };
          options.signal?.addEventListener('abort', () => {
            window.__parseAborted = true;
          }, { once: true });
        });
      }
      if (value === '/api/merge') window.__mergeCalls += 1;
      return nativeFetch(url, options);
    };
  })();` });
  await client.send('Page.reload', { ignoreCache: true });
  await waitFor(client, "document.querySelector('#service-status')?.textContent.includes('在线解析已就绪')");
  assert.deepEqual(await evaluate(client, "({ analyzeEnabled: !document.querySelector('#analyze-button').disabled, noteHidden: document.querySelector('#live-mode-note').hidden })"), { analyzeEnabled: true, noteHidden: true });
  await evaluate(client, `(() => {
    document.querySelector('#dashboard-start-button').click();
    document.querySelector('#child-name').value = '真实草稿';
    document.querySelector('#class-name').value = '一（1）班';
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7'], '待解析通知.pdf', { type: 'application/pdf' }));
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#analyze-button').click();
    return true;
  })()`);
  await waitFor(client, "window.__parseStarted");
  await evaluate(client, `(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7 late'], '解析中误加的通知.pdf', { type: 'application/pdf' }));
    const input = document.querySelector('#notice-files');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.deepEqual(await evaluate(client, "({ disabled: document.querySelector('#notice-files').disabled, identityDisabled: ['#child-name', '#class-name', '#participating'].every((selector) => document.querySelector(selector).disabled), queued: document.querySelectorAll('#file-list li').length })"), {
    disabled: true,
    identityDisabled: true,
    queued: 1,
  });
  assert.equal(await evaluate(client, "document.querySelector('#analyze-button').textContent"), '正在解析 1/1：待解析通知.pdf');
  await evaluate(client, "window.confirm = () => true; document.querySelector('#help-button').click(); document.querySelector('#help-demo-button').click(); true");
  await waitFor(client, "window.__parseAborted");
  await evaluate(client, "window.__releaseParse(); true");
  await waitFor(client, "window.__parseSettled");
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  const parseRace = await evaluate(client, "({ aborted: window.__parseAborted, mergeCalls: window.__mergeCalls, files: document.querySelector('#notice-files').files.length, demoIdentity: document.querySelector('#current-family').textContent, quiet: !document.querySelector('#global-message').textContent.includes('Aborted') })");
  assert.deepEqual(parseRace, { aborted: true, mergeCalls: 0, files: 0, demoIdentity: '林小满 · 三（2）班', quiet: true });

  await evaluate(client, "document.querySelector('#credentials-button').click(); true");
  await waitFor(client, "document.querySelector('#credentials-dialog').open");
  const legacyHealth = await evaluate(client, "({ saveDisabled: document.querySelector('#credentials-save').disabled, guidance: document.querySelector('#credentials-status').textContent.includes('后台服务版本过旧') })");
  assert.deepEqual(legacyHealth, { saveDisabled: true, guidance: true });
  await evaluate(client, "document.querySelector('#credentials-close').click(); true");

  console.log(JSON.stringify({ ok: true, emptyDashboard, confirm, plan, persisted, restoredDashboard, restoredAppend, calendar, evidenceCenter, mobile, nonParticipant, deletedHistory, invalidatedIdentity, invalidatedDraft, incrementalUpload, fallbackAppend, parseRace, legacyHealth }, null, 2));
} finally {
  client?.close();
  chrome.kill();
  await new Promise((accept) => chrome.once('exit', accept));
  const safeTempRoot = resolve(tmpdir());
  assert.ok(resolve(profile).startsWith(safeTempRoot));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
