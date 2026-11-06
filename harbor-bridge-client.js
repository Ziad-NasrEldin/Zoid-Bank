import { isValidLedgerSnapshot } from './harbor-ledger-sync.js';

const defaultTimeoutMs = 6000;
const int64Max = (2n ** 63n) - 1n;

export class BridgeClientError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'BridgeClientError';
    this.code = code;
    this.status = status;
  }
}

export async function requestJson(url, options = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || defaultTimeoutMs);
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;
  try {
    const response = await fetchImpl(url, {
      ...fetchOptions,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      },
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new BridgeClientError('invalid_response', 'The local bridge returned an invalid response.', response.status);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new BridgeClientError('invalid_response', 'The local bridge returned unreadable data.', response.status);
    }
    return { payload, response };
  } catch (error) {
    if (error instanceof BridgeClientError) throw error;
    if (error?.name === 'AbortError') {
      throw new BridgeClientError('timeout', 'The local bridge did not respond in time.');
    }
    throw new BridgeClientError('unreachable', 'The local Messages bridge is not responding.');
  } finally {
    clearTimeout(timeout);
  }
}

function errorFromResponse(payload, response, fallback) {
  const error = payload?.error || payload;
  return new BridgeClientError(
    error?.code || 'request_failed',
    error?.message || fallback,
    response.status
  );
}

function validateClientCursor(value) {
  const cursor = String(value || '');
  if (!/^\d+:\d+$/.test(cursor)) {
    throw new BridgeClientError('invalid_response', 'The Messages scan returned an invalid exact cursor.');
  }
  const [dateNanoseconds, rowId] = cursor.split(':').map(BigInt);
  if (dateNanoseconds > int64Max || rowId > int64Max) {
    throw new BridgeClientError('invalid_response', 'The Messages scan returned a cursor outside signed Int64.');
  }
  return cursor;
}

export function createBridgeClient({
  bridgeUrl = 'http://127.0.0.1:4317',
  controlUrl = null,
  fetchImpl = fetch
} = {}) {
  async function directStatus() {
    try {
      const { payload } = await requestJson(`${bridgeUrl}/health`, {}, fetchImpl);
      return { ...payload, controllable: false, installed: null, loaded: null };
    } catch (error) {
      return {
        ok: false,
        state: 'stopped',
        code: error.code,
        message: error.message,
        helperAvailable: null,
        databaseReadable: null,
        controllable: false,
        installed: null,
        loaded: null
      };
    }
  }

  async function status() {
    if (controlUrl) {
      try {
        const { payload, response } = await requestJson(controlUrl, {}, fetchImpl);
        if (!response.ok) throw errorFromResponse(payload, response, 'Bridge status could not be checked.');
        return payload;
      } catch (error) {
        if (!['invalid_response', 'unreachable'].includes(error.code)) throw error;
      }
    }
    return directStatus();
  }

  async function perform(action) {
    if (!controlUrl) {
      throw new BridgeClientError('control_unavailable', 'Bridge controls are available from the local production dashboard.');
    }
    const { payload, response } = await requestJson(controlUrl, {
      method: 'POST',
      body: JSON.stringify({ action })
    }, fetchImpl);
    if (!response.ok) throw errorFromResponse(payload, response, 'The bridge action could not be completed.');
    return payload;
  }

  async function scan(pageSize = 500) {
    const requestedPageSize = Number(pageSize);
    const safePageSize = Number.isSafeInteger(requestedPageSize) && requestedPageSize > 0
      ? Math.min(requestedPageSize, 500)
      : 500;
    const messages = [];
    const seenCursors = new Set();
    let afterCursor = null;
    for (let page = 0; page < 10_000; page += 1) {
      const query = new URLSearchParams({ limit: String(safePageSize) });
      if (afterCursor) query.set('afterCursor', afterCursor);
      const { payload, response } = await requestJson(`${bridgeUrl}/messages?${query.toString()}`, {}, fetchImpl);
      if (!response.ok) throw errorFromResponse(payload, response, 'The read-only Messages scan could not be completed.');
      if (!Array.isArray(payload.messages)) {
        throw new BridgeClientError('invalid_response', 'The Messages scan did not return a valid message list.', response.status);
      }
      messages.push(...payload.messages);
      const hasMore = payload.hasMore === true || payload.messages.length === safePageSize;
      if (!hasMore) return messages;
      const nextCursor = validateClientCursor(payload.nextCursor || payload.messages.at(-1)?.cursor);
      if (seenCursors.has(nextCursor)) {
        throw new BridgeClientError('pagination_loop', 'The Messages scan repeated an exact cursor.');
      }
      seenCursors.add(nextCursor);
      afterCursor = nextCursor;
    }
    throw new BridgeClientError('pagination_limit', 'The Messages scan exceeded the local pagination safety limit.');
  }

  async function ledgerState() {
    const { payload, response } = await requestJson(`${bridgeUrl}/ledger`, {}, fetchImpl);
    if (!response.ok) throw errorFromResponse(payload, response, 'The local ledger state could not be read.');
    if (!payload?.snapshot || !isValidLedgerSnapshot(payload.snapshot, { allowLegacy: false })) {
      throw new BridgeClientError('invalid_response', 'The local ledger returned an invalid snapshot.', response.status);
    }
    return payload;
  }

  async function saveLedger(snapshot) {
    if (!isValidLedgerSnapshot(snapshot, { allowLegacy: true })) {
      throw new BridgeClientError('invalid_ledger_snapshot', 'The local ledger snapshot is invalid.');
    }
    const { payload, response } = await requestJson(`${bridgeUrl}/ledger`, {
      method: 'POST',
      body: JSON.stringify({ snapshot })
    }, fetchImpl);
    if (!response.ok) throw errorFromResponse(payload, response, 'The local ledger could not be saved.');
    return payload;
  }

  async function automationStatus() {
    const { payload, response } = await requestJson(`${bridgeUrl}/automation`, {}, fetchImpl);
    if (!response.ok) throw errorFromResponse(payload, response, 'Automatic ingestion status could not be read.');
    return payload;
  }

  async function setAutomationEnabled(enabled) {
    const { payload, response } = await requestJson(`${bridgeUrl}/automation`, {
      method: 'POST',
      body: JSON.stringify({ enabled: Boolean(enabled) })
    }, fetchImpl);
    if (!response.ok) throw errorFromResponse(payload, response, 'Automatic ingestion could not be changed.');
    return payload;
  }

  return { automationStatus, ledgerState, perform, saveLedger, scan, setAutomationEnabled, status };
}

