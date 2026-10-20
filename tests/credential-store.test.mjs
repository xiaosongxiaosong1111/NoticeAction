import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { CredentialStoreError, createCredentialStore } from '../src/credential-store.mjs';

const codec = {
  protect: async (value) => Buffer.from(value, 'utf8').toString('base64url'),
  unprotect: async (value) => Buffer.from(value, 'base64url').toString('utf8'),
};

async function withTempStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'notice-action-credentials-'));
  const filePath = join(directory, 'credentials.v1.dpapi');
  try {
    await run({ directory, filePath, store: createCredentialStore({ filePath, ...codec }) });
  } finally {
    const safeTempRoot = resolve(tmpdir());
    assert.ok(resolve(directory).startsWith(safeTempRoot));
    await rm(directory, { recursive: true, force: true });
  }
}

test('credential store saves no plaintext, reloads, replaces, and clears credentials', async () => {
  await withTempStore(async ({ filePath, store }) => {
    await store.save({ appId: 'app-first', secretCode: 'secret-first' });
    const raw = await readFile(filePath, 'utf8');
    assert.ok(!raw.includes('app-first'));
    assert.ok(!raw.includes('secret-first'));
    assert.deepEqual(await store.load(), { appId: 'app-first', secretCode: 'secret-first' });

    await store.save({ appId: 'app-second', secretCode: 'secret-second' });
    assert.deepEqual(await store.load(), { appId: 'app-second', secretCode: 'secret-second' });

    await store.clear();
    assert.equal(await store.load(), null);
    await store.clear();
  });
});

test('credential store rejects malformed credentials before encrypting or writing', async () => {
  await withTempStore(async ({ store }) => {
    const invalidCredentials = [
      null,
      [],
      { appId: 'app' },
      { appId: 42, secretCode: 'secret' },
      { appId: ' '.repeat(3), secretCode: 'secret' },
      { appId: 'app', secretCode: ' '.repeat(3) },
      { appId: 'app\nheader', secretCode: 'secret' },
      { appId: 'a'.repeat(257), secretCode: 'secret' },
      { appId: 'app', secretCode: 's'.repeat(513) },
    ];

    for (const credentials of invalidCredentials) {
      await assert.rejects(store.save(credentials), CredentialStoreError);
    }
    assert.equal(await store.load(), null);
  });
});

test('credential store fails closed for corrupt ciphertext without leaking details', async () => {
  await withTempStore(async ({ filePath }) => {
    await writeFile(filePath, JSON.stringify({ version: 1, payload: 'broken-ciphertext' }));
    const store = createCredentialStore({
      filePath,
      protect: codec.protect,
      unprotect: async () => { throw new Error('provider stderr with secret details'); },
    });
    await assert.rejects(store.load(), (error) => {
      assert.ok(error instanceof CredentialStoreError);
      assert.ok(!error.message.includes('broken-ciphertext'));
      assert.ok(!error.message.includes('provider stderr'));
      return true;
    });
  });
});

test('credential store does not replace the last good file when encryption fails', async () => {
  await withTempStore(async ({ filePath, store }) => {
    await store.save({ appId: 'stable-app', secretCode: 'stable-secret' });
    const failingStore = createCredentialStore({
      filePath,
      protect: async () => { throw new Error('encryption unavailable'); },
      unprotect: codec.unprotect,
    });
    await assert.rejects(
      failingStore.save({ appId: 'new-app', secretCode: 'new-secret' }),
      CredentialStoreError,
    );
    assert.deepEqual(await store.load(), { appId: 'stable-app', secretCode: 'stable-secret' });
  });
});

test('default Windows DPAPI adapter round-trips without writing plaintext', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'notice-action-dpapi-'));
  const filePath = join(directory, 'credentials.v1.dpapi');
  try {
    const store = createCredentialStore({ filePath });
    await store.save({ appId: 'dpapi-test-app', secretCode: 'dpapi-test-secret' });
    const raw = await readFile(filePath, 'utf8');
    assert.ok(!raw.includes('dpapi-test-app'));
    assert.ok(!raw.includes('dpapi-test-secret'));
    assert.deepEqual(await store.load(), { appId: 'dpapi-test-app', secretCode: 'dpapi-test-secret' });
    await store.save({ appId: 'dpapi-test-app-replaced', secretCode: 'dpapi-test-secret-replaced' });
    const replacedRaw = await readFile(filePath, 'utf8');
    assert.ok(!replacedRaw.includes('dpapi-test-app-replaced'));
    assert.ok(!replacedRaw.includes('dpapi-test-secret-replaced'));
    assert.deepEqual(await store.load(), { appId: 'dpapi-test-app-replaced', secretCode: 'dpapi-test-secret-replaced' });
    await store.clear();
    assert.equal(await store.load(), null);
  } finally {
    const safeTempRoot = resolve(tmpdir());
    assert.ok(resolve(directory).startsWith(safeTempRoot));
    await rm(directory, { recursive: true, force: true });
  }
});
