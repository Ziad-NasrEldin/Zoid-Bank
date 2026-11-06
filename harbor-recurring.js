const DAY_MS = 24 * 60 * 60 * 1000;

export const MANUAL_RECURRING_CADENCES = [
  { key: 'weekly', label: 'Weekly', days: 7 },
  { key: 'biweekly', label: 'Every 2 weeks', days: 14 },
  { key: 'monthly', label: 'Monthly', days: 30 },
  { key: 'quarterly', label: 'Quarterly', days: 90 },
  { key: 'yearly', label: 'Yearly', days: 365 }
];

const CADENCE_BANDS = [
  { key: 'weekly', label: 'Weekly', min: 5, max: 10 },
  { key: 'biweekly', label: 'Every 2 weeks', min: 11, max: 18 },
  { key: 'monthly', label: 'Monthly', min: 21, max: 45 },
  { key: 'quarterly', label: 'Quarterly', min: 75, max: 120 }
];

const AMOUNT_TOLERANCE_RATE = 0.1;
const MIN_AMOUNT_TOLERANCE = 10;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function round(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * multiplier) / multiplier;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mostCommon(values) {
  const counts = new Map();
  values.forEach((value) => {
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0] || 'Other';
}

function validDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function isoFromDate(date) {
  if (!validDate(date)) return null;
  return date.toISOString().slice(0, 10);
}

function parseDateValue(value) {
  if (value instanceof Date) return validDate(value) ? new Date(value.getTime()) : null;
  const text = String(value || '').trim();
  if (!text || /unresolved/i.test(text)) return null;

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const date = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T12:00:00Z`);
    return validDate(date) ? date : null;
  }

  const dayMonthYear = text.match(/^(\d{1,2})[\s/-]+([A-Za-z]{3,9})[\s/-]+(\d{4})$/);
  if (dayMonthYear) {
    const monthIndex = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .findIndex((month) => dayMonthYear[2].toLowerCase().startsWith(month));
    if (monthIndex >= 0) {
      const date = new Date(Date.UTC(Number(dayMonthYear[3]), monthIndex, Number(dayMonthYear[1]), 12));
      return validDate(date) ? date : null;
    }
  }

  const daySlashMonthYear = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (daySlashMonthYear) {
    const date = new Date(Date.UTC(Number(daySlashMonthYear[3]), Number(daySlashMonthYear[2]) - 1, Number(daySlashMonthYear[1]), 12));
    return validDate(date) ? date : null;
  }

  const parsed = new Date(text);
  return validDate(parsed) ? new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 12)) : null;
}

export function toISODate(value) {
  return isoFromDate(parseDateValue(value));
}

export function addDays(value, days) {
  const date = parseDateValue(value);
  if (!date || !Number.isFinite(Number(days))) return null;
  return isoFromDate(new Date(date.getTime() + Number(days) * DAY_MS));
}

export function normalizeMerchantName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(?:pos|purchase|card|payment|online|merchant|debit|transfer)\b/g, ' ')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cadenceForIntervals(intervals) {
  if (!intervals.length) {
    return {
      key: 'unknown',
      label: 'Not enough dates',
      intervalDays: null,
      rhythm: 'Need another dated debit',
      stable: false
    };
  }

  const intervalDays = Math.max(1, Math.round(median(intervals)));
  const band = CADENCE_BANDS.find((candidate) => intervalDays >= candidate.min && intervalDays <= candidate.max);
  const stable = intervals.every((interval) => Math.abs(interval - intervalDays) <= Math.max(3, intervalDays * 0.25));
  return {
    key: band?.key || 'custom',
    label: band?.label || `Every ${intervalDays} days`,
    intervalDays,
    rhythm: `~${intervalDays} days`,
    stable
  };
}

function eventDate(event) {
  return parseDateValue(event?.date || event?.occurredAt || event?.receivedAt);
}

function isApprovedDebitEvent(event) {
  if (!event || event.direction !== 'debit') return false;
  if (event.sourceType === 'manual' || event.sourceType === 'manual-rule') return false;
  if (event.status === 'needs_review' || event.status === 'Needs review') return false;
  if (!['approved', 'auto_approved'].includes(event.status)) return false;
  return Boolean(event.sourceId);
}

function patternNote(status, amountTolerance, cadence) {
  if (status === 'confirmed') return `Amounts stay within ±${round(amountTolerance)} EGP`;
  if (status === 'changed') return 'Latest amount is outside the observed tolerance';
  if (status === 'paused') return 'No debit arrived in the expected interval';
  if (cadence.key === 'unknown') return 'Need another dated debit to measure cadence';
  return 'Need one more matching cycle';
}

function statusLabel(status) {
  return {
    confirmed: 'Confirmed',
    signal: 'Signal',
    changed: 'Changed',
    paused: 'Paused'
  }[status] || 'Signal';
}

export function detectRecurringPatterns(events = [], options = {}) {
  const groups = new Map();
  events.filter(isApprovedDebitEvent).forEach((event) => {
    const merchant = String(event.merchant || '').trim();
    const merchantKey = normalizeMerchantName(merchant);
    const date = eventDate(event);
    const amount = Number(event.amount);
    if (!merchantKey || !date || !Number.isFinite(amount) || amount <= 0) return;
    const currency = String(event.currency || 'EGP').toUpperCase();
    const key = `${merchantKey}::${currency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ event, date, amount, currency });
  });

  const asOf = parseDateValue(options.asOf || new Date());
  return [...groups.values()]
    .map((items) => {
      const sorted = items.slice().sort((a, b) => a.date - b.date || String(a.event.id).localeCompare(String(b.event.id)));
      const amounts = sorted.map((item) => item.amount);
      const typicalAmount = median(amounts);
      const amountTolerance = Math.max(MIN_AMOUNT_TOLERANCE, typicalAmount * AMOUNT_TOLERANCE_RATE);
      const intervals = sorted.slice(1).map((item, index) => Math.round((item.date - sorted[index].date) / DAY_MS)).filter((value) => value > 0);
      const cadence = cadenceForIntervals(intervals);
      const latest = sorted[sorted.length - 1];
      const previousAmounts = sorted.slice(0, -1).map((item) => item.amount);
      const previousTypicalAmount = median(previousAmounts);
      const latestChanged = sorted.length >= 3 && previousTypicalAmount !== null
        && Math.abs(latest.amount - previousTypicalAmount) > Math.max(MIN_AMOUNT_TOLERANCE, previousTypicalAmount * AMOUNT_TOLERANCE_RATE);
      const stableAmounts = amounts.every((amount) => Math.abs(amount - typicalAmount) <= amountTolerance);
      const expectedNextDate = cadence.intervalDays ? addDays(isoFromDate(latest.date), cadence.intervalDays) : null;
      const overdueDays = asOf && latest.date < asOf && cadence.intervalDays
        ? Math.floor((asOf - latest.date) / DAY_MS)
        : 0;
      const paused = sorted.length >= 3 && cadence.stable && overdueDays > cadence.intervalDays * 1.75;
      const status = paused
        ? 'paused'
        : latestChanged
          ? 'changed'
          : sorted.length >= 3 && cadence.stable && stableAmounts
            ? 'confirmed'
            : 'signal';

      return {
        id: `observed-${normalizeMerchantName(sorted[0].event.merchant)}-${sorted[0].currency.toLowerCase()}`,
        type: 'observed',
        sourceType: 'messages-ledger',
        status,
        statusLabel: statusLabel(status),
        merchant: sorted[0].event.merchant,
        normalizedMerchant: normalizeMerchantName(sorted[0].event.merchant),
        category: mostCommon(sorted.map((item) => item.event.category || 'Other')),
        currency: sorted[0].currency,
        amount: round(typicalAmount),
        latestAmount: round(latest.amount),
        minAmount: round(Math.min(...amounts)),
        maxAmount: round(Math.max(...amounts)),
        amountTolerance: round(amountTolerance),
        cadence: cadence.label,
        cadenceKey: cadence.key,
        cadenceDays: cadence.intervalDays,
        rhythm: cadence.rhythm,
        cadenceStable: cadence.stable,
        evidenceCount: sorted.length,
        evidenceIds: sorted.map((item) => item.event.id || item.event.sourceId),
        observedDates: sorted.map((item) => isoFromDate(item.date)),
        firstObservedDate: isoFromDate(sorted[0].date),
        lastObservedDate: isoFromDate(latest.date),
        nextObservedDate: paused ? null : expectedNextDate,
        note: patternNote(status, amountTolerance, cadence)
      };
    })
    .filter((pattern) => pattern.evidenceCount >= 2)
    .sort((a, b) => String(a.merchant).localeCompare(String(b.merchant)) || a.currency.localeCompare(b.currency));
}

function manualCadence(key) {
  return MANUAL_RECURRING_CADENCES.find((cadence) => cadence.key === key);
}

export function createManualRecurringRule(transaction, input = {}) {
  if (!transaction || transaction.sourceType !== 'bank') {
    throw new Error('Manual recurring rules require an imported bank transaction');
  }
  if (transaction.status === 'Needs review' || transaction.status === 'needs_review') {
    throw new Error('Review the imported transaction before creating a manual recurring rule');
  }
  if (transaction.direction && transaction.direction !== 'debit') {
    throw new Error('Manual recurring rules require a debit transaction');
  }

  const sourceEventId = String(transaction.id || transaction.sourceId || '').trim();
  const merchant = String(input.merchant || transaction.name || transaction.merchant || '').trim();
  const amount = Number(input.amount ?? Math.abs(Number(transaction.amount)));
  const cadence = manualCadence(input.cadence || 'monthly');
  const nextExpectedDate = toISODate(input.nextExpectedDate);
  if (!sourceEventId || !merchant) throw new Error('Imported transaction identity and merchant are required');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Recurring amount must be greater than zero');
  if (!cadence) throw new Error('A supported recurring cadence is required');
  if (!nextExpectedDate) throw new Error('A valid next expected date is required');

  return {
    id: `manual-recurring-${sourceEventId}`,
    type: 'manual',
    sourceType: 'manual-rule',
    status: 'manual',
    statusLabel: 'Manual rule',
    merchant,
    normalizedMerchant: normalizeMerchantName(merchant),
    category: transaction.category || 'Other',
    currency: String(transaction.currency || 'EGP').toUpperCase(),
    amount: round(amount),
    cadence: cadence.label,
    cadenceKey: cadence.key,
    cadenceDays: cadence.days,
    nextExpectedDate,
    sourceEventId,
    sourceLabel: transaction.source || 'Messages · approved',
    originalObservedDate: toISODate(transaction.dateValue || transaction.date || transaction.occurredAt || transaction.receivedAt),
    evidenceCount: 0,
    evidenceIds: [],
    createdAt: input.createdAt || null,
    note: 'Created by you from one approved imported debit; it is not automatic evidence.'
  };
}

export function updateManualRecurringRule(rule, input = {}) {
  if (!rule || rule.sourceType !== 'manual-rule') {
    throw new Error('A saved manual recurring rule is required');
  }

  const amount = Number(input.amount ?? rule.amount);
  const cadence = manualCadence(input.cadence || rule.cadenceKey);
  const nextExpectedDate = toISODate(input.nextExpectedDate || rule.nextExpectedDate);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Recurring amount must be greater than zero');
  if (!cadence) throw new Error('A supported recurring cadence is required');
  if (!nextExpectedDate) throw new Error('A valid next expected date is required');

  return {
    ...clone(rule),
    amount: round(amount),
    cadence: cadence.label,
    cadenceKey: cadence.key,
    cadenceDays: cadence.days,
    nextExpectedDate,
    updatedAt: input.updatedAt || rule.updatedAt || null
  };
}

export function setManualRecurringRulePaused(rule, paused) {
  if (!rule || rule.sourceType !== 'manual-rule') {
    throw new Error('A saved manual recurring rule is required');
  }
  return {
    ...clone(rule),
    paused: Boolean(paused)
  };
}

export function manualRecurringCadenceOptions() {
  return clone(MANUAL_RECURRING_CADENCES);
}
