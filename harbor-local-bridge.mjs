import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBackgroundIngestor } from './harbor-background-ingestor.mjs';
import {
  createEmptyLedgerSnapshot,
  LEDGER_STORAGE_KEY,
  mergeLedgerSnapshots,
  normalizeLedgerSnapshotResult
} from './harbor-ledger-sync.js';
import {
  backupPathFor,
  createFileStorage,
  defaultAutomationConfigPath,
  defaultLedgerPath,
  recoverFileFromBackup,
  readText
} from './harbor-ledger-store.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultHelperPath = path.join(root, '.harbor', 'harbor-messages-source');
const defaultDatabasePath = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const defaultPort = 4317;
const maxOutputBytes = 10 * 1024 * 1024;
const readTimeoutMs = 15_000;
const sourcePageSize = 500;
const maxAutomaticPages = 100_000;
const int64Min = -(2n ** 63n);
const int64Max = (2n ** 63n) - 1n;

export const allowedOrigins = new Set([
  'http://127.0.0.1:4173',
  'http://127.0.0.1:4174',
  'http://127.0.0.1:4175',
  'http://127.0.0.1:4176',
  'http://127.0.0.1:4178',
  'http://127.0.0.1:4180',
  'http://localhost:4180',
  'harbor://app'
]);

export class MessagesSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MessagesSourceError';
    this.code = code;
  }
}

function responseHeaders(request) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  };
  const origin = request.headers.origin;
  if (allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers.Vary = 'Origin';
  }
  return headers;
}

function originAllowed(request) {
  return !request.headers.origin || allowedOrigins.has(request.headers.origin);
}

function readJsonBody(request, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let rejected = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (rejected) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        rejected = true;
        reject(new MessagesSourceError('request_too_large', 'The local request is too large.'));
      }
    });
    request.once('end', () => {
      if (rejected) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new MessagesSourceError('invalid_json', 'The local request must contain valid JSON.'));
      }
    });
    request.once('error', () => reject(new MessagesSourceError('request_failed', 'The local request could not be read.')));
  });
}

function sendJson(response, status, value, request) {
  response.writeHead(status, responseHeaders(request));
  response.end(JSON.stringify(value));
}

async function isReadable(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function classifySourceFailure(error) {
  if (error instanceof MessagesSourceError) return error;
  const message = error instanceof Error ? error.message : 'Unknown Messages reader failure';
  if (/not readable|operation not permitted|permission denied/i.test(message)) {
    return new MessagesSourceError('permission_required', 'Allow Full Disk Access for the Messages bridge, then retry the connection.');
  }
  if (/could not prepare/i.test(message)) {
    return new MessagesSourceError('schema_incompatible', 'The local Messages database format is not supported by this bridge version.');
  }
  if (/ENOENT|no such file/i.test(message)) {
    return new MessagesSourceError('helper_missing', 'The Messages helper is missing and must be rebuilt.');
  }
  return new MessagesSourceError('reader_failed', 'The local Messages reader could not complete its read-only scan.');
}

function requestErrorStatus(error) {
  if (!(error instanceof MessagesSourceError)) return 500;
  if (error.code === 'request_too_large') return 413;
  if (['invalid_json', 'request_failed', 'invalid_request'].includes(error.code)) return 400;
  return 500;
}

export function validateMessageCursor(value) {
  if (value === null || value === undefined || value === '') return null;
  const cursor = String(value);
  if (cursor.length > 128 || !/^\d+:\d+$/.test(cursor)) {
    throw new MessagesSourceError('invalid_cursor', 'The Messages cursor must be an exact dateNanoseconds:rowID value.');
  }
  const [dateNanoseconds, rowId] = cursor.split(':');
  if (BigInt(dateNanoseconds) > int64Max || BigInt(rowId) > int64Max) {
    throw new MessagesSourceError('invalid_cursor', 'The Messages cursor components must fit in signed Int64.');
  }
  return cursor;
}

function cursorIsAfter(nextCursor, previousCursor) {
  if (!previousCursor) return true;
  const [nextDate, nextRow] = nextCursor.split(':').map(BigInt);
  const [previousDate, previousRow] = previousCursor.split(':').map(BigInt);
  return nextDate > previousDate || (nextDate === previousDate && nextRow > previousRow);
}

export function readMessages({
  afterCursor = null,
  sinceNs = null,
  newest = false,
  limit,
  helperPath = process.env.HARBOR_HELPER_PATH || defaultHelperPath,
  databasePath = process.env.HARBOR_MESSAGES_DB_PATH || defaultDatabasePath,
  spawnImpl = spawn,
  timeoutMs = readTimeoutMs
}) {
  return new Promise((resolve, reject) => {
    const cursor = validateMessageCursor(afterCursor);
    const args = ['--db', databasePath];
    if (newest) args.push('--newest');
    else if (cursor) args.push('--after-cursor', cursor);
    else if (sinceNs !== null && sinceNs !== undefined) args.push('--since-ns', String(sinceNs));
    args.push('--limit', String(limit));
    const child = spawnImpl(helperPath, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const appendOutput = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next) > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(() => reject(new MessagesSourceError('response_too_large', 'The Messages reader returned more data than the local safety limit allows.')));
        return current;
      }
      return next;
    };

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new MessagesSourceError('scan_timeout', 'The read-only Messages scan timed out.')));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.once('error', (error) => finish(() => reject(classifySourceFailure(error))));
    child.once('close', (code) => finish(() => {
      if (code !== 0) {
        reject(classifySourceFailure(new Error(stderr.trim() || 'Messages source exited unexpectedly')));
        return;
      }
      try {
        resolve(stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
      } catch {
        reject(new MessagesSourceError('invalid_response', 'The Messages reader returned an invalid local response.'));
      }
    }));
  });
}

export async function readAllMessages({
  readMessagesImpl = readMessages,
  helperPath,
  databasePath,
  limit = 5000,
  exhaustive = false,
  afterCursor: startingCursor = null,
  sinceNs = '0'
} = {}) {
  const maximum = Number.isSafeInteger(limit) && limit > 0 ? limit : 5000;
  const messages = [];
  let afterCursor = validateMessageCursor(startingCursor);
  const seenCursors = new Set(afterCursor ? [afterCursor] : []);
  for (let page = 0; page < maxAutomaticPages && (exhaustive || messages.length < maximum); page += 1) {
    const pageLimit = exhaustive ? sourcePageSize : Math.min(sourcePageSize, maximum - messages.length);
    const pageMessages = await readMessagesImpl({
      afterCursor,
      sinceNs: afterCursor ? null : sinceNs,
      limit: pageLimit,
      helperPath,
      databasePath
    });
    if (!Array.isArray(pageMessages)) {
      throw new MessagesSourceError('invalid_response', 'The Messages reader returned an invalid page.');
    }
    if (!pageMessages.length) return messages;
    let pageCursor = afterCursor;
    for (const message of pageMessages) {
      const messageCursor = validateMessageCursor(message?.cursor);
      if (!messageCursor || !cursorIsAfter(messageCursor, pageCursor)) {
        throw new MessagesSourceError('pagination_loop', 'The Messages reader returned a page that did not advance its exact cursor.');
      }
      pageCursor = messageCursor;
    }
    messages.push(...pageMessages);
    if (pageMessages.length < pageLimit) return messages;
    const nextCursor = pageCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new MessagesSourceError('pagination_loop', 'The Messages reader repeated an exact cursor.');
    }
    seenCursors.add(nextCursor);
    afterCursor = nextCursor;
  }
  if (!exhaustive && messages.length >= maximum) return messages;
  throw new MessagesSourceError('pagination_limit', 'The Messages reader exceeded the local pagination safety limit.');
}

function parseInteger(value, { name, fallback, minimum, maximum }) {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new MessagesSourceError('invalid_request', `${name} must be a whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new MessagesSourceError('invalid_request', `${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseInt64Decimal(value, { name, fallback = '0', minimum = int64Min, maximum = int64Max } = {}) {
  const text = value === null || value === '' ? String(fallback) : String(value);
  if (!/^-?\d+$/.test(text)) {
    throw new MessagesSourceError('invalid_request', `${name} must be a decimal Int64 value.`);
  }
  const parsed = BigInt(text);
  if (parsed < minimum || parsed > maximum) {
    throw new MessagesSourceError('invalid_request', `${name} must fit in signed Int64.`);
  }
  return text;
}

export function createMessagesBridge({
  helperPath = process.env.HARBOR_HELPER_PATH || defaultHelperPath,
  databasePath = process.env.HARBOR_MESSAGES_DB_PATH || defaultDatabasePath,
  readMessagesImpl = readMessages,
  ledgerPath = defaultLedgerPath,
  automationConfigPath = defaultAutomationConfigPath,
  automation = null,
  ledgerStorage: providedLedgerStorage = null
} = {}) {
  const ledgerStorage = providedLedgerStorage || createFileStorage(ledgerPath);
  const automaticIngestor = automation || createBackgroundIngestor({
    readMessagesImpl,
    helperPath,
    databasePath,
    ledgerPath,
    configPath: automationConfigPath
  });

  async function diagnose() {
    const helperAvailable = await isReadable(helperPath);
    if (!helperAvailable) {
      return {
        ok: false,
        state: 'helper_missing',
        code: 'helper_missing',
        message: 'The Messages helper is missing. Start the bridge to rebuild it.',
        helperAvailable: false,
        databaseReadable: false
      };
    }

    const databaseReadable = await isReadable(databasePath);
    if (!databaseReadable) {
      return {
        ok: false,
        state: 'permission_required',
        code: 'permission_required',
        message: 'The bridge cannot read Apple Messages. Grant Full Disk Access, then retry.',
        helperAvailable: true,
        databaseReadable: false
      };
    }

    try {
      await readMessagesImpl({ sinceNs: int64Max.toString(), limit: 1, helperPath, databasePath });
      return {
        ok: true,
        state: 'connected',
        code: null,
        message: 'The local Messages source is connected and read-only.',
        helperAvailable: true,
        databaseReadable: true
      };
    } catch (error) {
      const failure = classifySourceFailure(error);
      return {
        ok: false,
        state: failure.code,
        code: failure.code,
        message: failure.message,
        helperAvailable: true,
        databaseReadable: false
      };
    }
  }

  function inspectBackupSnapshot() {
    let raw;
    try {
      raw = readText(backupPathFor(ledgerPath));
    } catch (error) {
      return { exists: false, valid: false, error };
    }
    if (raw === null) return { exists: false, valid: false };
    try {
      return {
        exists: true,
        valid: true,
        snapshot: normalizeLedgerSnapshotResult(JSON.parse(raw), { allowLegacy: true }).snapshot
      };
    } catch (error) {
      return { exists: true, valid: false, error };
    }
  }

  function ledgerStateError(code, message, backup) {
    const error = new MessagesSourceError(code, message);
    error.backupAvailable = backup?.exists === true;
    error.backupValid = backup?.valid === true;
    return error;
  }

  function readLedgerSnapshot() {
    const raw = ledgerStorage.getItem(LEDGER_STORAGE_KEY);
    if (raw === null) {
      const backup = inspectBackupSnapshot();
      if (backup.exists) {
        throw ledgerStateError(
          backup.valid ? 'ledger_missing_backup_available' : 'ledger_missing_backup_invalid',
          backup.valid
            ? 'The authoritative ledger is missing. Use the deliberate backup recovery action before writing new data.'
            : 'The authoritative ledger and its backup are unavailable or invalid.',
          backup
        );
      }
      const snapshot = createEmptyLedgerSnapshot();
      return { snapshot, migrated: false };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const backup = inspectBackupSnapshot();
      throw ledgerStateError(
        backup.valid ? 'ledger_corrupt_backup_available' : 'ledger_corrupt_no_recovery',
        backup.valid
          ? 'The authoritative ledger file is corrupt. Use the deliberate backup recovery action; it was not overwritten.'
          : 'The authoritative ledger file is corrupt and no valid recovery backup is available. It was not overwritten.',
        backup
      );
    }
    let normalized;
    try {
      normalized = normalizeLedgerSnapshotResult(parsed, { allowLegacy: true });
    } catch (error) {
      const backup = inspectBackupSnapshot();
      throw ledgerStateError(
        backup.valid ? 'ledger_corrupt_backup_available' : 'ledger_corrupt_no_recovery',
        backup.valid
          ? 'The authoritative ledger snapshot is corrupt. Use the deliberate backup recovery action; it was not overwritten.'
          : (error instanceof Error ? error.message : 'The authoritative ledger snapshot is invalid. It was not overwritten.'),
        backup
      );
    }
    const canonicalRaw = JSON.stringify(normalized.snapshot);
    if (normalized.migrated || canonicalRaw !== raw) {
      try {
        ledgerStorage.setItem(LEDGER_STORAGE_KEY, canonicalRaw);
      } catch (error) {
        throw new MessagesSourceError('ledger_write_failed', error instanceof Error ? error.message : 'The authoritative ledger could not be normalized safely.');
      }
    }
    return normalized;
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, responseHeaders(request));
        response.end();
        return;
      }
      if (!originAllowed(request)) {
        sendJson(response, 403, { ok: false, error: { code: 'origin_not_allowed', message: 'Local bridge controls accept only the Zoid Bank dashboard.' } }, request);
        return;
      }

      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/health') {
        if (request.method !== 'GET') {
          sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET for bridge health.' } }, request);
          return;
        }
        const health = await diagnose();
        sendJson(response, health.ok ? 200 : 503, health, request);
        return;
      }

      if (url.pathname === '/ledger') {
        if (request.method === 'GET') {
          try {
            const { snapshot } = readLedgerSnapshot();
            sendJson(response, 200, { ok: true, authoritative: 'local-file', ledgerPath, snapshot }, request);
          } catch (error) {
            sendJson(response, 500, {
              ok: false,
              error: {
                code: error.code || 'invalid_ledger_state',
                message: error.message || 'The authoritative ledger could not be read.',
                ...(error.backupAvailable !== undefined ? {
                  backupAvailable: error.backupAvailable,
                  backupValid: error.backupValid
                } : {})
              }
            }, request);
          }
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          let incoming;
          try {
            incoming = normalizeLedgerSnapshotResult(body?.snapshot, { allowLegacy: true }).snapshot;
          } catch (error) {
            sendJson(response, 400, {
              ok: false,
              error: {
                code: error.code || 'invalid_ledger_snapshot',
                message: error.message || 'The local ledger snapshot is invalid.'
              }
            }, request);
            return;
          }
          let current;
          try {
            current = readLedgerSnapshot().snapshot;
          } catch (error) {
            sendJson(response, 409, {
              ok: false,
              error: {
                code: error.code || 'invalid_ledger_state',
                message: error.message || 'The authoritative ledger could not be reconciled.',
                ...(error.backupAvailable !== undefined ? {
                  backupAvailable: error.backupAvailable,
                  backupValid: error.backupValid
                } : {})
              }
            }, request);
            return;
          }
          const snapshot = mergeLedgerSnapshots(incoming, current);
          try {
            // Keep this read-merge-write section synchronous. Node cannot interleave
            // another request between the latest read and the atomic file write.
            ledgerStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(snapshot));
          } catch (error) {
            sendJson(response, 500, {
              ok: false,
              error: {
                code: 'ledger_write_failed',
                message: error instanceof Error ? error.message : 'The authoritative ledger could not be saved.'
              }
            }, request);
            return;
          }
          sendJson(response, 200, { ok: true, authoritative: 'local-file', ledgerPath, snapshot }, request);
          return;
        }
        sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET or POST for local ledger state.' } }, request);
        return;
      }

      if (url.pathname === '/ledger/recover') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use POST to deliberately recover the ledger from its backup.' } }, request);
          return;
        }
        const body = await readJsonBody(request, 1024);
        if (body.confirm !== true) {
          sendJson(response, 400, { ok: false, error: { code: 'recovery_confirmation_required', message: 'Set confirm to true to recover the ledger from its backup.' } }, request);
          return;
        }
        const backup = inspectBackupSnapshot();
        if (!backup.valid) {
          sendJson(response, 409, {
            ok: false,
            error: {
              code: backup.exists ? 'ledger_backup_invalid' : 'ledger_backup_missing',
              message: 'A valid ledger backup is required before deliberate recovery can proceed.',
              backupAvailable: backup.exists,
              backupValid: false
            }
          }, request);
          return;
        }
        try {
          recoverFileFromBackup(ledgerPath, JSON.stringify(backup.snapshot));
        } catch (error) {
          sendJson(response, 500, { ok: false, error: { code: 'ledger_recovery_failed', message: error instanceof Error ? error.message : 'The ledger backup could not be restored.' } }, request);
          return;
        }
        const { snapshot } = readLedgerSnapshot();
        sendJson(response, 200, { ok: true, recovered: true, authoritative: 'local-file', ledgerPath, snapshot }, request);
        return;
      }

      if (url.pathname === '/automation') {
        if (request.method === 'GET') {
          sendJson(response, 200, { ok: true, ...automaticIngestor.status() }, request);
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request, 1024);
          if (typeof body.enabled !== 'boolean') {
            sendJson(response, 400, { ok: false, error: { code: 'invalid_request', message: 'Automatic ingestion enabled must be true or false.' } }, request);
            return;
          }
          try {
            sendJson(response, 200, { ok: true, ...await automaticIngestor.setEnabled(body.enabled) }, request);
          } catch (error) {
            sendJson(response, 409, { ok: false, error: { code: 'automation_change_failed', message: error instanceof Error ? error.message : 'Automatic ingestion could not be changed.' } }, request);
          }
          return;
        }
        sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET or POST for automatic ingestion.' } }, request);
        return;
      }

      if (url.pathname !== '/messages') {
        sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Not found.' } }, request);
        return;
      }

      if (request.method !== 'GET') {
        sendJson(response, 405, { ok: false, error: { code: 'method_not_allowed', message: 'The Messages source is read-only and accepts GET only.' } }, request);
        return;
      }

      if (!(await isReadable(helperPath))) {
        sendJson(response, 503, { ok: false, error: { code: 'helper_missing', message: 'The Messages helper is missing. Start the bridge to rebuild it.' } }, request);
        return;
      }
      if (!(await isReadable(databasePath))) {
        sendJson(response, 503, { ok: false, error: { code: 'permission_required', message: 'The bridge cannot read Apple Messages. Grant Full Disk Access, then retry.' } }, request);
        return;
      }

      let afterCursor;
      let sinceNs;
      let limit;
      try {
        afterCursor = validateMessageCursor(url.searchParams.get('afterCursor') || url.searchParams.get('after-cursor'));
        sinceNs = afterCursor
          ? null
          : parseInt64Decimal(url.searchParams.get('sinceNs'), { name: 'sinceNs', fallback: '0' });
        limit = parseInteger(url.searchParams.get('limit'), { name: 'limit', fallback: 500, minimum: 1, maximum: 5000 });
      } catch (error) {
        const failure = classifySourceFailure(error);
        sendJson(response, 400, { ok: false, error: { code: failure.code, message: failure.message } }, request);
        return;
      }

      try {
        const messages = await readMessagesImpl({ afterCursor, sinceNs, limit, helperPath, databasePath });
        let pageCursor = afterCursor;
        for (const message of messages) {
          const messageCursor = validateMessageCursor(message?.cursor);
          if (!messageCursor || !cursorIsAfter(messageCursor, pageCursor)) {
            throw new MessagesSourceError('pagination_loop', 'The Messages reader returned a page that did not advance its exact cursor.');
          }
          pageCursor = messageCursor;
        }
        const nextCursor = messages.length === limit ? pageCursor : null;
        sendJson(response, 200, { ok: true, messages, nextCursor, hasMore: Boolean(nextCursor) }, request);
      } catch (error) {
        const failure = classifySourceFailure(error);
        console.error('Read-only Messages scan failed:', failure.code);
        sendJson(response, 500, { ok: false, error: { code: failure.code, message: failure.message } }, request);
      }
    } catch (error) {
      console.error('Messages bridge request failed:', error instanceof Error ? error.message : 'unknown error');
      if (!response.headersSent) {
        const status = requestErrorStatus(error);
        const payload = error instanceof MessagesSourceError
          ? { code: error.code, message: error.message }
          : { code: 'internal_error', message: 'The local Messages bridge encountered an unexpected error.' };
        sendJson(response, status, { ok: false, error: payload }, request);
      } else {
        response.end();
      }
    }
  });
  server.automaticIngestor = automaticIngestor;
  return server;
}

function parsePort(value) {
  const port = Number(value || defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('HARBOR_BRIDGE_PORT must be a valid TCP port.');
  }
  return port;
}

export function startMessagesBridge() {
  const port = parsePort(process.env.HARBOR_BRIDGE_PORT);
  const server = createMessagesBridge();
  server.on('error', (error) => {
    console.error('Messages bridge could not start:', error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Zoid Bank local bridge listening on http://127.0.0.1:${port}`);
    server.automaticIngestor.start();
  });

  const close = () => {
    server.automaticIngestor.stop();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startMessagesBridge();
}
