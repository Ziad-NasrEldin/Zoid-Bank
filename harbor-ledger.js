const STORAGE_KEY = 'harbor.test-ledger.v1';
export const LEDGER_STORAGE_KEY = STORAGE_KEY;
export const LEDGER_VERSION = 2;

export class LedgerCorruptionError extends Error {
  constructor(message, { storageKey = STORAGE_KEY, cause = null } = {}) {
    super(message);
    this.name = 'LedgerCorruptionError';
    this.code = 'LEDGER_CORRUPT';
    this.storageKey = storageKey;
    if (cause) this.cause = cause;
  }
}

export const EVIDENCE_TYPES = Object.freeze({
  PRODUCTION: 'production',
  SYNTHETIC: 'synthetic'
});

export const TEST_BANK_PROFILE = {
  id: 'harbor-test-bank-debit-v1',
  displayName: 'Zoid Bank Test Bank',
  sender: '+201000001234',
  senders: ['+201000001234'],
  parserVersion: 'demo-debit-v1',
  autoApprove: true,
  kind: 'debit',
  evidenceType: EVIDENCE_TYPES.SYNTHETIC
};

export const REAL_BANK_PROFILES = [
  {
    id: 'bank-al-ahly',
    displayName: 'Bank Al Ahly',
    senders: ['BanK-AlAhly', 'Bank-AlAhly', 'Bank Al Ahly'],
    parserVersion: 'bank-al-ahly-ar-v2',
    autoApprove: true,
    kind: 'transactions',
    evidenceType: EVIDENCE_TYPES.PRODUCTION
  },
  {
    id: 'banque-misr',
    displayName: 'Banque Misr',
    senders: ['Banque Misr', 'Banque-Misr', 'BanqueMisr'],
    parserVersion: 'banque-misr-ar-v2',
    autoApprove: true,
    kind: 'transactions',
    evidenceType: EVIDENCE_TYPES.PRODUCTION
  }
];

const BANK_PROFILES = [TEST_BANK_PROFILE, ...REAL_BANK_PROFILES];

const defaultState = {
  version: LEDGER_VERSION,
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function normalizeDigits(value) {
  return String(value ?? '').replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = ARABIC_DIGITS.indexOf(digit);
    if (arabicIndex >= 0) return String(arabicIndex);
    const easternIndex = EASTERN_ARABIC_DIGITS.indexOf(digit);
    return easternIndex >= 0 ? String(easternIndex) : digit;
  });
}

function isoDateParts(date) {
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part, index) => index === 0 ? String(part).padStart(4, '0') : String(part).padStart(2, '0'));
}

function dateValueFromInput(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return isoDateParts(value).join('-');
  }
  const normalized = normalizeDigits(value).trim();
  if (!normalized || /^unresolved/i.test(normalized)) return null;

  let match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : isoDateParts(date).join('-');
  }

  match = normalized.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (match) {
    const date = new Date(`${match[3]}-${match[2]}-${match[1]}T12:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : isoDateParts(date).join('-');
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return isoDateParts(parsed).join('-');
}

function isPositiveAmount(value) {
  const amount = typeof value === 'number' ? value : numberFromCurrency(value);
  return Number.isFinite(amount) && amount > 0;
}

function isValidDirection(value) {
  return value === 'debit' || value === 'credit';
}

function normalizeMerchantForKey(value) {
  return normalizeDigits(String(value || ''))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isSyntheticRecord(record = {}) {
  const identity = [
    record.evidenceType,
    record.sourceType,
    record.sourceId,
    ...(record.sourceIds || []),
    record.senderProfileId,
    record.senderProfileName,
    record.sender
  ].filter(Boolean).join(' ');
  return record.evidenceType === EVIDENCE_TYPES.SYNTHETIC
    || record.sourceType === EVIDENCE_TYPES.SYNTHETIC
    || record.senderProfileId === TEST_BANK_PROFILE.id
    || /harbor-test-bank|harbor-test-/i.test(identity);
}

function evidenceTypeForMessage(message, profile) {
  return profile?.evidenceType
    || (isSyntheticRecord({ ...message, sourceId: message?.id }) ? EVIDENCE_TYPES.SYNTHETIC : EVIDENCE_TYPES.PRODUCTION);
}

function transactionKeyForRecord(record = {}) {
  const dateValue = dateValueFromInput(record.dateValue || record.occurredAt || record.date || record.receivedAt);
  const merchant = normalizeMerchantForKey(record.merchant);
  const amount = Number(record.amount);
  if (!dateValue || !merchant || /^unresolved\b/i.test(merchant) || !Number.isFinite(amount) || amount <= 0 || !isValidDirection(record.direction)) return null;
  return [
    'transaction-v1',
    record.evidenceType || EVIDENCE_TYPES.PRODUCTION,
    record.senderProfileId || 'unknown-sender',
    record.direction,
    String(record.currency || 'EGP').toUpperCase(),
    amount.toFixed(2),
    dateValue,
    merchant
  ].join('|');
}

function recordDateValue(record = {}) {
  return dateValueFromInput(record.dateValue || record.occurredAt || record.date || record.receivedAt);
}

function compareLedgerRecords(left, right) {
  const leftDate = recordDateValue(left);
  const rightDate = recordDateValue(right);
  if (leftDate !== rightDate) {
    if (!leftDate) return 1;
    if (!rightDate) return -1;
    const dateOrder = rightDate.localeCompare(leftDate);
    if (dateOrder !== 0) return dateOrder;
  }
  const sequenceOrder = Number(left.sequence || Number.MAX_SAFE_INTEGER) - Number(right.sequence || Number.MAX_SAFE_INTEGER);
  if (sequenceOrder !== 0) return sequenceOrder;
  return String(left.id || left.sourceId || '').localeCompare(String(right.id || right.sourceId || ''));
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value) !== '').map(String))];
}

function normalizeSourceIds(record = {}) {
  return uniqueStrings([...(record.sourceIds || []), record.sourceId]);
}

function normalizeSender(value) {
  const sender = String(value || '').trim().normalize('NFKC');
  if (/^[0-9٠-٩۰-۹+()\s.-]+$/.test(sender)) return sender.replace(/[^0-9٠-٩۰-۹+]/g, '');
  return sender.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');
}

function profileForSender(sender) {
  const normalized = normalizeSender(sender);
  return BANK_PROFILES.find((profile) => profile.senders.some((candidate) => normalizeSender(candidate) === normalized));
}

export function normalizeBankText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - '٠'.charCodeAt(0)))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - '۰'.charCodeAt(0)))
    .replace(/\u066c/g, ',')
    .replace(/\u066b/g, '.')
    .replace(/([0-9]),([0-9]{1,2})(?![0-9])/g, '$1.$2')
    .replace(/[\u061c\u200e\u200f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/([0-9])\s+(?=[0-9])/g, '$1');
}

function numberFromCurrency(value) {
  if (value === null || value === undefined || value === '') return null;
  let normalized = normalizeBankText(value).replace(/\s+/g, '');
  if (/^\d+,\d{1,2}$/.test(normalized)) normalized = normalized.replace(',', '.');
  else normalized = normalized.replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function normalizeCurrency(value) {
  if (!value) return 'EGP';
  const normalized = normalizeBankText(value).toUpperCase().replace(/\s+/g, '');
  if (/^(?:EGP|LE|L\.?E\.?|ج\.?م|جنيه|جنية|جنيه?مصري|جنية?مصرى)$/.test(normalized)) return 'EGP';
  return normalized;
}

function categoryForMerchant(merchant) {
  const candidate = merchant.toLowerCase();
  if (candidate.includes('transfer')) return 'Transfers';
  if (candidate.includes('air') || candidate.includes('metro') || candidate.includes('transport')) return 'Transport';
  if (candidate.includes('market') || candidate.includes('grocery')) return 'Groceries';
  if (candidate.includes('internet') || candidate.includes('utilities')) return 'Home & utilities';
  if (candidate.includes('coffee') || candidate.includes('cafe')) return 'Eating out';
  return 'Other';
}

function formatFixtureDate(value) {
  const match = normalizeBankText(value).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) return 'Unresolved date';
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return 'Unresolved date';
  }
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function hasValidCalendarDatePrefix(value) {
  if (typeof value !== 'string') return true;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (!match) return true;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatMessageDate(receivedAt) {
  if (receivedAt === null || receivedAt === undefined || (typeof receivedAt === 'string' && !receivedAt.trim())) {
    return 'Unresolved date';
  }
  const date = new Date(receivedAt);
  if (!hasValidCalendarDatePrefix(receivedAt) || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2001 || date.getUTCFullYear() > 2100) {
    return 'Unresolved date';
  }
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function parsedResult({ amount, merchant, receivedAt, direction, currency = 'EGP', category }) {
  const reasons = [];
  const date = formatMessageDate(receivedAt);
  if (!Number.isFinite(amount) || amount <= 0) reasons.push('Amount is missing or invalid');
  if (!merchant || !String(merchant).trim()) reasons.push('Merchant or transfer description is missing');
  if (date === 'Unresolved date') reasons.push('Transaction date is missing or invalid');
  if (!['debit', 'credit'].includes(direction)) reasons.push('Transaction direction is missing or invalid');
  if (currency !== 'EGP') reasons.push('Currency is not supported by the EGP ledger');
  const dateValue = dateValueFromInput(receivedAt);
  if (reasons.length) {
    return {
      ok: false,
      reasons,
      amount,
      merchant,
      date,
      dateValue,
      category: category || categoryForMerchant(merchant || ''),
      direction,
      currency
    };
  }
  return {
    ok: true,
    amount,
    merchant,
    date,
    dateValue,
    category: category || categoryForMerchant(merchant),
    direction,
    currency
  };
}

const CURRENCY_TOKEN = '(?:EGP|USD|EUR|GBP|LE|L\\.?E\\.?|ج\\.?\\s*م|جنيه(?:\\s+(?:مصري|مصرى))?|جنية(?:\\s+(?:مصري|مصرى))?)';
const AMOUNT_TOKEN = '[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?';

function amountFromMatch(match) {
  if (!match) return null;
  return {
    amount: numberFromCurrency(match[2]),
    currency: normalizeCurrency(match[1] || match[3])
  };
}

function findTransactionAmount(body, keywordPattern) {
  const keyword = new RegExp(keywordPattern, 'i');
  const start = body.search(keyword);
  if (start < 0) return null;
  const segment = body.slice(start, start + 260);
  const labelled = new RegExp(
    `(?:بمبلغ|بقيمة|مبلغ|قيمة|amount(?:\\s+of)?)\\s*(?:(${CURRENCY_TOKEN})\\s*)?(${AMOUNT_TOKEN})\\s*(?:(${CURRENCY_TOKEN}))?`,
    'i'
  );
  const direct = new RegExp(
    `${keywordPattern}\\s*(?:مبلغ\\s*)?(?:(${CURRENCY_TOKEN})\\s*)?(${AMOUNT_TOKEN})\\s*(?:(${CURRENCY_TOKEN}))?`,
    'i'
  );
  return amountFromMatch(segment.match(labelled)) || amountFromMatch(segment.match(direct));
}

function merchantFromBody(body) {
  const match = body.match(/(?:عند|لدى|at)\s+(?:التاجر\s*)?(.+?)(?=\s+(?:يوم|في|فى|بتاريخ|تاريخ|الساعة|المتاح|الرصيد|والمتبقي|للمزيد|عن طريق|من حساب|الى|إلى|on|available|balance|remaining|for more|contact)(?:\s|$)|$)/i);
  return match?.[1]?.trim().replace(/[،,.;]+$/, '').trim() || undefined;
}

function refundMerchantFromBody(body) {
  const match = body.match(/خصمه\s+من\s+(.+?)(?=\s+(?:يوم|الرصيد|المتاح)(?:\s|$)|$)/i);
  return match?.[1]?.trim() || merchantFromBody(body);
}

export function parseBankAlAhlyMessage(body, receivedAt) {
  const text = normalizeBankText(body);
  if (/هذا الكود|OTP|رمز/i.test(text)) {
    return { ok: false, ignore: true, reasons: ['Security-code alert is not a transaction'] };
  }

  const refund = findTransactionAmount(text, '(?:رد|استرداد|استرجاع)');
  if (refund) {
    return parsedResult({
      amount: refund.amount,
      merchant: refundMerchantFromBody(text),
      receivedAt,
      direction: 'credit',
      currency: refund.currency,
      category: 'Refunds'
    });
  }

  const credit = findTransactionAmount(text, '(?:إضافة|اضافة|إيداع|ايداع|استلام|استلم|added|deposit)');
  if (credit) {
    return parsedResult({
      amount: credit.amount,
      merchant: /تحويل|transfer/i.test(text) ? 'Incoming instant transfer' : 'Account deposit',
      receivedAt,
      direction: 'credit',
      currency: credit.currency,
      category: /تحويل|transfer/i.test(text) ? 'Transfers' : 'Other'
    });
  }

  const transfer = findTransactionAmount(text, '(?:تحويل|transfer)');
  if (transfer && /(?:إلى|الى)\s+(?:حسابك|حسابكم)|\b(?:وارد|received)\b/i.test(text)) {
    return parsedResult({
      amount: transfer.amount,
      merchant: 'Incoming instant transfer',
      receivedAt,
      direction: 'credit',
      currency: transfer.currency,
      category: 'Transfers'
    });
  }

  const debit = findTransactionAmount(text, '(?:تحويل|خصم|سحب|شراء|دفع|withdrawal)');
  if (debit) {
    const instantTransfer = /التحويل\s+اللحظي|تحويل\s+لحظي|instant\s+transfer/i.test(text);
    const atm = /ماكينة|الصراف\s+الآلي|ATM|cash\s+withdrawal|withdrawal/i.test(text);
    return parsedResult({
      amount: debit.amount,
      merchant: instantTransfer ? 'Outgoing instant transfer' : atm ? 'ATM withdrawal' : merchantFromBody(text),
      receivedAt,
      direction: 'debit',
      currency: debit.currency,
      category: instantTransfer ? 'Transfers' : undefined
    });
  }

  return {
    ok: false,
    ignore: !/(?:خصم|رد|إضافة|اضافة|إيداع|ايداع|تحويل|سحب|شراء|دفع|استلام)/i.test(text),
    reasons: ['Recognized sender but no supported debit or credit pattern']
  };
}

export function parseBanqueMisrMessage(body, receivedAt) {
  const text = normalizeBankText(body);
  if (/هذا الكود|OTP|رمز/i.test(text)) {
    return { ok: false, ignore: true, reasons: ['Security-code alert is not a transaction'] };
  }

  const creationSignal = /(?:إنشاء|انشاء|إصدار|اصدار|شراء|ربط|فتح)[\s\S]{0,40}(?:وديعة|ودائع|شهادة|شهادات)|(?:وديعة|ودائع|شهادة|شهادات)[\s\S]{0,40}(?:إنشاء|انشاء|إصدار|اصدار|شراء|ربط|فتح)/i;
  const creation = findTransactionAmount(text, '(?:خصم|مبلغ|إنشاء|انشاء|إصدار|اصدار|شراء|ربط|فتح|وديعة|ودائع|شهادة|شهادات)');
  if (creation && creationSignal.test(text)) {
    return parsedResult({
      amount: creation.amount,
      merchant: /شهادة|شهادات/i.test(text) ? 'Certificate creation' : 'Term deposit creation',
      receivedAt,
      direction: 'debit',
      currency: creation.currency,
      category: 'Transfers'
    });
  }

  const refund = findTransactionAmount(text, '(?:رد|استرداد|استرجاع)');
  if (refund) {
    return parsedResult({
      amount: refund.amount,
      merchant: refundMerchantFromBody(text) || 'Refund',
      receivedAt,
      direction: 'credit',
      currency: refund.currency,
      category: 'Refunds'
    });
  }

  const credit = findTransactionAmount(text, '(?:إضافة|اضافة|إيداع|ايداع|deposit)');
  if (credit) {
    const cardDeposit = /بطاقة|card|إيداع|ايداع|deposit/i.test(text) && !/تحويل|transfer/i.test(text);
    return parsedResult({
      amount: credit.amount,
      merchant: cardDeposit ? 'Card deposit' : /تحويل|transfer/i.test(text) ? 'Instant transfer' : 'Account deposit',
      receivedAt,
      direction: 'credit',
      currency: credit.currency,
      category: /تحويل|transfer/i.test(text) ? 'Transfers' : undefined
    });
  }

  const transfer = findTransactionAmount(text, '(?:تحويل|transfer)');
  if (transfer) {
    const incoming = /(?:إلى|الى)\s+(?:حسابك|حسابكم)|\b(?:وارد|received)\b/i.test(text);
    return parsedResult({
      amount: transfer.amount,
      merchant: 'Instant transfer',
      receivedAt,
      direction: incoming ? 'credit' : 'debit',
      currency: transfer.currency,
      category: 'Transfers'
    });
  }

  const debit = findTransactionAmount(text, '(?:خصم|سحب|شراء|دفع|withdrawal|cash\\s+withdrawal)');
  if (debit) {
    const atm = /ماكينة|الصراف\s+الآلي|ATM|cash\s+withdrawal|withdrawal/i.test(text);
    return parsedResult({
      amount: debit.amount,
      merchant: atm ? 'ATM withdrawal' : merchantFromBody(text),
      receivedAt,
      direction: 'debit',
      currency: debit.currency
    });
  }

  return {
    ok: false,
    ignore: !/(?:خصم|سحب|شراء|دفع|تحويل|إضافة|اضافة|إيداع|ايداع|رد|وديعة|شهادة|withdrawal|deposit)/i.test(text),
    reasons: ['Recognized sender but no supported debit or credit pattern']
  };
}

export function parseMessageForProfile(profile, body, receivedAt) {
  if (profile.id === TEST_BANK_PROFILE.id) return parseDebitFixture(body);
  if (profile.id === 'bank-al-ahly') return parseBankAlAhlyMessage(body, receivedAt);
  if (profile.id === 'banque-misr') return parseBanqueMisrMessage(body, receivedAt);
  return { ok: false, reasons: ['No parser is registered for this sender profile'] };
}

function redactPreview(body) {
  return String(body || '')
    .replace(/[0-9٠-٩۰-۹][0-9٠-٩۰-۹,.:/-]{2,}/g, '••••')
    .slice(0, 180);
}

export function parseDebitFixture(body) {
  const text = normalizeBankText(body);
  const amountMatch = text.match(/\b(?:EGP|ج\.?م)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const merchantMatch = text.match(/\bat\s+(.+?)\s+on\s+\d{1,2}\/\d{1,2}\/\d{4}\b/i);
  const dateMatch = text.match(/\bon\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/i);
  const isDebit = /\b(?:debit|purchase|card purchase)\b/i.test(text);
  const amount = numberFromCurrency(amountMatch?.[1]);
  const merchant = merchantMatch?.[1]?.trim();
  const date = dateMatch ? formatFixtureDate(dateMatch[1]) : 'Unresolved date';

  if (!isDebit || !amount || !merchant || !dateMatch || date === 'Unresolved date') {
    return {
      ok: false,
      reasons: [
        !isDebit && 'Debit direction is missing',
        !amount && 'Amount is missing or invalid',
        !merchant && 'Merchant is missing',
        (!dateMatch || date === 'Unresolved date') && 'Transaction date is missing or invalid'
      ].filter(Boolean)
    };
  }

  return {
    ok: true,
    amount,
    merchant,
    date,
    dateValue: dateValueFromInput(dateMatch[1]),
    category: categoryForMerchant(merchant),
    direction: 'debit'
  };
}

export function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function isPersistedLedgerState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.version !== 1 && value.version !== LEDGER_VERSION) return false;
  if (!Array.isArray(value.messageIds) || !Array.isArray(value.events) || !Array.isArray(value.reviewCandidates)) return false;
  if (value.version === LEDGER_VERSION && (
    !Array.isArray(value.messages)
    || !Array.isArray(value.parserHistory)
    || !Array.isArray(value.auditLog)
    || !Array.isArray(value.resetHistory)
    || !Array.isArray(value.migrationHistory)
  )) return false;
  return true;
}

function migrateStoredState(rawState) {
  if (!rawState || typeof rawState !== 'object') {
    return { state: clone(defaultState), migrated: false };
  }

  const state = {
    ...clone(rawState),
    version: LEDGER_VERSION,
    messageIds: uniqueStrings(rawState.messageIds || []),
    messages: Array.isArray(rawState.messages) ? clone(rawState.messages) : [],
    events: Array.isArray(rawState.events) ? clone(rawState.events) : [],
    reviewCandidates: Array.isArray(rawState.reviewCandidates) ? clone(rawState.reviewCandidates) : [],
    parserHistory: Array.isArray(rawState.parserHistory) ? clone(rawState.parserHistory) : [],
    auditLog: Array.isArray(rawState.auditLog) ? clone(rawState.auditLog) : [],
    resetHistory: Array.isArray(rawState.resetHistory) ? clone(rawState.resetHistory) : [],
    migrationHistory: Array.isArray(rawState.migrationHistory) ? clone(rawState.migrationHistory) : []
  };

  let nextSequence = Number.isInteger(state.nextSequence) && state.nextSequence > 0 ? state.nextSequence : 1;
  const usedSequences = new Set();
  function reserveSequence(record) {
    let sequence = Number(record.sequence);
    if (!Number.isInteger(sequence) || sequence < 1 || usedSequences.has(sequence)) {
      while (usedSequences.has(nextSequence)) nextSequence += 1;
      sequence = nextSequence;
    }
    usedSequences.add(sequence);
    nextSequence = Math.max(nextSequence, sequence + 1);
    record.sequence = sequence;
    return sequence;
  }

  state.events = state.events.map((input) => {
    const event = { ...input };
    event.sourceIds = normalizeSourceIds(event);
    if (!event.sourceId && event.sourceIds[0]) event.sourceId = event.sourceIds[0];
    event.active = event.active !== false;
    event.evidenceType = isSyntheticRecord(event) ? EVIDENCE_TYPES.SYNTHETIC : EVIDENCE_TYPES.PRODUCTION;
    event.sourceType = event.sourceType || 'bank';
    event.dateValue = event.dateValue || recordDateValue(event);
    event.transactionKey = event.transactionKey || transactionKeyForRecord(event);
    event.decisionHistory = Array.isArray(event.decisionHistory)
      ? event.decisionHistory
      : event.decision ? [clone(event.decision)] : [];
    event.correctionHistory = Array.isArray(event.correctionHistory) ? event.correctionHistory : [];
    reserveSequence(event);
    return event;
  });

  state.reviewCandidates = state.reviewCandidates.map((input) => {
    const candidate = { ...input };
    candidate.sourceIds = normalizeSourceIds(candidate);
    if (!candidate.sourceId && candidate.sourceIds[0]) candidate.sourceId = candidate.sourceIds[0];
    candidate.active = candidate.active !== false && candidate.status !== 'approved';
    candidate.status = candidate.status || 'needs_review';
    candidate.evidenceType = isSyntheticRecord(candidate) ? EVIDENCE_TYPES.SYNTHETIC : EVIDENCE_TYPES.PRODUCTION;
    candidate.sourceType = candidate.sourceType || 'bank';
    candidate.dateValue = candidate.dateValue || recordDateValue(candidate);
    candidate.transactionKey = candidate.transactionKey || transactionKeyForRecord(candidate);
    candidate.editHistory = Array.isArray(candidate.editHistory) ? candidate.editHistory : [];
    reserveSequence(candidate);
    return candidate;
  });

  const messagesBySourceId = new Map();
  function addMessage(input) {
    const sourceId = String(input.sourceId || input.id || '');
    if (!sourceId) return null;
    const existing = messagesBySourceId.get(sourceId);
    if (existing) return existing;
    const message = {
      ...input,
      id: input.id || `message-${sourceId}`,
      sourceId,
      sourceIds: uniqueStrings([...(input.sourceIds || []), sourceId]),
      active: input.active !== false,
      evidenceType: isSyntheticRecord({ ...input, sourceId }) ? EVIDENCE_TYPES.SYNTHETIC : EVIDENCE_TYPES.PRODUCTION,
      parserHistory: Array.isArray(input.parserHistory) ? clone(input.parserHistory) : [],
      observations: Array.isArray(input.observations) ? clone(input.observations) : []
    };
    reserveSequence(message);
    messagesBySourceId.set(sourceId, message);
    return message;
  }

  state.messages.forEach((input) => addMessage(input));
  state.events.forEach((event) => {
    event.sourceIds.forEach((sourceId) => {
      const message = addMessage({
        id: `message-${sourceId}`,
        sourceId,
        sender: event.sender,
        senderProfileId: event.senderProfileId,
        senderProfileName: event.senderProfileName,
        parserVersion: event.parserVersion,
        receivedAt: event.receivedAt,
        originalMessage: event.originalMessage || '',
        status: event.status || 'auto_approved',
        linkedEventId: event.id,
        transactionKey: event.transactionKey,
        active: event.active,
        evidenceType: event.evidenceType
      });
      if (message) {
        message.linkedEventId = event.id;
        message.transactionKey = event.transactionKey || message.transactionKey;
        message.status = event.status || message.status;
        message.active = event.active !== false;
      }
    });
  });
  state.reviewCandidates.forEach((candidate) => {
    candidate.sourceIds.forEach((sourceId) => {
      const message = addMessage({
        id: `message-${sourceId}`,
        sourceId,
        sender: candidate.sender,
        senderProfileId: candidate.senderProfileId,
        senderProfileName: candidate.senderProfileName,
        parserVersion: candidate.parserVersion,
        receivedAt: candidate.receivedAt,
        originalMessage: candidate.originalMessage || '',
        status: candidate.status,
        linkedCandidateId: candidate.id,
        transactionKey: candidate.transactionKey,
        active: candidate.active,
        evidenceType: candidate.evidenceType
      });
      if (message) {
        message.linkedCandidateId = candidate.id;
        message.transactionKey = candidate.transactionKey || message.transactionKey;
        message.status = candidate.status;
        message.active = candidate.active !== false;
      }
    });
  });

  state.messageIds = uniqueStrings([
    ...state.messageIds,
    ...state.events.flatMap((event) => event.sourceIds),
    ...state.reviewCandidates.flatMap((candidate) => candidate.sourceIds),
    ...messagesBySourceId.keys()
  ]);
  state.messageIds.forEach((sourceId) => {
    if (messagesBySourceId.has(sourceId)) return;
    addMessage({
      id: `message-${sourceId}`,
      sourceId,
      status: 'ignored',
      parserVersion: 'legacy-unknown',
      needsReprocess: true,
      active: true,
      evidenceType: isSyntheticRecord({ sourceId }) ? EVIDENCE_TYPES.SYNTHETIC : EVIDENCE_TYPES.PRODUCTION
    });
  });
  state.messages = [...messagesBySourceId.values()];

  const migrated = rawState.version !== LEDGER_VERSION;
  if (migrated) {
    const syntheticSourceIds = uniqueStrings([
      ...state.events.filter(isSyntheticRecord).flatMap((event) => event.sourceIds),
      ...state.reviewCandidates.filter(isSyntheticRecord).flatMap((candidate) => candidate.sourceIds),
      ...state.messages.filter(isSyntheticRecord).map((message) => message.sourceId)
    ]);
    const sequence = reserveSequence({});
    const audit = {
      id: `audit-${sequence}`,
      sequence,
      type: 'ledger_migrated',
      occurredAt: new Date().toISOString(),
      details: {
        fromVersion: rawState.version || 1,
        toVersion: LEDGER_VERSION,
        preservedEventIds: state.events.map((event) => event.id),
        preservedCandidateIds: state.reviewCandidates.map((candidate) => candidate.id),
        preservedMessageIds: state.messageIds,
        syntheticSourceIds,
        removed: []
      }
    };
    state.auditLog.push(audit);
    state.migrationHistory.push({ ...audit, details: clone(audit.details) });
  }

  state.nextSequence = Math.max(nextSequence, Number(state.nextSequence) || 1);
  return { state, migrated };
}

export function createHarborLedger(storage = window.localStorage, { autoPersist = true } = {}) {
  const saved = storage.getItem(STORAGE_KEY);
  let savedState;
  if (saved === null || saved === undefined) {
    savedState = null;
  } else {
    let parsedState;
    try {
      parsedState = JSON.parse(saved);
    } catch (cause) {
      throw new LedgerCorruptionError('Harbor ledger storage contains malformed JSON', { cause });
    }
    if (!isPersistedLedgerState(parsedState)) {
      throw new LedgerCorruptionError('Harbor ledger storage has an invalid persisted shape');
    }
    savedState = parsedState;
  }
  const migratedState = migrateStoredState(savedState);
  let state = migratedState.state;

  function persist() {
    if (!autoPersist) return;
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  if (migratedState.migrated) persist();

  function takeSequence() {
    const sequence = Number.isInteger(state.nextSequence) && state.nextSequence > 0 ? state.nextSequence : 1;
    state.nextSequence = sequence + 1;
    return sequence;
  }

  function appendAudit(type, details = {}) {
    const sequence = takeSequence();
    const entry = {
      id: `audit-${sequence}`,
      sequence,
      type,
      occurredAt: new Date().toISOString(),
      details: clone(details)
    };
    state.auditLog.push(entry);
    return entry;
  }

  function appendParserDecision(messageRecord, {
    parserVersion,
    outcome,
    reasons = [],
    transactionKey = null
  }) {
    const sequence = takeSequence();
    const decision = {
      id: `parser-${sequence}`,
      sequence,
      sourceId: messageRecord.sourceId,
      parserVersion: parserVersion || 'unrecognized',
      outcome,
      reasons: [...reasons],
      transactionKey,
      occurredAt: new Date().toISOString()
    };
    state.parserHistory.push(decision);
    messageRecord.parserHistory = [...(messageRecord.parserHistory || []), clone(decision)];
    messageRecord.parserVersion = decision.parserVersion;
    messageRecord.lastParserDecisionId = decision.id;
    messageRecord.status = outcome;
    messageRecord.transactionKey = transactionKey;
    return decision;
  }

  function observeMessage(messageRecord, message) {
    const sequence = takeSequence();
    const observation = {
      id: `observation-${sequence}`,
      sequence,
      sender: message.sender,
      receivedAt: message.receivedAt,
      body: String(message.body || ''),
      occurredAt: new Date().toISOString()
    };
    messageRecord.observations = [...(messageRecord.observations || []), observation];
    if (!messageRecord.originalMessage && observation.body) messageRecord.originalMessage = observation.body;
    messageRecord.lastReceivedAt = message.receivedAt;
    messageRecord.lastSender = message.sender;
    return observation;
  }

  function findMessage(sourceId) {
    return state.messages.find((message) => message.sourceId === String(sourceId));
  }

  function ensureMessage(message, profile, evidenceType, { observe = true } = {}) {
    const sourceId = String(message.id);
    let messageRecord = findMessage(sourceId);
    if (!messageRecord) {
      const sequence = takeSequence();
      messageRecord = {
        id: `message-${sourceId}`,
        sequence,
        sourceId,
        sender: message.sender,
        senderProfileId: profile?.id || 'unknown-sender',
        senderProfileName: profile?.displayName || message.sender,
        parserVersion: profile?.parserVersion || 'unrecognized',
        receivedAt: message.receivedAt,
        originalMessage: '',
        observations: [],
        parserHistory: [],
        sourceIds: [sourceId],
        evidenceType,
        active: true,
        status: 'received'
      };
      state.messages.push(messageRecord);
    } else if (messageRecord.active === false) {
      messageRecord.active = true;
      messageRecord.reactivatedAt = new Date().toISOString();
      appendAudit('message_reactivated', { sourceId, reason: 'A prior reset archived the source record' });
    }

    messageRecord.sender = message.sender || messageRecord.sender;
    messageRecord.senderProfileId = profile?.id || messageRecord.senderProfileId || 'unknown-sender';
    messageRecord.senderProfileName = profile?.displayName || messageRecord.senderProfileName || message.sender;
    messageRecord.evidenceType = evidenceType;
    messageRecord.sourceIds = uniqueStrings([...(messageRecord.sourceIds || []), sourceId]);
    if (!state.messageIds.includes(sourceId)) state.messageIds.push(sourceId);
    if (observe) observeMessage(messageRecord, message);
    return messageRecord;
  }

  function activeEvents() {
    return state.events.filter((event) => event.active !== false);
  }

  function activeCandidates() {
    return state.reviewCandidates.filter((candidate) => candidate.active !== false && candidate.status === 'needs_review');
  }

  function findActiveEventBySourceId(sourceId) {
    return activeEvents().find((event) => event.sourceIds?.includes(String(sourceId)) || event.sourceId === String(sourceId));
  }

  function findActiveCandidateBySourceId(sourceId) {
    return activeCandidates().find((candidate) => candidate.sourceIds?.includes(String(sourceId)) || candidate.sourceId === String(sourceId));
  }

  function findActiveEventByTransactionKey(transactionKey) {
    if (!transactionKey) return null;
    return activeEvents().filter((event) => event.transactionKey === transactionKey).sort(compareLedgerRecords)[0] || null;
  }

  function findActiveCandidateByTransactionKey(transactionKey) {
    if (!transactionKey) return null;
    return activeCandidates().filter((candidate) => candidate.transactionKey === transactionKey).sort(compareLedgerRecords)[0] || null;
  }

  function setMessageLink(messageRecord, {
    status,
    transactionKey = null,
    eventId = null,
    candidateId = null
  }) {
    messageRecord.status = status;
    messageRecord.transactionKey = transactionKey;
    messageRecord.linkedEventId = eventId;
    messageRecord.linkedCandidateId = candidateId;
    messageRecord.active = true;
  }

  function linkSource(record, sourceId) {
    const normalizedSourceId = String(sourceId);
    if (!Array.isArray(record.sourceIds)) record.sourceIds = [];
    if (!record.sourceIds.includes(normalizedSourceId)) record.sourceIds.push(normalizedSourceId);
    if (!record.sourceId) record.sourceId = normalizedSourceId;
    return record;
  }

  function approvalReasons(record) {
    const reasons = [];
    const merchant = String(record.merchant || '').trim();
    if (!merchant || /^unresolved\b/i.test(merchant)) reasons.push('Merchant is unresolved');
    const dateValue = dateValueFromInput(record.dateValue || record.date);
    if (!dateValue) reasons.push('Transaction date is unresolved');
    if (!isPositiveAmount(record.amount)) reasons.push('Amount is missing or invalid');
    if (!isValidDirection(record.direction)) reasons.push('Transaction direction is invalid');
    if (record.currency && String(record.currency).toUpperCase() !== 'EGP') reasons.push('Currency is not supported by the EGP ledger');
    return reasons;
  }

  function normalizedChanges(record, changes = {}) {
    const next = { ...record };
    if (Object.prototype.hasOwnProperty.call(changes, 'merchant')) next.merchant = String(changes.merchant || '').trim();
    if (Object.prototype.hasOwnProperty.call(changes, 'amount')) {
      const amount = typeof changes.amount === 'number' ? changes.amount : numberFromCurrency(changes.amount);
      next.amount = Number.isFinite(amount) ? amount : null;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'date')) next.date = String(changes.date || '').trim();
    if (Object.prototype.hasOwnProperty.call(changes, 'dateValue')) next.dateValue = dateValueFromInput(changes.dateValue);
    else if (Object.prototype.hasOwnProperty.call(changes, 'date')) next.dateValue = dateValueFromInput(next.date);
    if (Object.prototype.hasOwnProperty.call(changes, 'category')) next.category = String(changes.category || '').trim();
    if (Object.prototype.hasOwnProperty.call(changes, 'direction')) next.direction = changes.direction;
    if (Object.prototype.hasOwnProperty.call(changes, 'currency')) next.currency = String(changes.currency || 'EGP').toUpperCase();
    next.transactionKey = transactionKeyForRecord(next);
    return next;
  }

  function resultRecord(record, compactResult) {
    return compactResult
      ? { id: record.id, sourceId: record.sourceId, status: record.status }
      : clone(record);
  }

  function addCandidate(message, reasons, parsed = {}, profile = null, messageRecord, evidenceType, compactResult = false) {
    const transactionKey = transactionKeyForRecord({
      ...parsed,
      senderProfileId: profile?.id || 'unknown-sender',
      evidenceType,
      receivedAt: message.receivedAt
    });
    const existingCandidate = findActiveCandidateByTransactionKey(transactionKey);
    if (existingCandidate) {
      linkSource(existingCandidate, message.id);
      setMessageLink(messageRecord, {
        status: 'duplicate',
        transactionKey,
        candidateId: existingCandidate.id
      });
      appendAudit('duplicate_linked', {
        sourceId: message.id,
        linkedCandidateId: existingCandidate.id,
        transactionKey
      });
      return { kind: 'duplicate', candidate: resultRecord(existingCandidate, compactResult), duplicateOf: existingCandidate.id };
    }

    const candidateSequence = takeSequence();
    const baseCandidateId = `candidate-${message.id}`;
    const candidateId = state.reviewCandidates.some((candidate) => candidate.id === baseCandidateId)
      ? `${baseCandidateId}-${candidateSequence}`
      : baseCandidateId;
    const candidate = {
      id: candidateId,
      sequence: candidateSequence,
      sourceId: String(message.id),
      sourceIds: [String(message.id)],
      sender: message.sender,
      senderProfileId: profile?.id || 'unknown-sender',
      senderProfileName: profile?.displayName || message.sender,
      parserVersion: profile?.parserVersion || 'unrecognized',
      receivedAt: message.receivedAt,
      originalMessage: String(message.body || ''),
      preview: redactPreview(message.body),
      merchant: parsed.merchant || 'Unresolved merchant',
      amount: parsed.amount ?? 0,
      date: parsed.date || 'Unresolved date',
      dateValue: parsed.dateValue || dateValueFromInput(parsed.date),
      category: parsed.category || 'Unresolved category',
      direction: parsed.direction ?? null,
      currency: parsed.currency || 'EGP',
      evidenceType,
      sourceType: 'bank',
      transactionKey,
      reasons: [...reasons],
      editHistory: [],
      status: 'needs_review',
      active: true
    };
    state.reviewCandidates.push(candidate);
    setMessageLink(messageRecord, {
      status: 'needs_review',
      transactionKey,
      candidateId: candidate.id
    });
    appendAudit('review_queued', {
      candidateId: candidate.id,
      sourceId: message.id,
      reasons: candidate.reasons,
      transactionKey
    });
    return { kind: 'needs_review', candidate: resultRecord(candidate, compactResult) };
  }

  function supersedeCandidateForReparse(messageRecord) {
    const candidate = state.reviewCandidates.find((item) => item.id === messageRecord.linkedCandidateId && item.active !== false);
    if (!candidate) return;
    const previous = clone(candidate);
    candidate.active = false;
    candidate.status = 'superseded';
    candidate.supersededAt = new Date().toISOString();
    candidate.supersededReason = 'Parser version advanced';
    appendAudit('candidate_superseded', {
      candidateId: candidate.id,
      sourceId: messageRecord.sourceId,
      previous,
      reason: candidate.supersededReason
    });
  }

  function processMessage(message, profile, messageRecord, evidenceType, { reprocessed = false, compactResult = false } = {}) {
    if (reprocessed) {
      appendAudit('message_reprocessed', {
        sourceId: messageRecord.sourceId,
        previousParserVersion: messageRecord.parserVersion,
        parserVersion: profile?.parserVersion || 'unrecognized',
        previousStatus: messageRecord.status,
        evidenceType
      });
    }
    if (reprocessed) supersedeCandidateForReparse(messageRecord);
    const parserVersion = profile?.parserVersion || 'unrecognized';
    const parsed = profile
      ? parseMessageForProfile(profile, message.body, message.receivedAt)
      : { ok: false, reasons: ['Sender is not on the approved bank list'] };

    if (!parsed.ok) {
      if (parsed.ignore) {
        setMessageLink(messageRecord, { status: 'ignored' });
        appendParserDecision(messageRecord, {
          parserVersion,
          outcome: 'ignored',
          reasons: parsed.reasons
        });
        persist();
        return {
          kind: 'ignored',
          reasons: [...parsed.reasons],
          reprocessed
        };
      }
      const review = addCandidate(message, parsed.reasons || ['Needs a human check'], parsed, profile, messageRecord, evidenceType, compactResult);
      appendParserDecision(messageRecord, {
        parserVersion,
        outcome: review.kind === 'duplicate' ? 'duplicate' : 'needs_review',
        reasons: parsed.reasons,
        transactionKey: review.candidate?.transactionKey || null
      });
      persist();
      return review;
    }

    const parsedWithDate = {
      ...parsed,
      dateValue: parsed.dateValue || dateValueFromInput(parsed.date) || dateValueFromInput(message.receivedAt),
      senderProfileId: profile?.id || 'unknown-sender',
      evidenceType,
      receivedAt: message.receivedAt
    };
    const validationReasons = approvalReasons(parsedWithDate);
    if (!profile?.autoApprove) validationReasons.unshift('Automatic approval is disabled for this sender profile');
    if (validationReasons.length) {
      const review = addCandidate(message, validationReasons, parsedWithDate, profile, messageRecord, evidenceType, compactResult);
      appendParserDecision(messageRecord, {
        parserVersion,
        outcome: review.kind === 'duplicate' ? 'duplicate' : 'needs_review',
        reasons: validationReasons,
        transactionKey: review.candidate?.transactionKey || null
      });
      persist();
      return review;
    }

    const transactionKey = transactionKeyForRecord(parsedWithDate);
    const existingEvent = findActiveEventByTransactionKey(transactionKey);
    if (existingEvent) {
      linkSource(existingEvent, message.id);
      setMessageLink(messageRecord, {
        status: 'duplicate',
        transactionKey,
        eventId: existingEvent.id
      });
      appendParserDecision(messageRecord, {
        parserVersion,
        outcome: 'duplicate',
        reasons: ['Transaction fingerprint already exists'],
        transactionKey
      });
      appendAudit('duplicate_linked', {
        sourceId: message.id,
        linkedEventId: existingEvent.id,
        transactionKey
      });
      persist();
      return { kind: 'duplicate', event: resultRecord(existingEvent, compactResult), duplicateOf: existingEvent.id };
    }

    const eventSequence = takeSequence();
    const baseEventId = `event-${message.id}`;
    const eventId = state.events.some((event) => event.id === baseEventId)
      ? `${baseEventId}-r${eventSequence}`
      : baseEventId;
    const decidedAt = new Date().toISOString();
    const decision = {
      mode: 'automatic',
      reason: 'Allow-listed sender and validated parser',
      decidedAt
    };
    const event = {
      id: eventId,
      sequence: eventSequence,
      sourceId: String(message.id),
      sourceIds: [String(message.id)],
      senderProfileId: profile.id,
      senderProfileName: profile.displayName,
      parserVersion,
      receivedAt: message.receivedAt,
      originalMessage: String(message.body || ''),
      preview: redactPreview(message.body),
      merchant: parsed.merchant,
      amount: parsed.amount,
      date: parsed.date,
      dateValue: parsedWithDate.dateValue,
      category: parsed.category,
      direction: parsed.direction,
      currency: parsed.currency || 'EGP',
      evidenceType,
      sourceType: 'bank',
      transactionKey,
      source: profile.id === TEST_BANK_PROFILE.id ? 'Bank SMS · auto-approved' : 'Messages · auto-approved',
      status: 'auto_approved',
      active: true,
      decision,
      decisionHistory: [decision],
      correctionHistory: []
    };
    state.events.push(event);
    setMessageLink(messageRecord, {
      status: 'auto_approved',
      transactionKey,
      eventId: event.id
    });
    appendParserDecision(messageRecord, {
      parserVersion,
      outcome: 'auto_approved',
      reasons: [],
      transactionKey
    });
    appendAudit('event_created', {
      eventId: event.id,
      sourceId: message.id,
      transactionKey,
      evidenceType
    });
    persist();
    return { kind: 'auto_approved', event: resultRecord(event, compactResult) };
  }

  function ingest(inputMessage, options = {}) {
    if (!inputMessage || inputMessage.id === null || inputMessage.id === undefined || String(inputMessage.id) === '') {
      return { kind: 'invalid', reasons: ['Source message ID is missing'] };
    }
    const message = { ...inputMessage, id: String(inputMessage.id) };
    const profile = profileForSender(message.sender);
    const evidenceType = evidenceTypeForMessage(message, profile);
    const parserVersion = profile?.parserVersion || 'unrecognized';
    const existingMessage = findMessage(message.id);
    const forceReprocess = Boolean(options.reprocess || options.forceReprocess);
    const canReprocess = existingMessage
      && existingMessage.active !== false
      && (forceReprocess || (
        ['ignored', 'needs_review'].includes(existingMessage.status)
        && existingMessage.parserVersion !== parserVersion
      ));

    if (existingMessage && existingMessage.active !== false && !canReprocess) {
      const existingEvent = findActiveEventBySourceId(message.id);
      const existingCandidate = findActiveCandidateBySourceId(message.id);
      if (existingMessage.status === 'ignored') {
        return {
          kind: 'duplicate',
          ignored: true,
          reasons: existingMessage.parserHistory?.at(-1)?.reasons || ['Message was previously ignored'],
          reprocessAvailable: existingMessage.parserVersion !== parserVersion
        };
      }
      return {
        kind: 'duplicate',
        event: existingEvent ? clone(existingEvent) : undefined,
        candidate: existingCandidate ? clone(existingCandidate) : undefined
      };
    }

    const messageRecord = ensureMessage(message, profile, evidenceType, { observe: true });
    if (existingMessage && existingMessage.active === false) {
      appendAudit('message_reactivated', { sourceId: message.id, reason: 'Ingest after an append-only reset' });
    }
    return processMessage(message, profile, messageRecord, evidenceType, {
      reprocessed: Boolean(canReprocess || (existingMessage && existingMessage.active === false)),
      compactResult: Boolean(options.compactResult)
    });
  }

  function editCandidate(candidateId, changes = {}) {
    const candidate = state.reviewCandidates.find((item) => item.id === candidateId && item.active !== false && item.status === 'needs_review');
    if (!candidate) return { kind: 'missing' };
    const before = clone(candidate);
    const next = normalizedChanges(candidate, changes);
    const directionReasons = isValidDirection(next.direction) ? [] : ['Transaction direction is invalid'];
    if (directionReasons.length) {
      appendAudit('candidate_edit_rejected', {
        candidateId,
        sourceId: candidate.sourceId,
        reasons: directionReasons,
        attemptedDirection: changes.direction
      });
      persist();
      return { kind: 'invalid', reasons: directionReasons, candidate: clone(candidate) };
    }
    const changedFields = ['merchant', 'amount', 'date', 'dateValue', 'category', 'direction', 'currency']
      .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(next[field]));
    if (!changedFields.length) return { kind: 'unchanged', candidate: clone(candidate) };
    const sequence = takeSequence();
    const edit = {
      id: `edit-${sequence}`,
      sequence,
      occurredAt: new Date().toISOString(),
      fields: changedFields,
      before: Object.fromEntries(changedFields.map((field) => [field, before[field]])),
      after: Object.fromEntries(changedFields.map((field) => [field, next[field]]))
    };
    Object.assign(candidate, next);
    candidate.editHistory = [...(candidate.editHistory || []), edit];
    appendAudit('candidate_edited', {
      candidateId,
      sourceId: candidate.sourceId,
      editId: edit.id,
      fields: changedFields,
      before: edit.before,
      after: edit.after
    });
    persist();
    return { kind: 'edited', candidate: clone(candidate), edit: clone(edit) };
  }

  function approveCandidate(candidateId, overrides = {}) {
    if (overrides && Object.keys(overrides).length) {
      const editResult = editCandidate(candidateId, overrides);
      if (!['edited', 'unchanged'].includes(editResult.kind)) return editResult;
    }
    const candidate = state.reviewCandidates.find((item) => item.id === candidateId && item.active !== false && item.status === 'needs_review');
    if (!candidate) return { kind: 'missing' };
    const reasons = approvalReasons(candidate);
    if (reasons.length) {
      appendAudit('approval_rejected', {
        candidateId,
        sourceId: candidate.sourceId,
        reasons,
        candidate: {
          merchant: candidate.merchant,
          amount: candidate.amount,
          date: candidate.date,
          dateValue: candidate.dateValue,
          currency: candidate.currency
        }
      });
      persist();
      return { kind: 'invalid', reasons, candidate: clone(candidate) };
    }

    const eventSequence = takeSequence();
    const baseEventId = `event-${candidate.sourceId}`;
    const eventId = state.events.some((event) => event.id === baseEventId)
      ? `${baseEventId}-r${eventSequence}`
      : baseEventId;
    const decidedAt = new Date().toISOString();
    const decision = {
      mode: 'manual',
      reason: 'Human review approval',
      decidedAt
    };
    const event = {
      id: eventId,
      sequence: eventSequence,
      sourceId: candidate.sourceId,
      sourceIds: [...(candidate.sourceIds || [candidate.sourceId])],
      senderProfileId: candidate.senderProfileId,
      senderProfileName: candidate.senderProfileName,
      parserVersion: candidate.parserVersion,
      receivedAt: candidate.receivedAt,
      originalMessage: candidate.originalMessage || null,
      preview: candidate.preview,
      merchant: candidate.merchant,
      amount: candidate.amount,
      date: candidate.date,
      dateValue: candidate.dateValue || dateValueFromInput(candidate.date),
      category: candidate.category,
      direction: candidate.direction,
      currency: candidate.currency || 'EGP',
      evidenceType: candidate.evidenceType || EVIDENCE_TYPES.PRODUCTION,
      sourceType: 'bank',
      transactionKey: transactionKeyForRecord(candidate),
      source: candidate.evidenceType === EVIDENCE_TYPES.SYNTHETIC ? 'Bank SMS · test manually approved' : 'Messages · manually approved',
      status: 'approved',
      active: true,
      decision,
      decisionHistory: [decision],
      correctionHistory: []
    };
    candidate.active = false;
    candidate.status = 'approved';
    candidate.resolvedAt = decidedAt;
    candidate.resolutionEventId = event.id;
    state.events.push(event);
    for (const sourceId of event.sourceIds) {
      const messageRecord = findMessage(sourceId);
      if (messageRecord) setMessageLink(messageRecord, {
        status: 'approved',
        transactionKey: event.transactionKey,
        eventId: event.id
      });
    }
    appendAudit('candidate_approved', {
      candidateId,
      sourceIds: event.sourceIds,
      eventId: event.id,
      decision: clone(decision),
      candidate: {
        merchant: event.merchant,
        amount: event.amount,
        date: event.date,
        dateValue: event.dateValue,
        category: event.category
      }
    });
    persist();
    return { kind: 'approved', event: clone(event) };
  }

  function dismissCandidate(candidateId) {
    const candidate = state.reviewCandidates.find((item) => item.id === candidateId && item.active !== false && item.status === 'needs_review');
    if (!candidate) return { kind: 'missing' };
    const dismissedAt = new Date().toISOString();
    candidate.active = false;
    candidate.status = 'dismissed';
    candidate.dismissedAt = dismissedAt;
    candidate.dismissalReason = 'Human dismissed from review queue';
    for (const sourceId of candidate.sourceIds || [candidate.sourceId]) {
      const messageRecord = findMessage(sourceId);
      if (messageRecord) setMessageLink(messageRecord, {
        status: 'dismissed',
        transactionKey: candidate.transactionKey,
        candidateId: candidate.id
      });
    }
    appendAudit('candidate_dismissed', {
      candidateId,
      sourceIds: [...(candidate.sourceIds || [candidate.sourceId])],
      dismissedAt,
      reason: candidate.dismissalReason,
      candidate: {
        merchant: candidate.merchant,
        amount: candidate.amount,
        date: candidate.date,
        category: candidate.category
      }
    });
    persist();
    return { kind: 'dismissed', candidate: clone(candidate) };
  }

  function correctEvent(eventId, changes = {}) {
    const current = state.events.find((event) => event.id === eventId && event.active !== false);
    if (!current) return { kind: 'missing' };
    const correctedFields = normalizedChanges(current, changes);
    const reasons = approvalReasons(correctedFields);
    if (reasons.length) {
      appendAudit('correction_rejected', { eventId, reasons });
      persist();
      return { kind: 'invalid', reasons };
    }
    const transactionKey = transactionKeyForRecord(correctedFields);
    const duplicate = findActiveEventByTransactionKey(transactionKey);
    if (duplicate && duplicate.id !== current.id) {
      const duplicateReason = ['Correction matches an existing transaction'];
      appendAudit('correction_rejected', { eventId, reasons: duplicateReason, duplicateEventId: duplicate.id });
      persist();
      return { kind: 'invalid', reasons: duplicateReason };
    }
    const before = clone(current);
    const sequence = takeSequence();
    const correction = {
      id: `correction-${sequence}`,
      sequence,
      occurredAt: new Date().toISOString(),
      fields: Object.keys(changes)
    };
    const corrected = {
      ...current,
      ...correctedFields,
      id: `${current.id}-revision-${sequence}`,
      sequence,
      active: true,
      revisionOf: current.id,
      transactionKey,
      correctionHistory: [...(current.correctionHistory || []), correction]
    };
    current.active = false;
    current.supersededAt = correction.occurredAt;
    current.supersededBy = corrected.id;
    state.events.push(corrected);
    for (const sourceId of corrected.sourceIds || []) {
      const messageRecord = findMessage(sourceId);
      if (messageRecord) messageRecord.linkedEventId = corrected.id;
    }
    appendAudit('event_corrected', {
      eventId: corrected.id,
      supersedesEventId: current.id,
      correctionId: correction.id,
      before,
      after: clone(corrected)
    });
    persist();
    return { kind: 'corrected', event: clone(corrected), correction: clone(correction) };
  }

  function reset() {
    const resetAt = new Date().toISOString();
    const eventIds = [];
    const candidateIds = [];
    const messageIds = [];
    state.events = state.events.map((event) => {
      if (event.active === false) return event;
      eventIds.push(event.id);
      return { ...event, active: false, archivedAt: resetAt, archivedReason: 'reset' };
    });
    state.reviewCandidates = state.reviewCandidates.map((candidate) => {
      if (candidate.active === false) return candidate;
      candidateIds.push(candidate.id);
      return { ...candidate, active: false, status: 'reset', archivedAt: resetAt, archivedReason: 'reset' };
    });
    state.messages = state.messages.map((message) => {
      if (message.active === false) return message;
      messageIds.push(message.sourceId);
      return { ...message, active: false, status: 'reset', archivedAt: resetAt, archivedReason: 'reset' };
    });
    const audit = appendAudit('ledger_reset', {
      resetAt,
      eventIds,
      candidateIds,
      messageIds,
      preserved: true
    });
    state.resetHistory.push(clone(audit));
    persist();
    return { kind: 'reset', audit: clone(audit) };
  }

  function rebuild() {
    state.events = state.events.map((event) => ({
      ...event,
      sourceIds: normalizeSourceIds(event),
      evidenceType: isSyntheticRecord(event) ? EVIDENCE_TYPES.SYNTHETIC : EVIDENCE_TYPES.PRODUCTION,
      dateValue: event.dateValue || recordDateValue(event),
      transactionKey: event.transactionKey || transactionKeyForRecord(event)
    }));
    state.reviewCandidates = state.reviewCandidates.map((candidate) => ({
      ...candidate,
      sourceIds: normalizeSourceIds(candidate),
      evidenceType: isSyntheticRecord(candidate) ? EVIDENCE_TYPES.SYNTHETIC : EVIDENCE_TYPES.PRODUCTION,
      dateValue: candidate.dateValue || recordDateValue(candidate),
      transactionKey: candidate.transactionKey || transactionKeyForRecord(candidate)
    }));
    const audit = appendAudit('ledger_rebuilt', {
      activeEventCount: activeEvents().length,
      activeCandidateCount: activeCandidates().length,
      messageCount: state.messages.length,
      reason: 'Rebuilt deterministic projections from durable records'
    });
    persist();
    return { kind: 'rebuilt', audit: clone(audit), snapshot: snapshot({ includeSynthetic: true }) };
  }

  function snapshot(options = {}) {
    const includeSynthetic = Boolean(options.includeSynthetic);
    const includeArchived = Boolean(options.includeArchived);
    const allEvents = state.events
      .filter((event) => includeArchived || event.active !== false)
      .sort(compareLedgerRecords);
    const allReviewCandidates = state.reviewCandidates
      .filter((candidate) => includeArchived || candidate.active !== false)
      .sort(compareLedgerRecords);
    const visibleEvents = allEvents.filter((event) => includeSynthetic || !isSyntheticRecord(event));
    const visibleReviewCandidates = allReviewCandidates.filter((candidate) => includeSynthetic || !isSyntheticRecord(candidate));
    return clone({
      ...state,
      events: visibleEvents,
      reviewCandidates: visibleReviewCandidates,
      allEvents,
      allReviewCandidates,
      productionEvents: allEvents.filter((event) => !isSyntheticRecord(event)),
      syntheticEvents: allEvents.filter(isSyntheticRecord),
      productionReviewCandidates: allReviewCandidates.filter((candidate) => !isSyntheticRecord(candidate)),
      syntheticReviewCandidates: allReviewCandidates.filter(isSyntheticRecord)
    });
  }

  function auditSnapshot() {
    return snapshot({ includeSynthetic: true, includeArchived: true });
  }

  function durableSnapshot() {
    return clone(state);
  }

  function runAutoApprovalTest() {
    const suffix = Date.now() + '-' + state.nextSequence;
    return ingest({
      id: 'harbor-test-debit-' + suffix,
      sender: TEST_BANK_PROFILE.sender,
      receivedAt: '2026-08-04T12:00:00.000Z',
      body: 'Debit EGP 1,240.00 at Nile Air Store on 31/07/2026.'
    });
  }

  function runExceptionTest() {
    const suffix = Date.now() + '-' + state.nextSequence;
    return ingest({
      id: 'harbor-test-exception-' + suffix,
      sender: '+201000008888',
      receivedAt: '2026-08-04T12:01:00.000Z',
      body: 'Zoid Bank alert EGP 500.00 on 04/08/2026.'
    });
  }

  return {
    profiles: () => clone(BANK_PROFILES),
    ingest,
    approveCandidate,
    dismissCandidate,
    editCandidate,
    correctEvent,
    reset,
    rebuild,
    runAutoApprovalTest,
    runExceptionTest,
    snapshot,
    auditSnapshot,
    durableSnapshot
  };
}
