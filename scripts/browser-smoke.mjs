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
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(origin)}`, { method: 'PUT' }).then((response) => response.json());
  client = cdpClient(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(client, "document.readyState === 'complete'");
  await waitFor(client, "document.querySelector('#service-status')?.textContent.includes('示例模式可用')");
  const emptyDashboard = await evaluate(client, "({ visible: !document.querySelector('#view-dashboard').hidden, empty: !document.querySelector('#dashboard-empty').hidden, onboardingSteps: document.querySelectorAll('#onboarding-flow li').length, materialsReady: ['学校通知', '分组表', '群聊截图'].every((word) => document.querySelector('#onboarding-materials').textContent.includes(word)), quickDemoVisible: Boolean(document.querySelector('#quick-demo-button').offsetParent), demoSafe: document.querySelector('#demo-safety-note').textContent.includes('不会保存'), dashboardDataHidden: document.querySelector('#dashboard-content').hidden, family: document.querySelector('#current-family').textContent, helpVisible: Boolean(document.querySelector('#help-button').offsetParent), currentNav: document.querySelector('.primary-nav [data-view=\"dashboard\"]').getAttribute('aria-current'), overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth), analyzeDisabled: document.querySelector('#analyze-button').disabled, liveModeNote: !document.querySelector('#live-mode-note').hidden })");
  assert.deepEqual(emptyDashboard, {
    visible: true,
    empty: true,
    onboardingSteps: 3,
    materialsReady: true,
    quickDemoVisible: true,
    demoSafe: true,
    dashboardDataHidden: true,
    family: '尚未选择家庭',
    helpVisible: true,
    currentNav: 'page',
    overflow: 0,
    analyzeDisabled: true,
    liveModeNote: true,
  });
  await screenshot(client, '00-dashboard-empty-desktop.png');

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
  await waitFor(client, "!document.querySelector('#step-upload').hidden");
  await waitFor(client, "document.activeElement.id === 'upload-title'");
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"dashboard\"]').click(); true");

  await client.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  assert.deepEqual(await evaluate(client, "({ overflow: document.documentElement.scrollWidth - window.innerWidth, steps: document.querySelectorAll('#onboarding-flow li').length, minButtonHeight: Math.min(...[...document.querySelectorAll('button:not([hidden])')].filter((button) => button.offsetParent).map((button) => button.getBoundingClientRect().height)), helpVisible: Boolean(document.querySelector('#help-button').offsetParent) })"), { overflow: 0, steps: 3, minButtonHeight: 44, helpVisible: true });
  await screenshot(client, '00-dashboard-mobile.png');
  await evaluate(client, "document.querySelector('#help-button').click(); true");
  await waitFor(client, "document.querySelector('#help-dialog').open");
  assert.deepEqual(await evaluate(client, "({ overflow: document.documentElement.scrollWidth - window.innerWidth, minButtonHeight: Math.min(...[...document.querySelectorAll('#help-dialog button')].filter((button) => button.offsetParent).map((button) => button.getBoundingClientRect().height)) })"), { overflow: 0, minButtonHeight: 44 });
  await screenshot(client, '00-help-mobile.png');
  await evaluate(client, "document.querySelector('#help-close').click(); true");
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  await evaluate(client, "document.querySelector('#dashboard-start-button').click(); true");
  assert.deepEqual(await evaluate(client, "({ uploadVisible: !document.querySelector('#step-upload').hidden, goal: document.querySelector('#upload-step-goal').textContent.includes('同一场活动') && document.querySelector('#upload-step-goal').textContent.includes('全部版本'), currentNav: document.querySelector('.primary-nav [data-view=\"upload\"]').getAttribute('aria-current') })"), { uploadVisible: true, goal: true, currentNav: 'page' });
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
  await waitFor(client, "document.querySelector('#global-message').textContent.includes('最多选择 20 份')");

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
  await evaluate(client, `(() => {
    window.__icsText = '';
    URL.createObjectURL = (blob) => { blob.text().then((value) => { window.__icsText = value; }); return 'blob:mock'; };
    HTMLAnchorElement.prototype.click = () => {};
    document.querySelector('#ics-button').click();
    return true;
  })()`);
  await waitFor(client, "window.__icsText.includes('BEGIN:VCALENDAR')");
  const calendar = await evaluate(client, "({ keepsPending: window.__icsText.includes('体育馆北门'), omitsCompleted: !window.__icsText.includes('准备研学个人物品'), importHint: document.querySelector('#global-message').textContent.includes('打开文件完成导入') })");
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
  await evaluate(client, "document.querySelector('#back-button').click(); true");
  await waitFor(client, "!document.querySelector('#step-upload').hidden");
  await evaluate(client, "window.__releaseFinalize(); true");
  await waitFor(client, "window.__raceFinished");
  assert.deepEqual(await evaluate(client, "({ aborted: window.__raceAborted, historyUntouched: localStorage.getItem('notice-action.history.v1') === window.__historyBeforeRace, quiet: !document.querySelector('#global-message').textContent.includes('Aborted') })"), {
    aborted: true,
    historyUntouched: true,
    quiet: true,
  });
  await evaluate(client, "window.__restoreFetch(); true");
  await evaluate(client, `(async () => {
    const history = await import('/history.js');
    const records = history.loadHistory(localStorage);
    const second = { ...records[0], student: { ...records[0].student, name: '吴初夏' } };
    history.persistHistory(localStorage, history.upsertPlan(records, second, '2026-10-17T12:00:00.000Z'));
    window.dispatchEvent(new StorageEvent('storage', { key: history.HISTORY_KEY }));
    return true;
  })()`);
  await waitFor(client, "document.querySelectorAll('.history-card').length === 2");
  await evaluate(client, "document.querySelector('.primary-nav [data-view=\"dashboard\"]').click(); true");
  await waitFor(client, "!document.querySelector('#view-dashboard').hidden");
  await evaluate(client, "window.confirm = () => true; document.querySelector('.history-card .delete-button').click(); true");
  assert.deepEqual(await evaluate(client, "({ cards: document.querySelectorAll('.history-card').length, family: document.querySelector('#current-family').textContent })"), {
    cards: 1,
    family: '周青禾 · 五（1）班',
  });
  await evaluate(client, "document.querySelector('#clear-history-button').click(); true");
  const deletedHistory = await evaluate(client, "({ cards: document.querySelectorAll('.history-card').length, empty: !document.querySelector('#dashboard-empty').hidden, clearHidden: document.querySelector('#clear-history-button').hidden, stored: JSON.parse(localStorage.getItem('notice-action.history.v1') || '[]').length, family: document.querySelector('#current-family').textContent })");
  assert.deepEqual(deletedHistory, { cards: 0, empty: true, clearHidden: true, stored: 0, family: '尚未选择家庭' });

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
  await evaluate(client, "window.confirm = () => true; document.querySelector('#help-button').click(); document.querySelector('#help-demo-button').click(); true");
  await waitFor(client, "window.__parseAborted");
  await evaluate(client, "window.__releaseParse(); true");
  await waitFor(client, "window.__parseSettled");
  await waitFor(client, "!document.querySelector('#step-confirm').hidden");
  const parseRace = await evaluate(client, "({ aborted: window.__parseAborted, mergeCalls: window.__mergeCalls, files: document.querySelector('#notice-files').files.length, demoIdentity: document.querySelector('#current-family').textContent, quiet: !document.querySelector('#global-message').textContent.includes('Aborted') })");
  assert.deepEqual(parseRace, { aborted: true, mergeCalls: 0, files: 0, demoIdentity: '林小满 · 三（2）班', quiet: true });

  console.log(JSON.stringify({ ok: true, emptyDashboard, confirm, plan, persisted, restoredDashboard, calendar, evidenceCenter, mobile, nonParticipant, deletedHistory, parseRace }, null, 2));
} finally {
  client?.close();
  chrome.kill();
  await new Promise((accept) => chrome.once('exit', accept));
  const safeTempRoot = resolve(tmpdir());
  assert.ok(resolve(profile).startsWith(safeTempRoot));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
