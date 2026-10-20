import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

async function freePort() {
  const probe = createServer();
  await new Promise((resolveReady) => probe.listen(0, '127.0.0.1', resolveReady));
  const { port } = probe.address();
  await new Promise((resolveClosed) => probe.close(resolveClosed));
  return port;
}

function isolatedEnvironment(localAppData) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
      'TEXTIN_APP_ID',
      'TEXTIN_SECRET_CODE',
      'LOCALAPPDATA',
    ].includes(name.toUpperCase()))),
    LOCALAPPDATA: localAppData,
  };
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('测试服务启动失败');
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error('测试服务启动超时');
}

async function startServer(localAppData) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs', '--port', String(port)], {
    cwd: PROJECT_ROOT,
    env: isolatedEnvironment(localAppData),
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  const origin = `http://127.0.0.1:${port}`;
  await waitForHealth(origin, child);
  return { child, origin };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  let timeout;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('测试服务停止超时')), 5_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('saved credentials survive a real server restart and clearing survives the next restart', {
  skip: process.platform !== 'win32',
}, async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'notice-action-startup-'));
  const credentialPath = join(localAppData, 'NoticeAction', 'credentials.v1.dpapi');
  let running;
  try {
    running = await startServer(localAppData);
    const saveResponse = await fetch(`${running.origin}/api/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: 'restart-test-app', secret_code: 'restart-test-secret' }),
    });
    assert.equal(saveResponse.status, 200);
    const encrypted = await readFile(credentialPath, 'utf8');
    assert.ok(!encrypted.includes('restart-test-app'));
    assert.ok(!encrypted.includes('restart-test-secret'));
    await stopServer(running.child);

    running = await startServer(localAppData);
    let health = await fetch(`${running.origin}/api/health`).then((response) => response.json());
    assert.equal(health.credential_management_version, 1);
    assert.equal(health.live_parse_configured, true);
    assert.equal(health.credentials_saved, true);
    const clearResponse = await fetch(`${running.origin}/api/credentials/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(clearResponse.status, 200);
    await stopServer(running.child);

    running = await startServer(localAppData);
    health = await fetch(`${running.origin}/api/health`).then((response) => response.json());
    assert.equal(health.live_parse_configured, false);
    assert.equal(health.credentials_saved, false);
  } finally {
    await stopServer(running?.child).catch(() => {});
    const safeTempRoot = resolve(tmpdir());
    assert.ok(resolve(localAppData).startsWith(safeTempRoot));
    await rm(localAppData, { recursive: true, force: true });
  }
});
