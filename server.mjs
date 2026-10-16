import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizePlan, MergeError, mergeDocuments } from './src/merge.mjs';
import { parseFile, XParseError } from './src/xparse-client.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/history.js', ['history.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.xlsx', '.png', '.jpg', '.jpeg']);
const DEFAULT_FILE_LIMIT = 10 * 1024 * 1024;
const DEFAULT_JSON_LIMIT = 20 * 1024 * 1024;
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
  if (error instanceof MergeError || error instanceof XParseError) return error.message;
  return '服务暂时不可用，请稍后重试';
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
  if ((url.pathname === '/api/merge' || url.pathname === '/api/finalize') && type !== 'application/json') {
    throw new MergeError('该接口仅接受 application/json', 415);
  }
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
  xparseClient = parseFile,
  fileLimit = DEFAULT_FILE_LIMIT,
  jsonLimit = DEFAULT_JSON_LIMIT,
} = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      assertLocalApiRequest(request, url);
      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        sendStatic(response, url.pathname);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, live_parse_configured: Boolean(env.TEXTIN_APP_ID && env.TEXTIN_SECRET_CODE) });
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
      if (request.method === 'POST' && url.pathname === '/api/parse') {
        const name = url.searchParams.get('filename')?.trim() ?? '';
        const extension = extname(name).toLowerCase();
        if (!name || name.length > 160 || basename(name) !== name || !ALLOWED_EXTENSIONS.has(extension)) throw new MergeError('仅支持安全命名的 PDF、XLSX、PNG、JPG 文件');
        if (!env.TEXTIN_APP_ID || !env.TEXTIN_SECRET_CODE) throw new MergeError('服务端尚未配置 xParse 凭据', 503);
        const bytes = await readBody(request, fileLimit);
        if (bytes.length === 0) throw new MergeError('不能上传空文件');
        if (!hasExpectedSignature(extension, bytes)) throw new MergeError('文件内容与扩展名不一致');
        const document = await xparseClient(
          { name, bytes },
          { appId: env.TEXTIN_APP_ID, secretCode: env.TEXTIN_SECRET_CODE },
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
      sendJson(response, statusCode, { ok: false, error: { message: safeMessage(error) } });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const portFlag = process.argv.indexOf('--port');
  const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : process.env.PORT || 43173);
  const server = createAppServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`通知清单已启动：http://127.0.0.1:${port}`);
    console.log(process.env.TEXTIN_APP_ID && process.env.TEXTIN_SECRET_CODE ? '实时 xParse：已配置' : '实时 xParse：未配置，可使用示例材料');
  });
}
