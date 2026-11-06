import { unlinkSync } from 'node:fs';

import { createHarborLedger, createMemoryStorage } from './harbor-ledger.js';
import {
  createEmptyLedgerSnapshot,
  LEDGER_STORAGE_KEY,
  mergeLedgerSnapshots,
  normalizeLedgerSnapshot,
  summarizeScanCounts
} from './harbor-ledger-sync.js';
import {
  atomicWriteText,
  backupPathFor,
  createFileStorage,
  defaultAutomationConfigPath,
  defaultLedgerPath,
  readJsonFile,
  readText
} from './harbor-ledger-store.mjs';

const AUTOMATION_CONFIG_VERSION = 2;
const SOURCE_PAGE_SIZE = 500;
const MAX_SOURCE_PAGES = 100_000;
const CURSOR_PATTERN = /^\d+:\d+$/;
const INT64_MAX = (2n ** 63n) - 1n;

function errorMessage(error) {
  return error instanceof Error ? error.message : 'The background Messages scan failed.';
}

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

export function validateIngestionCursor(value) {
  if (value === null || value === undefined || value === '') return null;
  const cursor = String(value);
  if (cursor.length > 128 || !CURSOR_PATTERN.test(cursor)) {
    throw errorWithCode('invalid_cursor', 'The Messages cursor must be an exact dateNanoseconds:rowID value.');
  }
  const [dateNanoseconds, rowId] = cursor.split(':').map(BigInt);
  if (dateNanoseconds > INT64_MAX || rowId > INT64_MAX) {
    throw errorWithCode('invalid_cursor', 'The Messages cursor components must fit in signed Int64.');
  }
  return cursor;
}

function cursorParts(cursor) {
  const [dateNanoseconds, rowId] = cursor.split(':').map(BigInt);
  return { dateNanoseconds, rowId };
}

function cursorIsAfter(nextCursor, previousCursor) {
  if (!previousCursor) return true;
  const next = cursorParts(nextCursor);
  const previous = cursorParts(previousCursor);
  return next.dateNanoseconds > previous.dateNanoseconds
    || (next.dateNanoseconds === previous.dateNanoseconds && next.rowId > previous.rowId);
}

export function parserGenerationSignature(profiles = []) {
  return profiles
    .filter((profile) => profile && profile.id && profile.parserVersion)
    .map((profile) => `${String(profile.id)}=${String(profile.parserVersion)}`)
    .sort()
    .join(';');
}

function currentParserGeneration(profilesImpl = null, createLedgerImpl = createHarborLedger) {
  const ledger = createLedgerImpl(createMemoryStorage());
  const profiles = profilesImpl
    ? profilesImpl()
    : (typeof ledger.profiles === 'function' ? ledger.profiles() : []);
  return parserGenerationSignature(profiles);
}

function seedStorage(raw) {
  const storage = createMemoryStorage();
  const snapshot = raw === null || raw === undefined
    ? createEmptyLedgerSnapshot()
    : normalizeLedgerSnapshot(JSON.parse(raw), { allowLegacy: true });
  storage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(snapshot));
  return storage;
}

function messageSourceId(message) {
  return String(message?.id ?? '').trim();
}

function createMessageIndex(snapshot) {
  return new Map((snapshot.messages || []).map((record) => [String(record.sourceId || record.id || ''), clone(record)]));
}

function approvedSourceIds(snapshot) {
  return new Set((snapshot.events || []).filter((event) => event.active !== false).flatMap((event) => [
    event.sourceId,
    ...(Array.isArray(event.sourceIds) ? event.sourceIds : [])
  ].filter(Boolean).map(String)));
}

function isApprovedMessage(messageRecord, approvedSources) {
  if (!messageRecord) return false;
  if (['approved', 'auto_approved', 'approved_automatically'].includes(messageRecord.status)) return true;
  if (messageRecord.linkedEventId) return true;
  return approvedSources.has(String(messageRecord.sourceId || messageRecord.id || ''));
}

function ingestionDecision(messageIndex, approvedSources, message, parserChanged) {
  const sourceId = messageSourceId(message);
  const existing = messageIndex.get(sourceId);
  if (!existing && !approvedSources.has(sourceId)) return { ingest: true, reprocess: false };
  if (isApprovedMessage(existing || { sourceId }, approvedSources)) {
    return { ingest: false, kind: 'duplicate', skippedApproved: true };
  }
  if (parserChanged && ['ignored', 'needs_review', 'review'].includes(existing.status)) {
    return { ingest: true, reprocess: true };
  }
  return { ingest: false, kind: 'duplicate' };
}

function updateMessageIndex(messageIndex, approvedSources, message, result) {
  const sourceId = messageSourceId(message);
  if (!sourceId) return;
  const current = messageIndex.get(sourceId) || { id: `message-${sourceId}`, sourceId };
  if (result?.event) {
    current.status = result.event.status || (result.kind === 'approved' ? 'approved' : 'auto_approved');
    current.linkedEventId = result.event.id;
    approvedSources.add(sourceId);
  } else if (result?.candidate) {
    current.status = result.candidate.status || 'needs_review';
    current.linkedCandidateId = result.candidate.id;
  } else if (result?.kind === 'ignored') {
    current.status = 'ignored';
  }
  messageIndex.set(sourceId, current);
}

async function readSourceMessages({ readMessagesImpl, afterCursor, helperPath, databasePath, pageSize, onMessage }) {
  let total = 0;
  let cursor = afterCursor;
  const seenCursors = new Set(cursor ? [cursor] : []);

  for (let page = 0; page < MAX_SOURCE_PAGES; page += 1) {
    const pageMessages = await readMessagesImpl({
      afterCursor: cursor,
      sinceNs: cursor ? null : '0',
      limit: pageSize,
      exhaustive: true,
      helperPath,
      databasePath
    });
    if (!Array.isArray(pageMessages)) {
      throw errorWithCode('invalid_response', 'The Messages reader returned an invalid page.');
    }
    if (!pageMessages.length) return { total, cursor };

    let nextCursor = cursor;
    for (const message of pageMessages) {
      const messageCursor = validateIngestionCursor(message?.cursor);
      if (!messageCursor || !cursorIsAfter(messageCursor, nextCursor)) {
        throw errorWithCode('pagination_loop', 'The Messages reader returned a page that did not advance its exact cursor.');
      }
      nextCursor = messageCursor;
    }
    for (const message of pageMessages) {
      await onMessage(message);
      total += 1;
    }
    cursor = nextCursor;

    // The local bridge's exhaustive reader returns all remaining pages at once.
    // An injected page reader returns at most pageSize records and is continued here.
    if (pageMessages.length !== pageSize) return { total, cursor };
    if (seenCursors.has(nextCursor)) {
      throw errorWithCode('pagination_loop', 'The Messages reader repeated an exact cursor.');
    }
    seenCursors.add(nextCursor);
  }
  throw errorWithCode('pagination_limit', 'The Messages reader exceeded the local pagination safety limit.');
}

function readAuthoritativeSnapshot({ ledgerStorage, ledgerPath, readTextImpl }) {
  const raw = ledgerStorage.getItem(LEDGER_STORAGE_KEY);
  if (raw === null) {
    if (readTextImpl(backupPathFor(ledgerPath)) !== null) {
      throw errorWithCode('ledger_missing_backup_available', 'The authoritative ledger is missing while a backup exists. Recover it deliberately before writing.');
    }
    return { raw: null, snapshot: createEmptyLedgerSnapshot() };
  }
  try {
    return {
      raw,
      snapshot: normalizeLedgerSnapshot(JSON.parse(raw), { allowLegacy: true })
    };
  } catch (error) {
    const wrapped = errorWithCode('ledger_corrupt', error instanceof Error ? error.message : 'The authoritative ledger is corrupt and was not overwritten.');
    throw wrapped;
  }
}

function restoreLedger(ledgerStorage, raw) {
  if (raw === null || raw === undefined) ledgerStorage.removeItem(LEDGER_STORAGE_KEY);
  else ledgerStorage.setItem(LEDGER_STORAGE_KEY, raw);
}

function restoreConfig(configPath, raw, atomicWriteTextImpl, unlinkConfigImpl) {
  if (raw === null || raw === undefined) {
    try { unlinkConfigImpl(configPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  atomicWriteTextImpl(configPath, raw);
}

export function createBackgroundIngestor({
  readMessagesImpl,
  helperPath,
  databasePath,
  ledgerPath = defaultLedgerPath,
  configPath = defaultAutomationConfigPath,
  pollIntervalMs = 60_000,
  limit = SOURCE_PAGE_SIZE,
  defaultEnabled = process.env.HARBOR_AUTO_INGEST_ENABLED !== '0',
  hardDisabled = process.env.HARBOR_AUTO_INGEST_KILL_SWITCH === '1',
  ledgerStorage: providedLedgerStorage = null,
  readTextImpl = readText,
  atomicWriteTextImpl = atomicWriteText,
  unlinkConfigImpl = unlinkSync,
  parserProfilesImpl = null,
  parserGenerationImpl = null,
  createLedgerImpl = createHarborLedger
} = {}) {
  if (typeof readMessagesImpl !== 'function') throw new Error('A read-only Messages reader is required.');
  if (typeof createLedgerImpl !== 'function') throw new Error('A ledger factory is required.');
  const ledgerStorage = providedLedgerStorage || createFileStorage(ledgerPath);
  const savedConfig = readJsonFile(configPath) || {};
  const parserGeneration = parserGenerationImpl
    ? String(parserGenerationImpl())
    : currentParserGeneration(parserProfilesImpl, createLedgerImpl);
  const savedParserGeneration = typeof savedConfig.parserGeneration === 'string' ? savedConfig.parserGeneration : null;
  let savedCursor = null;
  let cursorInvalid = false;
  try {
    savedCursor = validateIngestionCursor(savedConfig.cursor);
  } catch {
    cursorInvalid = true;
  }
  const configBackfillComplete = savedConfig.backfillComplete === true;
  const parserChanged = configBackfillComplete && savedParserGeneration !== parserGeneration;
  const backfillRequired = !configBackfillComplete || parserChanged || cursorInvalid;
  const backfillReason = cursorInvalid
    ? 'invalid_cursor'
    : !configBackfillComplete
      ? 'initial'
      : parserChanged
        ? 'parser_generation_changed'
        : null;
  let enabled = hardDisabled ? false : typeof savedConfig.enabled === 'boolean' ? savedConfig.enabled : defaultEnabled;
  let timer = null;
  let inFlight = false;
  const state = {
    enabled,
    hardDisabled,
    running: false,
    cursor: savedCursor,
    backfillComplete: !backfillRequired,
    backfillRequired,
    backfillReason,
    parserGeneration,
    storedParserGeneration: savedParserGeneration,
    lastSuccessfulAt: savedConfig.lastSuccessfulAt || null,
    lastScanAt: null,
    lastSummary: null,
    lastError: null
  };
  const pageSize = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, SOURCE_PAGE_SIZE) : SOURCE_PAGE_SIZE;

  function status() {
    return {
      ...clone(state),
      timerActive: Boolean(timer),
      ledgerPath,
      intervalMs: pollIntervalMs
    };
  }

  function configPayload(overrides = {}) {
    return {
      version: AUTOMATION_CONFIG_VERSION,
      enabled,
      cursor: state.cursor,
      backfillComplete: state.backfillComplete,
      parserGeneration: state.storedParserGeneration,
      lastSuccessfulAt: state.lastSuccessfulAt,
      ...overrides
    };
  }

  function persistConfig(overrides = {}) {
    atomicWriteTextImpl(configPath, JSON.stringify(configPayload(overrides), null, 2));
  }

  function commitScan({ snapshot, cursor: nextCursor, backfillComplete, baseRaw }) {
    // Re-read and merge immediately before writing. Everything after this read
    // is synchronous, so a bridge POST cannot slip between the read and write.
    const latest = readAuthoritativeSnapshot({ ledgerStorage, ledgerPath, readTextImpl });
    // The file was re-read after staging, so its same-record fields are newer
    // than the staged copy. New staged records and histories are still unioned.
    const committedSnapshot = latest.raw === baseRaw
      ? snapshot
      : mergeLedgerSnapshots(latest.snapshot, snapshot);
    const beforeLedgerRaw = latest.raw;
    const beforeBackupRaw = providedLedgerStorage ? null : readTextImpl(backupPathFor(ledgerPath));
    const beforeConfigRaw = readTextImpl(configPath);
    const successfulAt = new Date().toISOString();
    const nextConfig = configPayload({
      cursor: nextCursor,
      backfillComplete,
      parserGeneration: parserGeneration,
      lastSuccessfulAt: successfulAt
    });
    try {
      ledgerStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(committedSnapshot));
      atomicWriteTextImpl(configPath, JSON.stringify(nextConfig, null, 2));
    } catch (error) {
      try {
        restoreLedger(ledgerStorage, beforeLedgerRaw);
        if (!providedLedgerStorage) {
          if (beforeBackupRaw === null) {
            try { unlinkConfigImpl(backupPathFor(ledgerPath)); } catch (unlinkError) {
              if (unlinkError?.code !== 'ENOENT') throw unlinkError;
            }
          } else {
            atomicWriteTextImpl(backupPathFor(ledgerPath), beforeBackupRaw, { preserveBackup: false });
          }
        }
        restoreConfig(configPath, beforeConfigRaw, atomicWriteTextImpl, unlinkConfigImpl);
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    }
    state.cursor = nextCursor;
    state.backfillComplete = backfillComplete;
    state.backfillRequired = !backfillComplete;
    state.backfillReason = null;
    state.storedParserGeneration = parserGeneration;
    state.lastSuccessfulAt = successfulAt;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    state.running = false;
    return status();
  }

  async function scanNow() {
    if (!enabled || hardDisabled || inFlight) return status();
    inFlight = true;
    state.running = true;
    state.lastError = null;
    const scanIsBackfill = state.backfillRequired;
    const parserChangedForScan = scanIsBackfill
      && state.storedParserGeneration !== state.parserGeneration;
    try {
      const initial = readAuthoritativeSnapshot({ ledgerStorage, ledgerPath, readTextImpl });
      const stagedStorage = seedStorage(initial.raw);
      // A scan is committed atomically once at the end. Serializing the entire
      // growing ledger after every message makes a large first backfill
      // quadratic and can keep the local service busy for minutes.
      const stagedLedger = createLedgerImpl(stagedStorage, { autoPersist: false });
      const messageIndex = createMessageIndex(initial.snapshot);
      const approvedSources = approvedSourceIds(initial.snapshot);
      const counts = { approved: 0, review: 0, ignored: 0, duplicate: 0, failed: 0, other: 0 };
      const countResult = (kind) => {
        if (kind === 'auto_approved' || kind === 'approved') counts.approved += 1;
        else if (kind === 'needs_review' || kind === 'review') counts.review += 1;
        else if (kind === 'ignored') counts.ignored += 1;
        else if (kind === 'duplicate') counts.duplicate += 1;
        else if (kind === 'failed') counts.failed += 1;
        else counts.other += 1;
      };
      const source = await readSourceMessages({
        readMessagesImpl,
        afterCursor: scanIsBackfill ? null : state.cursor,
        helperPath,
        databasePath,
        pageSize,
        onMessage: async (message) => {
        const decision = ingestionDecision(messageIndex, approvedSources, message, parserChangedForScan);
        if (!decision.ingest) {
          countResult(decision.kind || 'duplicate');
          return;
        }
        try {
          const result = stagedLedger.ingest(message, {
            ...(decision.reprocess ? { reprocess: true, forceReprocess: true } : {}),
            compactResult: true
          });
          countResult(result?.kind || 'other');
          updateMessageIndex(messageIndex, approvedSources, message, result);
        } catch (error) {
          countResult('failed');
          throw error;
        }
        }
      });
      const stagedSnapshot = typeof stagedLedger.durableSnapshot === 'function'
        ? stagedLedger.durableSnapshot()
        : normalizeLedgerSnapshot(
          typeof stagedLedger.auditSnapshot === 'function'
            ? stagedLedger.auditSnapshot()
            : JSON.parse(stagedStorage.getItem(LEDGER_STORAGE_KEY)),
          { allowLegacy: true }
        );
      const nextCursor = source.cursor;
      const cursorChanged = nextCursor !== state.cursor;
      const shouldCommit = scanIsBackfill || source.total > 0 || cursorChanged;
      if (shouldCommit) commitScan({ snapshot: stagedSnapshot, cursor: nextCursor, backfillComplete: true, baseRaw: initial.raw });
      state.lastScanAt = new Date().toISOString();
      state.lastSummary = summarizeScanCounts(counts, source.total);
      state.lastError = null;
      return status();
    } catch (error) {
      state.lastError = errorMessage(error);
      state.lastSummary = null;
      return status();
    } finally {
      inFlight = false;
      state.running = false;
    }
  }

  function start() {
    if (timer || !enabled || hardDisabled) return status();
    timer = setInterval(() => { void scanNow(); }, pollIntervalMs);
    timer.unref?.();
    void scanNow();
    return status();
  }

  async function setEnabled(nextEnabled) {
    if (typeof nextEnabled !== 'boolean') throw new Error('Automatic ingestion enabled must be true or false.');
    if (hardDisabled && nextEnabled) throw new Error('Automatic ingestion is disabled by the local kill switch.');
    const previousEnabled = enabled;
    enabled = nextEnabled;
    state.enabled = enabled;
    try {
      persistConfig();
    } catch (error) {
      enabled = previousEnabled;
      state.enabled = previousEnabled;
      throw error;
    }
    if (enabled) start();
    else stop();
    return status();
  }

  return {
    scanNow,
    setEnabled,
    start,
    stop,
    status
  };
}
