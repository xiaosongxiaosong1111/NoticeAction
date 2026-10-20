import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { createAppServer } from '../server.mjs';
import { XParseError } from '../src/xparse-client.mjs';

const documents = JSON.parse(await readFile(new URL('./fixtures/parsed-documents.json', import.meta.url), 'utf8'));

async function withServer(options, run) {
  const server = createAppServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function statusWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
}

test('serves health and the competition demo without credentials', async () => {
  await withServer({ demoDocuments: documents, env: {} }, async (origin) => {
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.service_id, 'notice-action-local-v1');
    assert.equal(health.credential_management_version, 1);
    assert.equal(health.live_parse_configured, false);
    const demoResponse = await fetch(`${origin}/api/demo?child_name=${encodeURIComponent('林小满')}`);
    const demo = await demoResponse.json();
    assert.equal(demoResponse.status, 200);
    assert.equal(demo.ok, true);
    assert.equal(demo.analysis.event.date, '2026-10-26');
    assert.equal(demo.analysis.student.group, '第3组');
    assert.ok(!JSON.stringify(demo).includes('page_image_url'));

    const nonParticipant = await fetch(`${origin}/api/demo?child_name=${encodeURIComponent('林小满')}&participating=false`).then((response) => response.json());
    assert.equal(nonParticipant.analysis.student.participating, false);
    assert.deepEqual(nonParticipant.analysis.needs_confirmation.map((item) => item.kind), ['receipt']);
  });
});

test('saves, uses, and clears encrypted browser credentials without echoing them', async () => {
  let saved = null;
  let received = null;
  const credentialStore = {
    save: async (credentials) => { saved = { ...credentials }; },
    clear: async () => { saved = null; },
  };
  const xparseClient = async ({ name }, credentials) => {
    received = { ...credentials };
    return { ...documents[0], name };
  };

  await withServer({ demoDocuments: documents, env: {}, credentialStore, xparseClient }, async (origin) => {
    const saveResponse = await fetch(`${origin}/api/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: 'browser-app-id', secret_code: 'browser-secret-code' }),
    });
    const saveText = await saveResponse.text();
    assert.equal(saveResponse.status, 200);
    assert.ok(!saveText.includes('browser-app-id'));
    assert.ok(!saveText.includes('browser-secret-code'));
    assert.deepEqual(saved, { appId: 'browser-app-id', secretCode: 'browser-secret-code' });

    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.equal(health.live_parse_configured, true);
    assert.equal(health.credentials_saved, true);
    assert.ok(!JSON.stringify(health).includes('browser-secret-code'));

    const parsed = await fetch(`${origin}/api/parse?filename=notice.pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: new TextEncoder().encode('%PDF-1.7'),
    });
    assert.equal(parsed.status, 200);
    assert.deepEqual(received, { appId: 'browser-app-id', secretCode: 'browser-secret-code' });

    const clearResponse = await fetch(`${origin}/api/credentials/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const clearText = await clearResponse.text();
    assert.equal(clearResponse.status, 200);
    assert.ok(!clearText.includes('browser-secret-code'));
    assert.equal(saved, null);
    assert.equal((await fetch(`${origin}/api/health`).then((response) => response.json())).live_parse_configured, false);
    assert.equal((await fetch(`${origin}/api/parse?filename=notice.pdf`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new TextEncoder().encode('%PDF-1.7'),
    })).status, 503);
  });
});

test('returns a safe machine-readable code for invalid TextIn credentials', async () => {
  const xparseClient = async () => {
    throw new XParseError('请重新配置凭据', {
      statusCode: 401,
      code: 'TEXTIN_CREDENTIALS_INVALID',
    });
  };

  await withServer({
    demoDocuments: documents,
    env: { TEXTIN_APP_ID: 'app', TEXTIN_SECRET_CODE: 'secret' },
    xparseClient,
  }, async (origin) => {
    const response = await fetch(`${origin}/api/parse?filename=notice.pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: new TextEncoder().encode('%PDF-1.7'),
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.deepEqual(body, {
      ok: false,
      error: {
        code: 'TEXTIN_CREDENTIALS_INVALID',
        message: '请重新配置凭据',
      },
    });
  });
});

test('serializes credential changes so a later clear wins over an earlier slow save', async () => {
  let releaseSave;
  let markSaveStarted;
  let stored = null;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise((resolve) => { markSaveStarted = resolve; });
  const credentialStore = {
    save: async (credentials) => {
      markSaveStarted();
      await saveGate;
      stored = { ...credentials };
    },
    clear: async () => { stored = null; },
  };

  await withServer({ demoDocuments: documents, env: {}, credentialStore }, async (origin) => {
    const saveRequest = fetch(`${origin}/api/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: 'slow-app', secret_code: 'slow-secret' }),
    });
    await saveStarted;

    const clearRequest = fetch(`${origin}/api/credentials/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    setTimeout(releaseSave, 100);

    const [saveResponse, clearResponse] = await Promise.all([saveRequest, clearRequest]);
    assert.equal(saveResponse.status, 200);
    assert.equal(clearResponse.status, 200);
    assert.equal(stored, null);
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.equal(health.live_parse_configured, false);
    assert.equal(health.credentials_saved, false);
  });
});

test('rejects unsafe credential configuration without calling the store', async () => {
  let saves = 0;
  let clears = 0;
  const credentialStore = {
    save: async () => { saves += 1; },
    clear: async () => { clears += 1; },
  };
  await withServer({ demoDocuments: documents, env: {}, credentialStore }, async (origin) => {
    const invalidPayloads = [
      {},
      { app_id: '', secret_code: 'secret' },
      { app_id: 'app', secret_code: '   ' },
      { app_id: 'app\r\nInjected', secret_code: 'secret' },
      { app_id: 'a'.repeat(257), secret_code: 'secret' },
      { app_id: 'app', secret_code: 's'.repeat(513) },
    ];
    for (const payload of invalidPayloads) {
      const response = await fetch(`${origin}/api/credentials`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 422);
    }

    const simple = await fetch(`${origin}/api/credentials`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    });
    assert.equal(simple.status, 415);
    const crossSite = await fetch(`${origin}/api/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ app_id: 'app', secret_code: 'secret' }),
    });
    assert.equal(crossSite.status, 403);

    const oversized = await fetch(`${origin}/api/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: 'app', secret_code: 's'.repeat(5_000) }),
    });
    assert.equal(oversized.status, 413);

    const invalidClear = await fetch(`${origin}/api/credentials/clear`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"unexpected":true}',
    });
    assert.equal(invalidClear.status, 422);
    assert.equal(saves, 0);
    assert.equal(clears, 0);
  });
});

test('keeps existing runtime credentials when encrypted storage fails', async () => {
  let received = null;
  const credentialStore = {
    save: async () => { throw new Error('disk path and secret details'); },
    clear: async () => {},
  };
  const xparseClient = async ({ name }, credentials) => {
    received = { ...credentials };
    return { ...documents[0], name };
  };
  await withServer({
    demoDocuments: documents,
    env: { TEXTIN_APP_ID: 'existing-app', TEXTIN_SECRET_CODE: 'existing-secret' },
    credentialStore,
    xparseClient,
  }, async (origin) => {
    const response = await fetch(`${origin}/api/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: 'new-app', secret_code: 'new-secret' }),
    });
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.ok(!text.includes('disk path'));
    assert.ok(!text.includes('new-secret'));

    const parsed = await fetch(`${origin}/api/parse?filename=notice.pdf`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new TextEncoder().encode('%PDF-1.7'),
    });
    assert.equal(parsed.status, 200);
    assert.deepEqual(received, { appId: 'existing-app', secretCode: 'existing-secret' });
  });
});

test('keeps current runtime credentials when clearing encrypted storage fails', async () => {
  let received = null;
  const credentialStore = {
    save: async () => {},
    clear: async () => { throw new Error('disk path and existing-secret details'); },
  };
  const xparseClient = async ({ name }, credentials) => {
    received = { ...credentials };
    return { ...documents[0], name };
  };
  await withServer({
    demoDocuments: documents,
    env: { TEXTIN_APP_ID: 'existing-app', TEXTIN_SECRET_CODE: 'existing-secret' },
    credentialStore,
    xparseClient,
  }, async (origin) => {
    const clearResponse = await fetch(`${origin}/api/credentials/clear`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const clearText = await clearResponse.text();
    assert.equal(clearResponse.status, 500);
    assert.ok(!clearText.includes('disk path'));
    assert.ok(!clearText.includes('existing-secret'));

    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.equal(health.live_parse_configured, true);
    assert.equal(health.credential_storage_error, true);

    const parsed = await fetch(`${origin}/api/parse?filename=notice.pdf`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new TextEncoder().encode('%PDF-1.7'),
    });
    assert.equal(parsed.status, 200);
    assert.deepEqual(received, { appId: 'existing-app', secretCode: 'existing-secret' });
  });
});

test('serves the browser history module with JavaScript MIME and same-origin CSP', async () => {
  await withServer({ demoDocuments: documents, env: {} }, async (origin) => {
    const response = await fetch(`${origin}/history.js`);
    const source = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(source, /export const HISTORY_KEY/);
  });
});

test('validates extension and empty uploads before calling xParse', async () => {
  let calls = 0;
  const xparseClient = async () => { calls += 1; return documents[0]; };
  await withServer({ demoDocuments: documents, env: { TEXTIN_APP_ID: 'app', TEXTIN_SECRET_CODE: 'secret' }, xparseClient }, async (origin) => {
    const unsupported = await fetch(`${origin}/api/parse?filename=notice.exe`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1]) });
    assert.equal(unsupported.status, 422);
    const empty = await fetch(`${origin}/api/parse?filename=notice.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array() });
    assert.equal(empty.status, 422);
    const disguised = await fetch(`${origin}/api/parse?filename=notice.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new TextEncoder().encode('not a pdf') });
    assert.equal(disguised.status, 422);
    const unsafeName = await fetch(`${origin}/api/parse?filename=${encodeURIComponent('../notice.pdf')}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new TextEncoder().encode('%PDF-1.7') });
    assert.equal(unsafeName.status, 422);
    assert.equal(calls, 0);
  });
});

test('parses a valid raw upload and merges sanitized documents', async () => {
  const xparseClient = async ({ name }) => ({ ...documents[0], name });
  await withServer({ demoDocuments: documents, env: { TEXTIN_APP_ID: 'app', TEXTIN_SECRET_CODE: 'secret' }, xparseClient }, async (origin) => {
    const parsedResponse = await fetch(`${origin}/api/parse?filename=${encodeURIComponent('notice.pdf')}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new TextEncoder().encode('%PDF-1.7') });
    const parsed = await parsedResponse.json();
    assert.equal(parsedResponse.status, 200);
    assert.equal(parsed.document.name, 'notice.pdf');

    const mergeResponse = await fetch(`${origin}/api/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        documents,
        context: {
          as_of: '2026-10-22T17:00:00+08:00',
          student: { name: '林小满', class_name: '三（2）班', participating: true },
          completed_actions: [],
        },
      }),
    });
    const merged = await mergeResponse.json();
    assert.equal(mergeResponse.status, 200);
    assert.deepEqual(merged.analysis.needs_confirmation.map((item) => item.kind), ['receipt', 'payment']);
  });
});

test('rejects cross-site, rebound host, and simple-content requests before xParse', async () => {
  let calls = 0;
  const xparseClient = async () => { calls += 1; return documents[0]; };
  await withServer({ demoDocuments: documents, env: { TEXTIN_APP_ID: 'app', TEXTIN_SECRET_CODE: 'secret' }, xparseClient }, async (origin) => {
    const crossSite = await fetch(`${origin}/api/parse?filename=notice.pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', origin: 'https://attacker.example' },
      body: new TextEncoder().encode('%PDF-1.7'),
    });
    assert.equal(crossSite.status, 403);

    const reboundHost = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/api/parse?filename=notice.pdf`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', host: 'attacker.example' },
      }, resolve);
      request.on('error', reject);
      request.end('%PDF-1.7');
    });
    assert.equal(reboundHost.statusCode, 403);
    reboundHost.resume();

    const simpleUpload = await fetch(`${origin}/api/parse?filename=notice.pdf`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: new TextEncoder().encode('%PDF-1.7'),
    });
    assert.equal(simpleUpload.status, 415);

    const simpleMerge = await fetch(`${origin}/api/merge`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(simpleMerge.status, 415);
    assert.equal(calls, 0);
  });
});

test('allows configured public hosts while keeping loopback as the default', async () => {
  await withServer({ demoDocuments: documents, env: {} }, async (origin) => {
    assert.equal(await statusWithHeaders(`${origin}/api/health`, { host: '47.120.19.14:8084' }), 403);
  });

  await withServer({ demoDocuments: documents, env: { ALLOWED_HOSTS: '47.120.19.14' } }, async (origin) => {
    assert.equal(await statusWithHeaders(`${origin}/api/health`, { host: '47.120.19.14:8084' }), 200);
    assert.equal(await statusWithHeaders(`${origin}/api/health`, { host: '127.0.0.1:43173' }), 200);
    assert.equal(await statusWithHeaders(`${origin}/api/health`, {
      host: '47.120.19.14:8084',
      origin: 'https://47.120.19.14:8084',
      'x-forwarded-proto': 'https',
    }), 200);
    assert.equal(await statusWithHeaders(`${origin}/api/health`, {
      host: '47.120.19.14:8084',
      origin: 'https://47.120.19.14:9999',
      'x-forwarded-proto': 'https',
    }), 403);
    assert.equal(await statusWithHeaders(`${origin}/api/health`, {
      host: '47.120.19.14:8084',
      origin: 'http://47.120.19.14:8084',
      'x-forwarded-proto': 'https',
    }), 403);
    assert.equal(await statusWithHeaders(`${origin}/api/health`, {
      host: '47.120.19.14:8084',
      origin: 'https://attacker.example',
    }), 403);
    assert.equal(await statusWithHeaders(`${origin}/api/health`, { host: 'other.example' }), 403);
  });
});

test('finalizes only after every change and submission state are explicit', async () => {
  await withServer({ demoDocuments: documents, env: {} }, async (origin) => {
    const { analysis } = await fetch(`${origin}/api/demo?child_name=${encodeURIComponent('林小满')}`).then((response) => response.json());
    const response = await fetch(`${origin}/api/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        analysis: { ...analysis, resolved_actions: analysis.resolved_actions.filter((item) => !['submit_receipt', 'pay_fee'].includes(item.id)), needs_confirmation: [
          { kind: 'receipt', message: '确认回执', evidence: analysis.receipt.evidence },
          { kind: 'payment', message: '确认缴费', evidence: analysis.payment.evidence },
        ] },
        decisions: {
          change_decisions: Object.fromEntries(analysis.changes.map((change) => [change.id, true])),
          submission_states: { receipt: 'submitted', payment: 'submitted' },
        },
      }),
    });
    const finalized = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(finalized.plan.active_todos.map((todo) => todo.id), ['prepare_personal_items', 'attend_activity']);
  });
});
