import { randomUUID } from 'node:crypto';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 64 * 1024;
const MAX_POWERSHELL_OUTPUT_BYTES = 64 * 1024;
const POWERSHELL_TIMEOUT_MS = 10_000;
const ENTROPY = 'NoticeAction.credentials.v1';
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$source = [Console]::OpenStandardInput()
$memory = New-Object System.IO.MemoryStream
$source.CopyTo($memory)
$entropy = [System.Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$encrypted = [System.Security.Cryptography.ProtectedData]::Protect($memory.ToArray(), $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($encrypted))
`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd().Trim()
$entropy = [System.Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$encrypted = [Convert]::FromBase64String($encoded)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$target = [Console]::OpenStandardOutput()
$target.Write($plain, 0, $plain.Length)
`;

const PROTECT_COMMAND = Buffer.from(PROTECT_SCRIPT, 'utf16le').toString('base64');
const UNPROTECT_COMMAND = Buffer.from(UNPROTECT_SCRIPT, 'utf16le').toString('base64');

export class CredentialStoreError extends Error {
  constructor(message = 'Windows 凭据安全存储暂时不可用') {
    super(message);
    this.name = 'CredentialStoreError';
    this.statusCode = 500;
  }
}

function defaultFilePath() {
  const localAppData = String(process.env.LOCALAPPDATA ?? '').trim();
  const base = localAppData || join(homedir(), 'AppData', 'Local');
  return join(base, 'NoticeAction', 'credentials.v1.dpapi');
}

function validateCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CredentialStoreError();
  const { appId, secretCode } = value;
  if (typeof appId !== 'string' || typeof secretCode !== 'string') throw new CredentialStoreError();
  if (appId.length > 256 || secretCode.length > 512) throw new CredentialStoreError();
  if (!appId.trim() || !secretCode.trim()) throw new CredentialStoreError();
  if (CONTROL_CHARACTERS.test(appId) || CONTROL_CHARACTERS.test(secretCode)) throw new CredentialStoreError();
  return Object.freeze({ appId: appId.trim(), secretCode });
}

function powershellExecutable() {
  const systemRoot = String(process.env.SystemRoot ?? process.env.WINDIR ?? '').trim();
  if (!systemRoot) throw new CredentialStoreError();
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powershellEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
    'TEXTIN_APP_ID',
    'TEXTIN_SECRET_CODE',
  ].includes(name.toUpperCase())));
}

function runDpapi(command, input) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputSize = 0;
    let errorSize = 0;
    const output = [];
    let child;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new CredentialStoreError());
      else resolve(value);
    };

    try {
      child = spawn(powershellExecutable(), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        command,
      ], {
        env: powershellEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      reject(new CredentialStoreError());
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish(new CredentialStoreError());
    }, POWERSHELL_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize > MAX_POWERSHELL_OUTPUT_BYTES) {
        child.kill();
        finish(new CredentialStoreError());
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorSize += chunk.length;
      if (errorSize > MAX_POWERSHELL_OUTPUT_BYTES) {
        child.kill();
        finish(new CredentialStoreError());
      }
    });
    child.on('error', () => finish(new CredentialStoreError()));
    child.on('close', (code) => {
      if (code !== 0) finish(new CredentialStoreError());
      else finish(null, Buffer.concat(output));
    });
    child.stdin.on('error', () => finish(new CredentialStoreError()));
    child.stdin.end(input);
  });
}

async function protectWithDpapi(plaintext) {
  const output = await runDpapi(PROTECT_COMMAND, Buffer.from(plaintext, 'utf8'));
  const payload = output.toString('ascii').trim();
  if (!payload || payload.length > MAX_STORE_BYTES) throw new CredentialStoreError();
  return payload;
}

async function unprotectWithDpapi(payload) {
  const output = await runDpapi(UNPROTECT_COMMAND, Buffer.from(payload, 'ascii'));
  return output.toString('utf8');
}

export function createCredentialStore({
  filePath = defaultFilePath(),
  protect = protectWithDpapi,
  unprotect = unprotectWithDpapi,
} = {}) {
  return Object.freeze({
    async load() {
      let handle;
      try {
        try {
          handle = await open(filePath, 'r');
        } catch (error) {
          if (error?.code === 'ENOENT') return null;
          throw error;
        }
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_STORE_BYTES) throw new CredentialStoreError();
        const stored = JSON.parse((await handle.readFile()).toString('utf8'));
        if (stored?.version !== STORE_VERSION || typeof stored.payload !== 'string' || !stored.payload || stored.payload.length > MAX_STORE_BYTES) {
          throw new CredentialStoreError();
        }
        const plaintext = await unprotect(stored.payload);
        if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > MAX_STORE_BYTES) throw new CredentialStoreError();
        return validateCredentials(JSON.parse(plaintext));
      } catch (error) {
        if (error instanceof CredentialStoreError) throw error;
        throw new CredentialStoreError();
      } finally {
        await handle?.close().catch(() => {});
      }
    },

    async save(credentials) {
      const validated = validateCredentials(credentials);
      const directory = dirname(filePath);
      const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
      let handle;
      try {
        const payload = await protect(JSON.stringify(validated));
        if (typeof payload !== 'string' || !payload || payload.length > MAX_STORE_BYTES) throw new CredentialStoreError();
        const body = JSON.stringify({ version: STORE_VERSION, payload });
        if (Buffer.byteLength(body, 'utf8') > MAX_STORE_BYTES) throw new CredentialStoreError();
        await mkdir(directory, { recursive: true, mode: 0o700 });
        handle = await open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(body, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporaryPath, filePath);
      } catch (error) {
        await handle?.close().catch(() => {});
        await unlink(temporaryPath).catch(() => {});
        if (error instanceof CredentialStoreError) throw error;
        throw new CredentialStoreError();
      }
    },

    async clear() {
      try {
        await unlink(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new CredentialStoreError();
      }
    },
  });
}
