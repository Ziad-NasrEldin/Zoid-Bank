import { toISODate } from './harbor-recurring.js';

// The storage key is retained for compatibility with the original local cache and
// the native shell. The value stored at that key is now a v2 ledger snapshot.
export const LEDGER_STORAGE_KEY = 'harbor.test-ledger.v1';
export const LEDGER_SCHEMA_VERSION = 2;
export const LEDGER_VERSION = LEDGER_SCHEMA_VERSION;

const LEGACY_LEDGER_VERSION = 1;
const DURABLE_ARRAY_FIELDS = [
  'messages',
  'events',
  'reviewCandidates',
  'parserHistory',
  'auditLog',
  'resetHistory',
  'migrationHistory'
];
const OUTCOME_KEYS = ['approved', 'review', 'ignored', 'duplicate', 'failed', 'other'];
const APPEND_ONLY_HISTORY_FIELDS = new Set([
  'parserHistory',
  'auditLog',
  'resetHistory',
  'migrationHistory',
  'decisionHistory',
  'editHistory',
  'correctionHistory',
  'observations'
]);

export class LedgerSnapshotError extends Error {
  constructor(message = 'The ledger snapshot is invalid.') {
    super(message);
    this.name = 'LedgerSnapshotError';
    this.code = 'invalid_ledger_snapshot';
  }
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRecordArray(value) {
  return Array.isArray(value) && value.every(isRecord);
}

function isMessageIdArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' || (typeof item === 'number' && Number.isSafeInteger(item)));
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '').map(String))];
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceIdsForRecord(record = {}) {
  return uniqueStrings([
    record.sourceId,
    ...(Array.isArray(record.sourceIds) ? record.sourceIds : [])
  ]);
}

function transactionKeyForRecord(record = {}) {
  return String(record.transactionKey || record.fingerprint || record.transactionFingerprint || '').trim();
}

function deriveTransactionKey(record = {}) {
  const dateValue = toISODate(record.dateValue || record.occurredAt || record.date || record.receivedAt);
  const merchant = String(record.merchant || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const amount = Number(record.amount);
  const direction = String(record.direction || '');
  if (!dateValue || !merchant || /^unresolved\b/i.test(merchant) || !Number.isFinite(amount) || amount <= 0 || !['debit', 'credit'].includes(direction)) return '';
  return [
    'transaction-v1',
    record.evidenceType || 'production',
    record.senderProfileId || 'unknown-sender',
    direction,
    String(record.currency || 'EGP').toUpperCase(),
    amount.toFixed(2),
    dateValue,
    merchant
  ].join('|');
}

function isSyntheticRecord(record = {}) {
  return record.evidenceType === 'synthetic'
    || record.sourceType === 'synthetic'
    || /harbor-test-bank|harbor-test-/i.test([
      record.sourceId,
      ...(Array.isArray(record.sourceIds) ? record.sourceIds : []),
      record.senderProfileId,
      record.senderProfileName,
      record.sender
    ].filter(Boolean).join(' '));
}

function recordKey(record, field, index = 0) {
  if (record === null || record === undefined) return `empty:${index}`;
  if (!isRecord(record)) return `value:${String(record)}`;
  if (field === 'messages') {
    if (record.sourceId) return `source:${String(record.sourceId)}`;
    if (record.id) return `id:${String(record.id)}`;
  }
  if (field === 'messageIds') return `value:${String(record)}`;
  if ((field === 'events' || field === 'reviewCandidates') && transactionKeyForRecord(record)) {
    return `transaction:${transactionKeyForRecord(record)}`;
  }
  if ((field === 'events' || field === 'reviewCandidates')) {
    const sourceIds = sourceIdsForRecord(record).sort();
    if (sourceIds.length) return `source:${sourceIds.join('|')}`;
  }
  if ((field === 'auditLog' || field === 'migrationHistory') && record.type === 'ledger_migrated') {
    const details = record.details || {};
    return `migration:${details.fromVersion || 'unknown'}:${details.toVersion || 'unknown'}:${stableSerialize({
      preservedEventIds: details.preservedEventIds || [],
      preservedCandidateIds: details.preservedCandidateIds || [],
      preservedMessageIds: details.preservedMessageIds || []
    })}`;
  }
  if (record.id) return `id:${String(record.id)}`;
  if (Number.isInteger(record.sequence)) return `sequence:${record.sequence}`;
  const sourceIds = sourceIdsForRecord(record);
  if (sourceIds.length) return `source:${sourceIds.join('|')}`;
  return `record:${stableSerialize(record)}`;
}

function recordPriority(record) {
  if (!record) return 0;
  if (record.status === 'approved' || record.decision?.mode === 'manual') return 4;
  if (record.status === 'dismissed') return 3;
  if (record.status === 'auto_approved' || record.status === 'approved_automatically') return 3;
  if (record.status === 'needs_review' || record.status === 'review') return 2;
  if (record.status === 'ignored') return 1;
  return 0;
}

function recordFreshness(record = {}) {
  const histories = ['parserHistory', 'decisionHistory', 'editHistory', 'correctionHistory', 'observations'];
  const sequence = Math.max(
    Number.isSafeInteger(record.sequence) ? record.sequence : 0,
    ...histories.flatMap((field) => (Array.isArray(record[field]) ? record[field] : []))
      .map((entry) => Number.isSafeInteger(entry?.sequence) ? entry.sequence : 0)
  );
  const timestamps = [
    record.updatedAt,
    record.editedAt,
    record.resolvedAt,
    record.dismissedAt,
    record.supersededAt,
    ...histories.flatMap((field) => (Array.isArray(record[field]) ? record[field] : []))
      .flatMap((entry) => [entry?.occurredAt, entry?.editedAt, entry?.createdAt])
  ].filter(Boolean).map(String).sort();
  return { sequence, timestamp: timestamps.at(-1) || '' };
}

function preferRecord(left, right) {
  const priorityDifference = recordPriority(left) - recordPriority(right);
  if (priorityDifference) return priorityDifference > 0 ? left : right;
  const leftFreshness = recordFreshness(left);
  const rightFreshness = recordFreshness(right);
  if (leftFreshness.sequence !== rightFreshness.sequence) {
    return leftFreshness.sequence > rightFreshness.sequence ? left : right;
  }
  if (leftFreshness.timestamp !== rightFreshness.timestamp) {
    return leftFreshness.timestamp > rightFreshness.timestamp ? left : right;
  }
  return left;
}

function mergeValues(preferred, fallback, field = '') {
  if (preferred === undefined || preferred === null || preferred === '') return clone(fallback);
  if (fallback === undefined || fallback === null || fallback === '') return clone(preferred);
  if (Array.isArray(preferred) && Array.isArray(fallback)) {
    return mergeArrayValues(preferred, fallback, field);
  }
  if (isRecord(preferred) && isRecord(fallback)) {
    const merged = {};
    const keys = new Set([...Object.keys(fallback), ...Object.keys(preferred)]);
    keys.forEach((key) => {
      merged[key] = mergeValues(preferred[key], fallback[key], key);
    });
    return merged;
  }
  return clone(preferred);
}

function compareHistoryRecords(left, right) {
  const leftSequence = Number.isSafeInteger(left?.sequence) ? left.sequence : Number.MAX_SAFE_INTEGER;
  const rightSequence = Number.isSafeInteger(right?.sequence) ? right.sequence : Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  const leftTime = String(left?.occurredAt || left?.editedAt || left?.createdAt || '');
  const rightTime = String(right?.occurredAt || right?.editedAt || right?.createdAt || '');
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;
  const leftId = String(left?.id || '');
  const rightId = String(right?.id || '');
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  const leftSerialized = stableSerialize(left);
  const rightSerialized = stableSerialize(right);
  return leftSerialized < rightSerialized ? -1 : leftSerialized > rightSerialized ? 1 : 0;
}

function mergeArrayValues(preferred, fallback, field = '') {
  const values = [...fallback, ...preferred];
  const byKey = new Map();
  values.forEach((value, index) => {
    const key = recordKey(value, field, index);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, clone(value));
      return;
    }
    byKey.set(key, mergeValues(value, existing, field));
  });
  const merged = [...byKey.values()];
  return APPEND_ONLY_HISTORY_FIELDS.has(field) ? merged.sort(compareHistoryRecords) : merged;
}

function mergeRecord(preferred, fallback, field) {
  const preferredRecord = preferRecord(preferred, fallback);
  const fallbackRecord = preferredRecord === preferred ? fallback : preferred;
  const merged = mergeValues(preferredRecord, fallbackRecord, field);
  if (field === 'events' || field === 'reviewCandidates') {
    const sourceIds = uniqueStrings([
      ...sourceIdsForRecord(preferredRecord),
      ...sourceIdsForRecord(fallbackRecord),
      ...sourceIdsForRecord(merged)
    ]);
    if (sourceIds.length) {
      merged.sourceIds = sourceIds.sort();
      merged.sourceId = preferredRecord.sourceId || fallbackRecord.sourceId || merged.sourceIds[0];
    }
    merged.transactionKey = merged.transactionKey || transactionKeyForRecord(preferredRecord) || transactionKeyForRecord(fallbackRecord);
  }
  return merged;
}

function mergeRecordArrays(localValues, remoteValues, field) {
  const byKey = new Map();
  for (const value of remoteValues || []) {
    byKey.set(recordKey(value, field, byKey.size), clone(value));
  }
  for (const value of localValues || []) {
    const key = recordKey(value, field, byKey.size);
    const existing = byKey.get(key);
    byKey.set(key, existing === undefined ? clone(value) : mergeRecord(value, existing, field));
  }
  return [...byKey.values()];
}

function normalizeLegacyMessages(snapshot) {
  const messages = [];
  const bySourceId = new Map();
  const add = (record) => {
    const sourceId = String(record?.sourceId || record?.id || '').trim();
    if (!sourceId) return;
    const normalized = {
      ...clone(record),
      id: record.id || `message-${sourceId}`,
      sourceId,
      sourceIds: uniqueStrings([...(Array.isArray(record.sourceIds) ? record.sourceIds : []), sourceId]),
      active: record.active !== false,
      evidenceType: record.evidenceType || (isSyntheticRecord({ ...record, sourceId }) ? 'synthetic' : 'production'),
      parserHistory: Array.isArray(record.parserHistory) ? clone(record.parserHistory) : [],
      observations: Array.isArray(record.observations) ? clone(record.observations) : []
    };
    const existing = bySourceId.get(sourceId);
    const merged = existing === undefined ? normalized : mergeRecord(normalized, existing, 'messages');
    bySourceId.set(sourceId, merged);
  };

  (Array.isArray(snapshot.messages) ? snapshot.messages : []).forEach(add);
  const addLinkedMessage = (record, sourceId, link) => add({
    id: `message-${sourceId}`,
    sourceId,
    sender: record.sender,
    senderProfileId: record.senderProfileId,
    senderProfileName: record.senderProfileName,
    parserVersion: record.parserVersion,
    receivedAt: record.receivedAt,
    originalMessage: record.originalMessage || '',
    status: record.status || (link === 'event' ? 'auto_approved' : 'needs_review'),
    transactionKey: record.transactionKey,
    active: record.active,
    evidenceType: record.evidenceType,
    ...(link === 'event' ? { linkedEventId: record.id } : { linkedCandidateId: record.id })
  });
  (Array.isArray(snapshot.events) ? snapshot.events : []).forEach((event) => {
    sourceIdsForRecord(event).forEach((sourceId) => addLinkedMessage(event, sourceId, 'event'));
  });
  (Array.isArray(snapshot.reviewCandidates) ? snapshot.reviewCandidates : []).forEach((candidate) => {
    sourceIdsForRecord(candidate).forEach((sourceId) => addLinkedMessage(candidate, sourceId, 'candidate'));
  });
  uniqueStrings(snapshot.messageIds || []).forEach((sourceId) => {
    if (bySourceId.has(sourceId)) return;
    add({
      id: `message-${sourceId}`,
      sourceId,
      status: 'ignored',
      parserVersion: 'legacy-unknown',
      needsReprocess: true,
      active: true,
      evidenceType: isSyntheticRecord({ sourceId }) ? 'synthetic' : 'production'
    });
  });
  messages.push(...bySourceId.values());
  return messages;
}

function maxSequence(snapshot) {
  let maximum = Number.isSafeInteger(snapshot?.nextSequence) && snapshot.nextSequence > 0
    ? snapshot.nextSequence - 1
    : 0;
  for (const field of [...DURABLE_ARRAY_FIELDS, 'allEvents', 'allReviewCandidates']) {
    for (const record of Array.isArray(snapshot?.[field]) ? snapshot[field] : []) {
      if (Number.isSafeInteger(record?.sequence)) maximum = Math.max(maximum, record.sequence);
    }
  }
  return maximum;
}

function hasMigrationRecord(snapshot) {
  return (snapshot.migrationHistory || []).some((entry) => entry?.type === 'ledger_migrated'
    && Number(entry?.details?.toVersion) === LEDGER_SCHEMA_VERSION);
}

function migrateLegacySnapshot(input) {
  const source = clone(input);
  const normalizeEvents = (records) => records.map((inputRecord) => {
    const event = { ...clone(inputRecord) };
    event.sourceIds = sourceIdsForRecord(event);
    if (!event.sourceId && event.sourceIds[0]) event.sourceId = event.sourceIds[0];
    event.active = event.active !== false;
    event.evidenceType = event.evidenceType || (isSyntheticRecord(event) ? 'synthetic' : 'production');
    event.sourceType = event.sourceType || 'bank';
    event.decisionHistory = Array.isArray(event.decisionHistory)
      ? clone(event.decisionHistory)
      : event.decision ? [clone(event.decision)] : [];
    event.correctionHistory = Array.isArray(event.correctionHistory) ? clone(event.correctionHistory) : [];
    event.transactionKey = transactionKeyForRecord(event) || deriveTransactionKey(event) || undefined;
    return event;
  });
  const normalizeCandidates = (records) => records.map((inputRecord) => {
    const candidate = { ...clone(inputRecord) };
    candidate.sourceIds = sourceIdsForRecord(candidate);
    if (!candidate.sourceId && candidate.sourceIds[0]) candidate.sourceId = candidate.sourceIds[0];
    candidate.active = candidate.active !== false && candidate.status !== 'approved';
    candidate.status = candidate.status || 'needs_review';
    candidate.evidenceType = candidate.evidenceType || (isSyntheticRecord(candidate) ? 'synthetic' : 'production');
    candidate.sourceType = candidate.sourceType || 'bank';
    candidate.editHistory = Array.isArray(candidate.editHistory) ? clone(candidate.editHistory) : [];
    candidate.transactionKey = transactionKeyForRecord(candidate) || deriveTransactionKey(candidate) || undefined;
    return candidate;
  });
  const snapshot = {
    ...source,
    version: LEDGER_SCHEMA_VERSION,
    nextSequence: Number.isSafeInteger(source.nextSequence) && source.nextSequence > 0 ? source.nextSequence : 1,
    messageIds: uniqueStrings(source.messageIds || []),
    messages: normalizeLegacyMessages(source),
    events: normalizeEvents(Array.isArray(source.events) ? source.events : []),
    reviewCandidates: normalizeCandidates(Array.isArray(source.reviewCandidates) ? source.reviewCandidates : []),
    parserHistory: Array.isArray(source.parserHistory) ? clone(source.parserHistory) : [],
    auditLog: Array.isArray(source.auditLog) ? clone(source.auditLog) : [],
    resetHistory: Array.isArray(source.resetHistory) ? clone(source.resetHistory) : [],
    migrationHistory: Array.isArray(source.migrationHistory) ? clone(source.migrationHistory) : []
  };
  const usedSequences = new Set();
  let nextSequence = Number.isSafeInteger(snapshot.nextSequence) && snapshot.nextSequence > 0 ? snapshot.nextSequence : 1;
  for (const field of ['events', 'reviewCandidates', 'messages']) {
    for (const record of snapshot[field]) {
      let sequence = Number(record.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1 || usedSequences.has(sequence)) {
        while (usedSequences.has(nextSequence)) nextSequence += 1;
        sequence = nextSequence;
      }
      usedSequences.add(sequence);
      nextSequence = Math.max(nextSequence, sequence + 1);
      record.sequence = sequence;
    }
  }
  const linkedMessageIds = [
    ...snapshot.messages.map((message) => message.sourceId),
    ...snapshot.events.flatMap(sourceIdsForRecord),
    ...snapshot.reviewCandidates.flatMap(sourceIdsForRecord)
  ];
  snapshot.messageIds = uniqueStrings([...snapshot.messageIds, ...linkedMessageIds]);
  if (!hasMigrationRecord(snapshot)) {
    const sequence = Math.max(maxSequence(snapshot) + 1, nextSequence, snapshot.nextSequence || 1);
    const audit = {
      id: `audit-${sequence}`,
      sequence,
      type: 'ledger_migrated',
      occurredAt: new Date().toISOString(),
      details: {
        fromVersion: source.version || LEGACY_LEDGER_VERSION,
        toVersion: LEDGER_SCHEMA_VERSION,
        preservedEventIds: snapshot.events.map((event) => event.id).filter(Boolean),
        preservedCandidateIds: snapshot.reviewCandidates.map((candidate) => candidate.id).filter(Boolean),
        preservedMessageIds: snapshot.messageIds,
        syntheticSourceIds: uniqueStrings([
          ...snapshot.events.filter(isSyntheticRecord).flatMap(sourceIdsForRecord),
          ...snapshot.reviewCandidates.filter(isSyntheticRecord).flatMap(sourceIdsForRecord),
          ...snapshot.messages.filter(isSyntheticRecord).map((message) => message.sourceId)
        ]),
        removed: []
      }
    };
    snapshot.auditLog.push(audit);
    snapshot.migrationHistory.push({ ...clone(audit), details: clone(audit.details) });
    snapshot.nextSequence = sequence + 1;
  } else {
    snapshot.nextSequence = Math.max(snapshot.nextSequence || 1, nextSequence, maxSequence(snapshot) + 1);
  }
  return snapshot;
}

function normalizeV2Snapshot(input) {
  const snapshot = {
    ...clone(input),
    version: LEDGER_SCHEMA_VERSION,
    nextSequence: input.nextSequence,
    messageIds: uniqueStrings(input.messageIds),
    messages: clone(input.messages),
    events: clone(input.events),
    reviewCandidates: clone(input.reviewCandidates),
    parserHistory: clone(input.parserHistory),
    auditLog: clone(input.auditLog),
    resetHistory: clone(input.resetHistory),
    migrationHistory: clone(input.migrationHistory)
  };
  snapshot.nextSequence = Math.max(input.nextSequence, maxSequence(snapshot) + 1);
  return snapshot;
}

function validateSnapshotShape(input, { allowLegacy = true } = {}) {
  if (!isRecord(input)) throw new LedgerSnapshotError('The ledger snapshot must be an object.');
  const version = input.version === undefined ? LEGACY_LEDGER_VERSION : input.version;
  if (version === LEGACY_LEDGER_VERSION && allowLegacy) {
    if (!isMessageIdArray(input.messageIds) || !isRecordArray(input.events) || !isRecordArray(input.reviewCandidates)) {
      throw new LedgerSnapshotError('The legacy ledger snapshot is missing required arrays.');
    }
    return version;
  }
  if (version !== LEDGER_SCHEMA_VERSION) {
    throw new LedgerSnapshotError(`Unsupported ledger snapshot version: ${version}.`);
  }
  if (!Number.isSafeInteger(input.nextSequence) || input.nextSequence < 1) {
    throw new LedgerSnapshotError('The v2 ledger snapshot nextSequence must be a positive integer.');
  }
  if (!isMessageIdArray(input.messageIds)) {
    throw new LedgerSnapshotError('The v2 ledger snapshot messageIds must be an array.');
  }
  for (const field of DURABLE_ARRAY_FIELDS) {
    if (!isRecordArray(input[field])) throw new LedgerSnapshotError(`The v2 ledger snapshot ${field} must be an array of records.`);
  }
  return version;
}

export function normalizeLedgerSnapshotResult(input, { allowLegacy = true, allowEmpty = false } = {}) {
  if ((input === null || input === undefined) && allowEmpty) {
    return { snapshot: createEmptyLedgerSnapshot(), migrated: false };
  }
  const version = validateSnapshotShape(input, { allowLegacy });
  if (version === LEGACY_LEDGER_VERSION) return { snapshot: migrateLegacySnapshot(input), migrated: true };
  return { snapshot: normalizeV2Snapshot(input), migrated: false };
}

export function normalizeLedgerSnapshot(input, options = {}) {
  return normalizeLedgerSnapshotResult(input, options).snapshot;
}

export function migrateLedgerSnapshot(input) {
  return normalizeLedgerSnapshot(input, { allowLegacy: true });
}

export function createEmptyLedgerSnapshot() {
  return {
    version: LEDGER_SCHEMA_VERSION,
    nextSequence: 1,
    messageIds: [],
    messages: [],
    events: [],
    reviewCandidates: [],
    parserHistory: [],
    auditLog: [],
    resetHistory: [],
    migrationHistory: []
  };
}

export function isValidLedgerSnapshot(input, options = {}) {
  try {
    normalizeLedgerSnapshotResult(input, options);
    return true;
  } catch {
    return false;
  }
}

function round(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * multiplier) / multiplier;
}

function formatLedgerDate(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function parseAmount(value) {
  const normalized = typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.abs(amount) : null;
}

export function normalizeReviewEdits(candidate, input = {}) {
  if (!candidate) throw new Error('The review item is no longer available locally.');

  const merchant = String(input.merchant ?? candidate.merchant ?? '').trim();
  if (!merchant) throw new Error('Merchant is required before approval.');
  if (merchant.length > 120) throw new Error('Merchant must be 120 characters or fewer.');

  const amount = parseAmount(input.amount ?? candidate.amount);
  if (!amount || amount <= 0) throw new Error('Amount must be greater than zero.');

  const isoDate = toISODate(input.date ?? candidate.date);
  if (!isoDate) throw new Error('Enter a valid transaction date.');

  const category = String(input.category ?? candidate.category ?? '').trim();
  if (!category) throw new Error('Category is required before approval.');
  if (category.length > 80) throw new Error('Category must be 80 characters or fewer.');

  return {
    ...clone(candidate),
    merchant,
    amount: round(amount),
    date: formatLedgerDate(isoDate),
    category,
    editedAt: input.editedAt || new Date().toISOString()
  };
}

export function updateReviewCandidateSnapshot(snapshot, candidateId, input = {}) {
  const next = normalizeLedgerSnapshot(snapshot, { allowLegacy: true });
  const index = next.reviewCandidates.findIndex((candidate) => candidate.id === candidateId);
  if (index < 0) throw new Error('The review item is no longer available locally.');
  next.reviewCandidates[index] = normalizeReviewEdits(next.reviewCandidates[index], input);
  if (Array.isArray(next.allReviewCandidates)) next.allReviewCandidates = next.reviewCandidates.map(clone);
  return next;
}

function arrayFromSnapshot(snapshot, field, derivedField) {
  const direct = Array.isArray(snapshot?.[field]) ? snapshot[field] : [];
  const derived = Array.isArray(snapshot?.[derivedField]) ? snapshot[derivedField] : [];
  return mergeRecordArrays(direct, derived, field);
}

export function mergeLedgerSnapshots(localSnapshot = {}, remoteSnapshot = {}) {
  const localInput = isRecord(localSnapshot) && Object.keys(localSnapshot).length
    ? localSnapshot
    : createEmptyLedgerSnapshot();
  const remoteInput = isRecord(remoteSnapshot) && Object.keys(remoteSnapshot).length
    ? remoteSnapshot
    : createEmptyLedgerSnapshot();
  const local = normalizeLedgerSnapshot(localInput, { allowLegacy: true });
  const remote = normalizeLedgerSnapshot(remoteInput, { allowLegacy: true });
  const merged = mergeValues(local, remote);
  merged.version = LEDGER_SCHEMA_VERSION;

  merged.messages = mergeRecordArrays(local.messages, remote.messages, 'messages');
  merged.events = mergeRecordArrays(
    arrayFromSnapshot(local, 'events', 'allEvents'),
    arrayFromSnapshot(remote, 'events', 'allEvents'),
    'events'
  );
  const mergedCandidates = mergeRecordArrays(
    arrayFromSnapshot(local, 'reviewCandidates', 'allReviewCandidates'),
    arrayFromSnapshot(remote, 'reviewCandidates', 'allReviewCandidates'),
    'reviewCandidates'
  );
  const candidateEvidence = [];
  for (const candidate of mergedCandidates) {
    if (candidate.active === false) {
      candidateEvidence.push(candidate);
      continue;
    }
    const candidateSources = new Set(sourceIdsForRecord(candidate));
    const eventIndex = merged.events.findIndex((event) => {
      const sameTransaction = transactionKeyForRecord(candidate)
        && transactionKeyForRecord(candidate) === transactionKeyForRecord(event);
      const sharesSource = sourceIdsForRecord(event).some((sourceId) => candidateSources.has(sourceId));
      return sameTransaction || sharesSource;
    });
    if (eventIndex < 0) {
      candidateEvidence.push(candidate);
      continue;
    }
    // An approved event wins the active queue entry, but the candidate's
    // edit/decision evidence and source identities remain append-only on it.
    merged.events[eventIndex] = mergeRecord(merged.events[eventIndex], candidate, 'events');
  }
  const finalEventSources = new Set(merged.events.flatMap(sourceIdsForRecord));
  const finalEventTransactionKeys = new Set(merged.events.map(transactionKeyForRecord).filter(Boolean));
  merged.reviewCandidates = candidateEvidence.filter((candidate) => {
    if (candidate.active === false) return true;
    return !sourceIdsForRecord(candidate).some((sourceId) => finalEventSources.has(sourceId))
      && !finalEventTransactionKeys.has(transactionKeyForRecord(candidate));
  });
  for (const field of ['parserHistory', 'auditLog', 'resetHistory', 'migrationHistory']) {
    merged[field] = mergeRecordArrays(local[field], remote[field], field);
  }
  merged.messageIds = uniqueStrings([
    ...local.messageIds,
    ...remote.messageIds,
    ...merged.messages.map((message) => message.sourceId),
    ...merged.events.flatMap(sourceIdsForRecord),
    ...merged.reviewCandidates.flatMap(sourceIdsForRecord)
  ]);
  merged.nextSequence = Math.max(
    Number(local.nextSequence) || 1,
    Number(remote.nextSequence) || 1,
    maxSequence(merged) + 1
  );
  if (Array.isArray(local.allEvents) || Array.isArray(remote.allEvents)) merged.allEvents = clone(merged.events);
  else delete merged.allEvents;
  if (Array.isArray(local.allReviewCandidates) || Array.isArray(remote.allReviewCandidates)) merged.allReviewCandidates = clone(merged.reviewCandidates);
  else delete merged.allReviewCandidates;
  return merged;
}

function transactionTime(item) {
  const date = toISODate(item?.dateValue || item?.date || item?.meta || item?.occurredAt || item?.receivedAt);
  const dateTime = date ? Date.parse(`${date}T12:00:00Z`) : 0;
  const receivedTime = item?.receivedAt ? Date.parse(item.receivedAt) : 0;
  return { dateTime: Number.isFinite(dateTime) ? dateTime : 0, receivedTime: Number.isFinite(receivedTime) ? receivedTime : 0 };
}

export function sortTransactionRecords(items = []) {
  return items.slice().sort((left, right) => {
    const leftTime = transactionTime(left);
    const rightTime = transactionTime(right);
    return rightTime.dateTime - leftTime.dateTime
      || rightTime.receivedTime - leftTime.receivedTime
      || String(right.id || '').localeCompare(String(left.id || ''));
  });
}

function outcomeKey(kind) {
  if (kind === 'auto_approved' || kind === 'approved') return 'approved';
  if (kind === 'needs_review') return 'review';
  if (kind === 'ignored') return 'ignored';
  if (kind === 'duplicate') return 'duplicate';
  if (kind === 'failed') return 'failed';
  return 'other';
}

export function summarizeScanCounts(inputCounts = {}, total = 0) {
  const counts = Object.fromEntries(OUTCOME_KEYS.map((key) => [key, Number(inputCounts[key]) || 0]));
  const accounted = OUTCOME_KEYS.reduce((sum, key) => sum + counts[key], 0);
  const scanned = Number.isInteger(total) && total >= 0 ? total : accounted;
  const unaccounted = Math.max(0, scanned - accounted);
  const parts = [
    `${counts.approved} approved`,
    `${counts.review} sent to review`,
    `${counts.ignored} ignored`,
    `${counts.duplicate} already recorded`
  ];
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.other) parts.push(`${counts.other} unclassified`);
  if (unaccounted) parts.push(`${unaccounted} not processed`);
  return {
    total: scanned,
    accounted,
    complete: accounted === scanned,
    unaccounted,
    counts,
    text: `Scanned ${scanned} local alerts: ${parts.join(', ')}. ${accounted} of ${scanned} outcomes accounted for.`
  };
}

export function summarizeScanResults(results = [], total = results.length) {
  const counts = Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0]));
  results.forEach((result) => { counts[outcomeKey(result?.kind)] += 1; });
  return summarizeScanCounts(counts, total);
}
