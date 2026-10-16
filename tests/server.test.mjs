import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { createAppServer } from '../server.mjs';

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

test('serves health and the competition demo without credentials', async () => {
  await withServer({ demoDocuments: documents, env: {} }, async (origin) => {
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true, live_parse_configured: false });
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
