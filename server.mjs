import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CredentialStoreError, createCredentialStore } from './src/credential-store.mjs';
import { finalizePlan, MergeError, mergeDocuments } from './src/merge.mjs';
import { parseFile, XParseError } from './src/xparse-client.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/history.js', ['history.js', 'text/javascript; charset=utf-8']],
  ['/incremental.js', ['incremental.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.xlsx', '.png', '.jpg', '.jpeg']);
const DEFAULT_FILE_LIMIT = 10 * 1024 * 1024;
const DEFAULT_JSON_LIMIT = 20 * 1024 * 1024;
const CREDENTIAL_JSON_LIMIT = 4 * 1024;
const CREDENTIAL_MANAGEMENT_VERSION = 1;
const SERVICE_ID = 'notice-action-local-v1';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const UPLOAD_MEDIA_TYPES = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
]);

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendStatic(response, pathName) {
  const [fileName, contentType] = STATIC_FILES.get(pathName);
  const body = readFileSync(join(ROOT, 'static', fileName));
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}

async function readBody(request, limit) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > limit) throw new MergeError('文件或请求内容超过大小限制', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new MergeError('文件或请求内容超过大小限制', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limit) {
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new MergeError('请求 JSON 格式不正确');
  }
}

function defaultDemoDocuments() {
  return JSON.parse(readFileSync(join(ROOT, 'samples', 'demo-documents.json'), 'utf8'));
}

function demoContext(childName, participating = true) {
  return {
    as_of: '2026-10-22T17:00:00+08:00',
    student: { name: childName || '林小满', class_name: '三（2）班', participating },
    completed_actions: [],
  };
}

function safeMessage(error) {
  if (error instanceof MergeError || error instanceof XParseError || error instanceof CredentialStoreError) return error.message;
  return '服务暂时不可用，请稍后重试';
}

function safeErrorPayload(error) {
  const payload = { message: safeMessage(error) };
  if (error instanceof XParseError && /^TEXTIN_[A-Z_]+$/u.test(error.code ?? '')) {
    return { code: error.code, ...payload };
  }
  return payload;
}

function mediaType(request) {
  return String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
}

function assertLocalApiRequest(request, url) {
  if (!url.pathname.startsWith('/api/')) return;
  const host = String(request.headers.host ?? '').toLowerCase();
  if (!/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(host)) throw new MergeError('仅允许从本机访问接口', 403);

  const origin = request.headers.origin;
  if (origin) {
    let originUrl;
    try { originUrl = new URL(origin); } catch { throw new MergeError('拒绝跨站请求', 403); }
    if (originUrl.protocol !== 'http:' || originUrl.host.toLowerCase() !== host) throw new MergeError('拒绝跨站请求', 403);
  }
  const fetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw new MergeError('拒绝跨站请求', 403);

  if (request.method !== 'POST') return;
  const type = mediaType(request);
  if (url.pathname === '/api/parse' && !UPLOAD_MEDIA_TYPES.has(type)) throw new MergeError('上传 Content-Type 不受支持', 415);
  if (['/api/merge', '/api/finalize', '/api/credentials', '/api/credentials/clear'].includes(url.pathname) && type !== 'application/json') {
    throw new MergeError('该接口仅接受 application/json', 415);
  }
}

function validateCredentialPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new MergeError('AppID 或 Secret Code 格式不正确');
  const keys = Object.keys(payload).sort();
  if (keys.length !== 2 || keys[0] !== 'app_id' || keys[1] !== 'secret_code') throw new MergeError('AppID 或 Secret Code 格式不正确');
  const { app_id: appId, secret_code: secretCode } = payload;
  if (typeof appId !== 'string' || typeof secretCode !== 'string') throw new MergeError('AppID 或 Secret Code 格式不正确');
  if (appId.length > 256 || secretCode.length > 512 || !appId.trim() || !secretCode.trim()) throw new MergeError('AppID 或 Secret Code 格式不正确');
  if (CONTROL_CHARACTERS.test(appId) || CONTROL_CHARACTERS.test(secretCode)) throw new MergeError('AppID 或 Secret Code 格式不正确');
  return Object.freeze({ appId: appId.trim(), secretCode });
}

function internalCredentials(value) {
  if (!value?.appId || !value?.secretCode) return null;
  try {
    return validateCredentialPayload({ app_id: value.appId, secret_code: value.secretCode });
  } catch {
    return null;
  }
}

function healthPayload(state, credentialStore) {
  return {
    ok: true,
    service_id: SERVICE_ID,
    credential_management_version: CREDENTIAL_MANAGEMENT_VERSION,
    live_parse_configured: Boolean(state.credentials),
    credentials_saved: Boolean(state.saved),
    credential_storage_available: Boolean(credentialStore),
    credential_storage_error: Boolean(state.storageError),
  };
}

function hasExpectedSignature(extension, bytes) {
  if (extension === '.pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (extension === '.png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === '.xlsx') return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3]);
  return false;
}

export function createAppServer({
  demoDocuments = defaultDemoDocuments(),
  env = process.env,
  initialCredentials,
  credentialsSaved = false,
  credentialStorageError = false,
  credentialStore = null,
  xparseClient = parseFile,
  fileLimit = DEFAULT_FILE_LIMIT,
  jsonLimit = DEFAULT_JSON_LIMIT,
} = {}) {
  const startingCredentials = internalCredentials(initialCredentials) ?? internalCredentials({
    appId: env.TEXTIN_APP_ID,
    secretCode: env.TEXTIN_SECRET_CODE,
  });
  let credentialState = Object.freeze({
    credentials: startingCredentials,
    saved: Boolean(startingCredentials && credentialsSaved),
    storageError: Boolean(credentialStorageError),
  });
  let credentialMutationQueue = Promise.resolve();

  function enqueueCredentialMutation(mutation) {
    const operation = credentialMutationQueue.then(mutation, mutation);
    credentialMutationQueue = operation.catch(() => {});
    return operation;
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      assertLocalApiRequest(request, url);
      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        sendStatic(response, url.pathname);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, healthPayload(credentialState, credentialStore));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/demo') {
        const analysis = mergeDocuments(demoDocuments, demoContext(
          url.searchParams.get('child_name')?.trim(),
          url.searchParams.get('participating') !== 'false',
        ));
        sendJson(response, 200, { ok: true, analysis });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/credentials') {
        if (!credentialStore?.save) throw new MergeError('Windows 凭据安全存储不可用', 503);
        const credentials = validateCredentialPayload(await readJson(request, CREDENTIAL_JSON_LIMIT));
        const result = await enqueueCredentialMutation(async () => {
          try {
            await credentialStore.save(credentials);
          } catch (error) {
            credentialState = Object.freeze({ ...credentialState, storageError: true });
            throw error;
          }
          credentialState = Object.freeze({ credentials, saved: true, storageError: false });
          return healthPayload(credentialState, credentialStore);
        });
        sendJson(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/credentials/clear') {
        if (!credentialStore?.clear) throw new MergeError('Windows 凭据安全存储不可用', 503);
        const payload = await readJson(request, CREDENTIAL_JSON_LIMIT);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0) {
          throw new MergeError('清除凭据请求格式不正确');
        }
        const result = await enqueueCredentialMutation(async () => {
          try {
            await credentialStore.clear();
          } catch (error) {
            credentialState = Object.freeze({ ...credentialState, storageError: true });
            throw error;
          }
          credentialState = Object.freeze({ credentials: null, saved: false, storageError: false });
          return healthPayload(credentialState, credentialStore);
        });
        sendJson(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/parse') {
        const name = url.searchParams.get('filename')?.trim() ?? '';
        const extension = extname(name).toLowerCase();
        if (!name || name.length > 160 || basename(name) !== name || !ALLOWED_EXTENSIONS.has(extension)) throw new MergeError('仅支持安全命名的 PDF、XLSX、PNG、JPG 文件');
        const credentials = credentialState.credentials;
        if (!credentials) throw new MergeError('服务端尚未配置 xParse 凭据', 503);
        const bytes = await readBody(request, fileLimit);
        if (bytes.length === 0) throw new MergeError('不能上传空文件');
        if (!hasExpectedSignature(extension, bytes)) throw new MergeError('文件内容与扩展名不一致');
        const document = await xparseClient(
          { name, bytes },
          credentials,
        );
        sendJson(response, 200, { ok: true, document });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/merge') {
        const payload = await readJson(request, jsonLimit);
        const analysis = mergeDocuments(payload.documents, payload.context);
        sendJson(response, 200, { ok: true, analysis });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/finalize') {
        const payload = await readJson(request, jsonLimit);
        const plan = finalizePlan(payload.analysis, payload.decisions);
        sendJson(response, 200, { ok: true, plan });
        return;
      }
      sendJson(response, 404, { ok: false, error: { message: '未找到该页面或接口' } });
    } catch (error) {
      const statusCode = Number(error.statusCode) || 500;
      sendJson(response, statusCode, { ok: false, error: safeErrorPayload(error) });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const portFlag = process.argv.indexOf('--port');
  const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : process.env.PORT || 43173);
  const credentialStore = process.platform === 'win32' ? createCredentialStore() : null;
  const environmentCredentials = internalCredentials({
    appId: process.env.TEXTIN_APP_ID,
    secretCode: process.env.TEXTIN_SECRET_CODE,
  });
  let initialCredentials = environmentCredentials;
  let credentialsSaved = false;
  let credentialStorageError = false;
  if (!initialCredentials && credentialStore) {
    try {
      initialCredentials = await credentialStore.load();
      credentialsSaved = Boolean(initialCredentials);
    } catch {
      credentialStorageError = true;
      console.warn('Windows 加密凭据未能读取，请在页面中重新配置');
    }
  }
  const server = createAppServer({ credentialStore, initialCredentials, credentialsSaved, credentialStorageError });
  server.listen(port, '127.0.0.1', () => {
    console.log(`通知清单已启动：http://127.0.0.1:${port}`);
    console.log(initialCredentials ? '实时 xParse：已配置' : '实时 xParse：未配置，可在页面中设置');
  });
}
