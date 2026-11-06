/* Prototype question: which local-first finance dashboard state best supports a calm daily review?
   Six states live on one route and are shareable with ?variant=overview|transactions|analytics|cash-flow|review|recurring. */

import { createHarborLedger, createMemoryStorage } from './harbor-ledger.js';
import {
  addDays,
  createManualRecurringRule,
  detectRecurringPatterns,
  manualRecurringCadenceOptions,
  setManualRecurringRulePaused,
  toISODate,
  updateManualRecurringRule
} from './harbor-recurring.js';
import {
  LEDGER_STORAGE_KEY,
  mergeLedgerSnapshots,
  normalizeLedgerSnapshot,
  sortTransactionRecords,
  summarizeScanResults,
  updateReviewCandidateSnapshot
} from './harbor-ledger-sync.js';
import { replaceStorageSnapshot } from './harbor-storage.js';
import { downloadTransactionsWorkbook } from './transaction-export.js';

const app = document.querySelector('#app');
const ledgerStorage = window.localStorage;
let harborLedger = createHarborLedger(ledgerStorage);
const MANUAL_RECURRING_STORAGE_KEY = 'harbor.manual-recurring.v1';
const DISMISSED_RECURRING_STORAGE_KEY = 'harbor.dismissed-recurring.v1';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'harbor.sidebar-collapsed.v1';
const DISPLAY_CURRENCY_STORAGE_KEY = 'harbor.display-currency.v1';
const FX_RATES_STORAGE_KEY = 'harbor.fx-rates.v1';
const SIDEBAR_COLLAPSE_MEDIA_QUERY = '(min-width: 941px)';
const TRANSACTIONS_PER_PAGE = 10;

function canonicalLedgerSnapshot(snapshot) {
  return normalizeLedgerSnapshot(snapshot, { allowLegacy: true });
}

function durableLedgerSnapshot(ledger = harborLedger) {
  return canonicalLedgerSnapshot(ledger.durableSnapshot());
}

function migrateBrowserLedgerCache() {
  const beforeRaw = ledgerStorage.getItem(LEDGER_STORAGE_KEY);
  const canonical = durableLedgerSnapshot();
  const canonicalRaw = JSON.stringify(canonical);
  if (canonicalRaw !== beforeRaw) replaceStorageSnapshot(ledgerStorage, LEDGER_STORAGE_KEY, canonical);
  harborLedger = createHarborLedger(ledgerStorage);
}

migrateBrowserLedgerCache();

document.documentElement.classList.toggle('native-shell', window.location.protocol === 'harbor:');

function loadManualRecurringRules() {
  try {
    const saved = window.localStorage.getItem(MANUAL_RECURRING_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadJsonStorageValue(key, fallback) {
  try {
    const saved = window.localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
}

function loadDisplayCurrency() {
  try {
    return window.localStorage.getItem(DISPLAY_CURRENCY_STORAGE_KEY) || 'EGP';
  } catch {
    return 'EGP';
  }
}

function loadFxRates() {
  const saved = loadJsonStorageValue(FX_RATES_STORAGE_KEY, {});
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved)
    .filter(([code, rate]) => ['USD', 'EUR'].includes(code) && Number.isFinite(Number(rate)) && Number(rate) > 0)
    .map(([code, rate]) => [code, Number(rate)]));
}

function persistDisplayCurrency(code) {
  try {
    window.localStorage.setItem(DISPLAY_CURRENCY_STORAGE_KEY, code);
    return true;
  } catch {
    return false;
  }
}

function persistFxRates(rates) {
  try {
    window.localStorage.setItem(FX_RATES_STORAGE_KEY, JSON.stringify(rates));
    return true;
  } catch {
    return false;
  }
}

function persistManualRecurringRules(rules) {
  try {
    window.localStorage.setItem(MANUAL_RECURRING_STORAGE_KEY, JSON.stringify(rules));
    return true;
  } catch {
    return false;
  }
}

function loadDismissedRecurringPatternIds() {
  try {
    const saved = window.localStorage.getItem(DISMISSED_RECURRING_STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function persistDismissedRecurringPatternIds(ids) {
  try {
    window.localStorage.setItem(DISMISSED_RECURRING_STORAGE_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

function loadSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistSidebarCollapsed(collapsed) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // The sidebar still works when local browser storage is unavailable.
  }
}

const views = [
  { id: 'overview', key: 'A', label: 'Overview', icon: 'overview' },
  { id: 'transactions', key: 'B', label: 'Transactions', icon: 'transactions' },
  { id: 'analytics', key: 'C', label: 'Analytics', icon: 'analytics' },
  { id: 'cash-flow', key: 'D', label: 'Cash Flow', icon: 'cash' },
  { id: 'review', key: 'E', label: 'Review Queue', icon: 'review' },
  { id: 'recurring', key: 'F', label: 'Recurring', icon: 'recurring' },
  { id: 'settings', key: 'G', label: 'Settings', icon: 'settings' }
];

const state = {
  view: getViewFromUrl(),
  transactionDetailId: getTransactionIdFromUrl(),
  isEditing: false,
  reviewCandidateId: null,
  toast: '',
  showAddTransaction: false,
  showRecurringRule: false,
  recurringRuleTransactionId: null,
  editingRecurringRuleId: null,
  manualTransactions: [],
  manualRecurringRules: loadManualRecurringRules(),
  dismissedRecurringPatternIds: loadDismissedRecurringPatternIds(),
  sidebarCollapsed: loadSidebarCollapsed(),
  transactionFilter: 'all',
  transactionCategory: 'all',
  transactionQuery: '',
  transactionPage: 1,
  trendTimeframe: '4',
  displayCurrency: loadDisplayCurrency(),
  fxRates: loadFxRates()
};

const DISPLAY_CURRENCIES = [
  { code: 'EGP', name: 'Egyptian pound' },
  { code: 'USD', name: 'US dollar' },
  { code: 'EUR', name: 'Euro' }
];

const DISPLAY_CURRENCY_BY_CODE = Object.fromEntries(
  DISPLAY_CURRENCIES.map((currency) => [currency.code, currency])
);

if (!DISPLAY_CURRENCY_BY_CODE[state.displayCurrency]
  || (state.displayCurrency !== 'EGP' && !state.fxRates[state.displayCurrency])) {
  state.displayCurrency = 'EGP';
  persistDisplayCurrency('EGP');
}

const overviewTrendRanges = {
  1: { label: '1 week', days: 7 },
  2: { label: '2 weeks', days: 14 },
  4: { label: '4 weeks', days: 28 },
  8: { label: '8 weeks', days: 56 }
};

const iconPaths = {
  overview: '<path d="M4 12.5 12 5l8 7.5"/><path d="M6.5 11.5V19h11v-7.5"/><path d="M9.5 19v-4.8h5V19"/>',
  transactions: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  analytics: '<path d="M4 19V5M4 19h16"/><path d="m7 15 3-3 3 2 5-6"/><circle cx="7" cy="15" r="1"/><circle cx="10" cy="12" r="1"/><circle cx="13" cy="14" r="1"/><circle cx="18" cy="8" r="1"/>',
  recurring: '<path d="M18 8a6.5 6.5 0 0 0-11.7-2.8L5 7"/><path d="M5 3v4h4"/><path d="M6 16a6.5 6.5 0 0 0 11.7 2.8L19 17"/><path d="M19 21v-4h-4"/>',
  cash: '<path d="M4 18.5V11"/><path d="M9 18.5V6"/><path d="M14 18.5v-4"/><path d="M19 18.5V4"/><path d="M3 20h18"/>',
  review: '<path d="M4 5.5h16v13H4z"/><path d="m8 12 2.5 2.5L16 9"/>',
  settings: '<path d="M12 15.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z"/><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.8 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.8-1.2l-.1.1a1.7 1.7 0 0 1-2.4-2.4l.1-.1A1.7 1.7 0 0 0 6.4 12a1.7 1.7 0 0 1-1.7-1.7 1.7 1.7 0 0 1 1.7-1.7 1.7 1.7 0 0 0 1.2-2.8l-.1-.1a1.7 1.7 0 0 1 2.4-2.4l.1.1A1.7 1.7 0 0 0 12.8 2a1.7 1.7 0 0 1 1.7 1.7v.2a1.7 1.7 0 0 0 2.8 1.2l.1-.1a1.7 1.7 0 0 1 2.4 2.4l-.1.1A1.7 1.7 0 0 0 20.8 10a1.7 1.7 0 0 1 0 3.4 1.7 1.7 0 0 0-1.4 1.6Z"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  shield: '<path d="M12 3 19 6v5c0 4.5-2.8 8.2-7 10-4.2-1.8-7-5.5-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
  trendUp: '<path d="m4 16 5-5 3 3 7-8"/><path d="M14 6h5v5"/>',
  trendDown: '<path d="m4 8 5 5 3-3 7 8"/><path d="M14 18h5v-5"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  check: '<path d="m5 12 4.2 4.2L19 6.5"/>',
  edit: '<path d="m4 16.5-.7 3.2 3.2-.7L18 7.5a2.2 2.2 0 0 0-3.1-3.1L4 16.5Z"/><path d="m13.5 5.5 3 3"/>',
  message: '<path d="M4 5h16v11H8l-4 4V5Z"/><path d="M8 9h8M8 12h5"/>',
  bank: '<path d="m3 9 9-5 9 5"/><path d="M5 10v7M9 10v7M15 10v7M19 10v7M3 20h18M3 9h18"/>',
  coffee: '<path d="M5 8h11v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V8Z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 4v2M12 3v3"/>',
  home: '<path d="m4 10 8-6 8 6"/><path d="M6 9v10h12V9"/><path d="M10 19v-5h4v5"/>',
  cart: '<path d="M4 5h2l1.5 9h9L19 8H7"/><circle cx="9" cy="18" r="1"/><circle cx="17" cy="18" r="1"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H19v14H6.5A2.5 2.5 0 0 1 4 16.5v-9Z"/><path d="M4 8h15M15 12h4v3h-4a1.5 1.5 0 0 1 0-3Z"/>',
  bolt: '<path d="m13 2-8 11h6l-1 9 8-11h-6l1-9Z"/>',
  alert: '<path d="M12 4 21 20H3L12 4Z"/><path d="M12 10v4M12 17h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4 4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>'
};

function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
}

function getViewFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('variant');
  if (requested === 'transaction' && params.get('id')) return 'transaction';
  return views.some((view) => view.id === requested) ? requested : 'overview';
}

function getTransactionIdFromUrl() {
  return new URLSearchParams(window.location.search).get('id') || null;
}

function transactionDetailUrl(transactionId) {
  return `?variant=transaction&id=${encodeURIComponent(transactionId)}`;
}

function currencyDefinition(code) {
  const definition = DISPLAY_CURRENCY_BY_CODE[code] || DISPLAY_CURRENCY_BY_CODE.EGP;
  return {
    ...definition,
    egpPerUnit: definition.code === 'EGP' ? 1 : state.fxRates[definition.code] || null
  };
}

function convertCurrency(value, sourceCurrency = 'EGP', targetCurrency = state.displayCurrency) {
  const amount = Number(value) || 0;
  const source = currencyDefinition(sourceCurrency);
  const target = currencyDefinition(targetCurrency);
  if (source.code === target.code) return amount;
  if (source.code !== target.code && (!source.egpPerUnit || !target.egpPerUnit)) return null;
  return amount * source.egpPerUnit / target.egpPerUnit;
}

function formatCurrency(value, sourceCurrency = 'EGP') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Unavailable';
  const source = currencyDefinition(sourceCurrency);
  const targetCurrency = currencyDefinition(state.displayCurrency);
  const convertedAmount = convertCurrency(value, sourceCurrency, targetCurrency.code);
  if (convertedAmount === null) {
    return `${source.code} ${Number(value).toLocaleString('en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · rate unavailable`;
  }
  return `${targetCurrency.code} ${convertedAmount.toLocaleString('en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedCurrency(value, sourceCurrency = 'EGP', direction = '') {
  const amount = Number(value) || 0;
  const sign = amount < 0 || (amount === 0 && direction === 'debit') ? '-' : '+';
  return `${sign}${formatCurrency(Math.abs(amount), sourceCurrency)}`;
}

function currencySelect(id) {
  const currency = currencyDefinition(state.displayCurrency);
  const availableCurrencies = DISPLAY_CURRENCIES.filter((item) => item.code === 'EGP' || state.fxRates[item.code]);
  const selectedCode = availableCurrencies.some((item) => item.code === state.displayCurrency) ? state.displayCurrency : 'EGP';
  const rateNote = currency.code === 'EGP'
    ? 'Base currency'
    : currency.egpPerUnit
      ? `Manual rate · EGP ${currency.egpPerUnit.toFixed(2)} = 1 ${currency.code}`
      : 'No manual rate saved';
  return `<div class="currency-control">${sumiDropdown({
    id,
    label: 'Display currency',
    value: selectedCode,
    options: availableCurrencies.map((item) => ({ value: item.code, label: `${item.code} · ${item.name}` })),
    inputAttributes: 'data-display-currency'
  })}<small>${rateNote}</small></div>`;
}

function sumiDropdown({ id, label, value, options, inputAttributes = '', className = '' }) {
  const selectedOption = options.find((option) => String(option.value) === String(value)) || options[0];
  const labelId = `${id}-label`;
  const menuId = `${id}-menu`;
  const optionMarkup = options.map((option) => {
    const selected = String(option.value) === String(selectedOption.value);
    return `<button class="sumi-dropdown__option" type="button" role="option" data-sumi-dropdown-value="${escapeHtml(option.value)}" aria-selected="${selected}"><span>${escapeHtml(option.label)}</span><span class="sumi-dropdown__state">${selected ? 'SELECTED' : ''}</span></button>`;
  }).join('');
  return `<div class="sumi-dropdown ${className}" data-sumi-dropdown><span class="sumi-dropdown__label" id="${labelId}">${escapeHtml(label)}</span><input type="hidden" id="${id}" value="${escapeHtml(selectedOption.value)}" ${inputAttributes} /><button class="sumi-dropdown__trigger" id="${id}-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${menuId}" aria-labelledby="${labelId} ${id}-value"><span class="sumi-dropdown__value" id="${id}-value">${escapeHtml(selectedOption.label)}</span><span class="sumi-dropdown__chevron">${icon('chevronDown', 14)}</span></button><div class="sumi-dropdown__menu" id="${menuId}" role="listbox" aria-labelledby="${labelId}" hidden>${optionMarkup}</div></div>`;
}

function formatProjectionDate(value, fallback = 'Not available') {
  const isoDate = toISODate(value);
  if (!isoDate) return fallback;
  const date = new Date(`${isoDate}T12:00:00Z`);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function dateInputValue(value) {
  return toISODate(value) || new Date().toISOString().slice(0, 10);
}

function recurringIconForCategory(category = '') {
  const normalized = category.toLowerCase();
  if (normalized.includes('home') || normalized.includes('utility')) return 'home';
  if (normalized.includes('transport')) return 'card';
  if (normalized.includes('subscription')) return 'bolt';
  if (normalized.includes('food') || normalized.includes('eating')) return 'coffee';
  return 'card';
}

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (character) => entities[character]);
}

function reviewCandidateAmount(candidate) {
  const signedAmount = candidate.direction === 'credit' ? candidate.amount : -candidate.amount;
  return signedCurrency(signedAmount, candidate.currency || 'EGP', candidate.direction || 'debit');
}

function sumConverted(items, valueForItem, targetCurrency = 'EGP') {
  let total = 0;
  for (const item of items) {
    const converted = convertCurrency(valueForItem(item), item.currency || 'EGP', targetCurrency);
    if (converted === null) return null;
    total += converted;
  }
  return total;
}

function nativeCurrencyTotals(items = []) {
  const totals = new Map();
  for (const item of items) {
    const amount = Number(item?.amount);
    if (!Number.isFinite(amount)) continue;
    const currency = String(item?.currency || 'EGP').trim().toUpperCase() || 'EGP';
    totals.set(currency, (totals.get(currency) || 0) + amount);
  }
  return [...totals.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((left, right) => {
      if (left.currency === state.displayCurrency) return -1;
      if (right.currency === state.displayCurrency) return 1;
      if (left.currency === 'EGP') return -1;
      if (right.currency === 'EGP') return 1;
      return left.currency.localeCompare(right.currency);
    });
}

function formatNativeCurrencyTotal({ currency, total }) {
  return `${currency} ${total.toLocaleString('en-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function canDisplayConvertedSpending(convertedTotal) {
  if (convertedTotal === null) return false;
  return !/unavailable/i.test(formatCurrency(convertedTotal));
}

function approvedSpendingText(debits, convertedTotal) {
  if (canDisplayConvertedSpending(convertedTotal)) return formatCurrency(convertedTotal);
  const totals = nativeCurrencyTotals(debits).map(formatNativeCurrencyTotal);
  return totals.length ? totals.join(' + ') : formatCurrency(0);
}

function approvedSpendingMarkup(debits, convertedTotal) {
  if (canDisplayConvertedSpending(convertedTotal)) return escapeHtml(formatCurrency(convertedTotal));
  const totals = nativeCurrencyTotals(debits);
  if (!totals.length) return escapeHtml(formatCurrency(0));
  return totals.map((total, index) => `<span class="${index ? 'position-value-secondary' : 'position-value-primary'}">${escapeHtml(formatNativeCurrencyTotal(total))}</span>`).join('');
}

function liveLedgerSummary() {
  const snapshot = harborLedger.snapshot();
  const approved = snapshot.events || [];
  const reviews = snapshot.reviewCandidates || [];
  const debits = approved.filter((event) => (event.direction || 'debit') === 'debit');
  const credits = approved.filter((event) => event.direction === 'credit');
  const debitTotal = sumConverted(debits, (event) => event.amount, 'EGP');
  const creditTotal = sumConverted(credits, (event) => event.amount, 'EGP');
  const categories = debits.reduce((map, event) => {
    const category = event.category || 'Other';
    const converted = convertCurrency(event.amount, event.currency || 'EGP', 'EGP');
    if (converted !== null) map[category] = (map[category] || 0) + converted;
    return map;
  }, {});
  const unavailableCurrencies = [...new Set(debits.concat(credits)
    .filter((event) => convertCurrency(event.amount, event.currency || 'EGP', 'EGP') === null)
    .map((event) => event.currency || 'EGP'))];
  return { snapshot, approved, reviews, debits, credits, debitTotal, creditTotal, categories, unavailableCurrencies };
}

function categoryAmount(categories, aliases) {
  const wanted = aliases.map((alias) => alias.toLowerCase());
  return Object.entries(categories).reduce((sum, [name, amount]) => {
    const normalized = name.toLowerCase();
    return sum + (wanted.some((alias) => normalized.includes(alias)) ? amount : 0);
  }, 0);
}

function observedTrend(debits, selectedRange) {
  const range = overviewTrendRanges[selectedRange] || overviewTrendRanges[4];
  const datedDebits = debits
    .map((event) => ({ event, date: toISODate(event.date || event.receivedAt) }))
    .filter((item) => item.date);
  const latestDate = datedDebits.map((item) => item.date).sort().at(-1) || dateInputValue(new Date());
  const anchor = new Date(`${latestDate}T12:00:00Z`);
  const slots = Math.min(8, range.days);
  const daysPerSlot = Math.ceil(range.days / slots);
  const start = new Date(anchor.getTime() - ((range.days - 1) * 86400000));
  const buckets = Array.from({ length: slots }, (_, index) => ({
    start: new Date(start.getTime() + (index * daysPerSlot * 86400000)),
    total: 0
  }));
  datedDebits.forEach(({ event, date }) => {
    const eventDate = new Date(`${date}T12:00:00Z`);
    const offset = Math.floor((eventDate - start) / 86400000);
    const bucket = Math.floor(offset / daysPerSlot);
    const converted = convertCurrency(event.amount, event.currency || 'EGP', 'EGP');
    if (bucket >= 0 && bucket < buckets.length && converted !== null) buckets[bucket].total += converted;
  });
  const highest = Math.max(...buckets.map((bucket) => bucket.total), 0);
  return {
    ...range,
    total: buckets.reduce((sum, bucket) => sum + bucket.total, 0),
    values: buckets.map((bucket) => highest ? 156 - ((bucket.total / highest) * 124) : 156),
    labels: buckets.map((bucket) => bucket.start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }))
  };
}

function categoryBreakdown(categories, total) {
  return Object.entries(categories)
    .map(([name, amount]) => ({ name, amount, share: total ? (amount / total) * 100 : 0 }))
    .sort((left, right) => right.amount - left.amount);
}

function stageLedgerFromSnapshot(snapshot) {
  const storage = createMemoryStorage();
  storage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(canonicalLedgerSnapshot(snapshot)));
  return { storage, ledger: createHarborLedger(storage) };
}

function exposeLedgerBridge() {
  window.__harborLedger = harborLedger;
  window.__harborGetLedgerSnapshot = () => durableLedgerSnapshot();
  window.__harborReplaceLedgerSnapshot = (snapshot, options = {}) => replaceLedgerSnapshot(snapshot, options);
  window.__harborApplyMessageBatch = (messages) => applyMessageBatch(messages);
  window.__harborApproveReviewCandidate = (candidateId, input = null) => approveReviewCandidate(candidateId, input);
  window.__harborDismissReviewCandidate = (candidateId) => dismissReviewCandidate(candidateId);
}

function notifyLedgerChanged(snapshot) {
  if (typeof window.__harborLedgerChanged !== 'function') return;
  Promise.resolve(window.__harborLedgerChanged(snapshot)).catch(() => {
    // The service sync surface reports its own failure without changing local state.
  });
}

function replaceLedgerSnapshot(snapshot, { notifyRemote = true, renderNow = true } = {}) {
  replaceStorageSnapshot(ledgerStorage, LEDGER_STORAGE_KEY, canonicalLedgerSnapshot(snapshot));
  harborLedger = createHarborLedger(ledgerStorage);
  exposeLedgerBridge();
  if (notifyRemote) notifyLedgerChanged(durableLedgerSnapshot());
  if (renderNow) render();
  return canonicalLedgerSnapshot(harborLedger.snapshot());
}

function applyMessageBatch(messages = []) {
  const beforeSnapshot = durableLedgerSnapshot();
  const beforeRaw = ledgerStorage.getItem(LEDGER_STORAGE_KEY);
  const { storage, ledger } = stageLedgerFromSnapshot(beforeSnapshot);
  const results = [];
  try {
    for (const message of messages) {
      try {
        results.push(ledger.ingest(message));
      } catch (error) {
        results.push({ kind: 'failed', error: error instanceof Error ? error.message : 'The message could not be ingested.' });
        const batchError = new Error('The local ledger was not changed because one message could not be saved.');
        batchError.cause = error;
        batchError.scanSummary = summarizeScanResults(results, messages.length);
        throw batchError;
      }
    }
    const nextSnapshot = canonicalLedgerSnapshot(JSON.parse(storage.getItem(LEDGER_STORAGE_KEY)));
    try {
      replaceLedgerSnapshot(nextSnapshot, { notifyRemote: true, renderNow: true });
    } catch (error) {
      if (beforeRaw === null) ledgerStorage.removeItem(LEDGER_STORAGE_KEY);
      else ledgerStorage.setItem(LEDGER_STORAGE_KEY, beforeRaw);
      harborLedger = createHarborLedger(ledgerStorage);
      exposeLedgerBridge();
      throw error;
    }
    return { results, snapshot: nextSnapshot, summary: summarizeScanResults(results, messages.length) };
  } catch (error) {
    if (error.scanSummary) throw error;
    const batchError = new Error('The local ledger was not changed because the scan could not be completed.');
    batchError.cause = error;
    batchError.scanSummary = summarizeScanResults(results, messages.length);
    throw batchError;
  }
}

function approveReviewCandidate(candidateId, input = null) {
  let snapshot = durableLedgerSnapshot();
  let staged = stageLedgerFromSnapshot(snapshot);
  const supportsCandidateEditEvidence = typeof staged.ledger.editCandidate === 'function';
  if (input && !supportsCandidateEditEvidence) {
    // Keep the compatibility path for the legacy fixture ledger. The v2 ledger
    // path below must receive overrides directly so it appends edit evidence.
    snapshot = updateReviewCandidateSnapshot(snapshot, candidateId, input);
    staged = stageLedgerFromSnapshot(snapshot);
  }
  const result = staged.ledger.approveCandidate(
    candidateId,
    supportsCandidateEditEvidence ? (input || {}) : undefined
  );
  if (result.kind === 'approved' || result.kind === 'invalid') {
    // Invalid attempts can contain saved field edits plus append-only rejection
    // evidence. Commit that staged state without creating an approved event.
    replaceLedgerSnapshot(JSON.parse(staged.storage.getItem(LEDGER_STORAGE_KEY)), { notifyRemote: true, renderNow: true });
  }
  return result;
}

function dismissReviewCandidate(candidateId) {
  const staged = stageLedgerFromSnapshot(durableLedgerSnapshot());
  const result = staged.ledger.dismissCandidate(candidateId);
  if (result.kind === 'dismissed') {
    replaceLedgerSnapshot(staged.ledger.durableSnapshot(), { notifyRemote: true, renderNow: true });
  }
  return result;
}

const REVIEW_FIELD_REASON_PATTERNS = [
  { field: 'merchant', pattern: /merchant|description/i },
  { field: 'amount', pattern: /amount/i },
  { field: 'date', pattern: /date/i },
  { field: 'category', pattern: /category/i }
];

function reviewFieldForReason(reason) {
  const match = REVIEW_FIELD_REASON_PATTERNS.find(({ pattern }) => pattern.test(String(reason || '')));
  return match?.field || null;
}

function firstInvalidReviewField(reasons = []) {
  return (Array.isArray(reasons) ? reasons : [reasons]).map(reviewFieldForReason).find(Boolean) || null;
}

function reviewApprovalFailureMessage(result) {
  if (result?.kind === 'invalid') {
    const reasons = Array.isArray(result.reasons) && result.reasons.length
      ? result.reasons
      : ['Ledger validation failed. Review the fields and try again.'];
    return `Approval blocked: ${reasons.join(' · ')}`;
  }
  if (result?.kind === 'missing') return 'This review item is no longer available.';
  return 'Approval could not be completed. Review this item and try again.';
}

function focusReviewField(reasons = []) {
  const field = firstInvalidReviewField(reasons);
  if (!field) return;
  const input = document.querySelector(`[data-review-field="${field}"]`);
  input?.focus();
  input?.select?.();
}

function setView(viewId) {
  if (!views.some((view) => view.id === viewId)) return;
  state.view = viewId;
  state.transactionDetailId = null;
  state.isEditing = false;
  const url = new URL(window.location.href);
  url.searchParams.set('variant', viewId);
  url.searchParams.delete('id');
  window.history.replaceState({}, '', url);
  render();
}

function isSidebarCollapsed() {
  return state.sidebarCollapsed && window.matchMedia(SIDEBAR_COLLAPSE_MEDIA_QUERY).matches;
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  persistSidebarCollapsed(collapsed);

  const isCollapsed = isSidebarCollapsed();
  const shell = document.querySelector('.app-shell');
  const sidebarPanel = document.querySelector('[data-sidebar-panel]');
  const sidebarRail = document.querySelector('[data-sidebar-rail-nav]');
  const toggle = document.querySelector('[data-sidebar-toggle]');

  shell?.classList.toggle('sidebar-collapsed', isCollapsed);
  sidebarPanel?.setAttribute('aria-hidden', String(isCollapsed));
  sidebarPanel?.toggleAttribute('inert', isCollapsed);
  sidebarRail?.setAttribute('aria-hidden', String(!isCollapsed));
  sidebarRail?.toggleAttribute('inert', !isCollapsed);
  sidebarPanel?.querySelectorAll('[data-sidebar-panel-item]').forEach((item) => {
    item.tabIndex = isCollapsed ? -1 : 0;
  });
  sidebarRail?.querySelectorAll('[data-sidebar-rail-item]').forEach((item) => {
    item.tabIndex = isCollapsed ? 0 : -1;
  });
  if (toggle) {
    toggle.setAttribute('aria-label', isCollapsed ? 'Maximize sidebar' : 'Minimize sidebar');
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.setAttribute('title', isCollapsed ? 'Maximize sidebar' : 'Minimize sidebar');
    toggle.classList.toggle('sidebar-toggle--open', isCollapsed);
    toggle.classList.toggle('sidebar-toggle--close', !isCollapsed);
  }
}

function currentView() {
  if (state.view === 'transaction') {
    return { id: 'transaction', key: 'B', label: 'Transaction details', icon: 'transactions' };
  }
  return views.find((view) => view.id === state.view) || views[0];
}

function showToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    state.toast = '';
    render();
  }, 3600);
}

function renderSidebarNavItem(view, { compact = false, collapsed = false } = {}) {
  const isReview = view.id === 'review';
  const openReviews = harborLedger.snapshot().reviewCandidates.length;
  const isCurrent = state.view === view.id || (state.view === 'transaction' && view.id === 'transactions');
  const label = escapeHtml(view.label);
  const count = compact
    ? (isReview && openReviews > 0 ? `<span class="sidebar-rail-count">${openReviews}</span>` : '')
    : (isReview && openReviews > 0 ? '<span class="nav-count">' + openReviews + '</span>' : '');

  if (compact) {
    return `<button class="sidebar-rail-item" data-sidebar-rail-item data-view="${view.id}" aria-current="${isCurrent ? 'page' : 'false'}" aria-label="${label}" title="${label}" tabindex="${collapsed ? '0' : '-1'}">
      ${icon(view.icon, 17)}<span class="sr-only">${label}</span>${count}
    </button>`;
  }

  return `<button class="nav-item" data-sidebar-panel-item data-view="${view.id}" aria-current="${isCurrent ? 'page' : 'false'}" tabindex="${collapsed ? '-1' : '0'}">
    ${icon(view.icon, 17)}
    <span>${label}</span>
    ${count}
  </button>`;
}

function renderSidebar() {
  const collapsed = isSidebarCollapsed();
  const nav = views.filter((view) => view.id !== 'settings').map((view) => renderSidebarNavItem(view, { collapsed })).join('');
  const settings = renderSidebarNavItem(views.find((view) => view.id === 'settings'), { collapsed });
  const railNav = views.map((view) => renderSidebarNavItem(view, { compact: true, collapsed })).join('');

  return `<aside class="sidebar">
      <div class="identity-rail" aria-label="Zoid Bank identity rail">
        <button class="sidebar-toggle ${collapsed ? 'sidebar-toggle--open' : 'sidebar-toggle--close'}" data-sidebar-toggle type="button" aria-controls="primary-sidebar-navigation" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Maximize sidebar' : 'Minimize sidebar'}" title="${collapsed ? 'Maximize sidebar' : 'Minimize sidebar'}"><span></span><span></span><span></span></button>
        <span class="identity-code">ZB</span>
        <span class="identity-rule"></span>
        <nav class="sidebar-rail-nav" data-sidebar-rail-nav aria-label="Compact dashboard modes" aria-hidden="${!collapsed}"${collapsed ? '' : ' inert'}>${railNav}</nav>
        <span class="identity-foot">LOCAL</span>
      </div>
    <div class="sidebar-main" id="primary-sidebar-navigation" data-sidebar-panel aria-hidden="${collapsed}"${collapsed ? ' inert' : ''}>
      <div class="brand"><span class="brand-mark">ZB</span><span><span class="brand-name">Zoid Bank</span><small>Private signal ledger</small></span></div>
      <div class="nav-label">Command index</div>
      <nav class="nav-list" aria-label="Dashboard modes">
        ${nav}
      </nav>
      <div class="nav-label">Workspace</div>
      ${settings}
      <div class="sidebar-spacer"></div>
      <div class="local-card">
        <div class="local-card-head"><span class="status-dot"></span><span>Local boundary</span></div>
        <p>Only approved bank alerts enter this Mac Mini ledger. Messages are read locally.</p>
      </div>
    </div>
  </aside>`;
}

function renderTopbar() {
  return `<header class="topbar">
    <div class="breadcrumbs"><span>Zoid Bank</span><span class="breadcrumb-slash">/</span><strong>${currentView().label}</strong></div>
  </header>`;
}

function renderPageHeading({ eyebrow, title, description, amber = false, action = '' }) {
  const titleId = state.view === 'cash-flow' ? 'cash-flow-title' : `${state.view}-title`;
  return `<div class="page-heading">
    <div class="page-heading-copy">
      ${eyebrow ? `<p class="eyebrow${amber ? ' amber' : ''}">${eyebrow}</p>` : ''}
      <h1 id="${titleId}">${title}</h1>
      <p class="heading-description">${description}</p>
    </div>
    ${action ? `<div class="heading-actions">${action}</div>` : ''}
  </div>`;
}

function addTransactionButton() {
  return `<button class="button button-secondary" data-action="open-add">${icon('plus', 14)}Add transaction</button>`;
}

function renderOverview() {
  const live = liveLedgerSummary();
  const reviewCount = live.reviews.length;
  const patterns = detectRecurringPatterns(live.debits);
  const trend = observedTrend(live.debits, state.trendTimeframe);
  return `<section class="page" aria-labelledby="overview-title">
    ${renderPageHeading({
      eyebrow: '',
      title: 'Overview',
      description: 'Your approved spending and latest transactions.',
      action: `${addTransactionButton()}${reviewCount ? `<button class="button button-amber" data-view="review">Review ${reviewCount} item${reviewCount === 1 ? '' : 's'}</button>` : ''}`
    })}
    <div class="overview-hero">
      <article class="card position-card">
        <span class="card-label">Approved spending</span>
        <div class="position-value${canDisplayConvertedSpending(live.debitTotal) ? '' : ' position-value-split'}">${approvedSpendingMarkup(live.debits, live.debitTotal)}</div>
        <div class="position-meta"><span class="source-chip source-chip-dark">${icon('message', 11)} Bank SMS only</span><span class="muted-inverse">${canDisplayConvertedSpending(live.debitTotal) ? 'Approved debit messages to date' : 'Native currency totals shown separately · no estimated conversion'}</span></div>
        <div class="position-footer">
          <div><span class="metric-number">${live.debits.length}</span><span class="muted-inverse">Approved debit SMS</span></div>
        </div>
      </article>
      <article class="card trend-card">
        <div class="card-header"><div><span class="card-label">Approved spending trend</span><h2>Observed debits over ${trend.label}</h2></div><div class="trend-controls">${sumiDropdown({ id: 'trend-timeframe', label: 'Range', value: state.trendTimeframe, options: Object.entries(overviewTrendRanges).map(([value, range]) => ({ value, label: range.label })), className: 'sumi-dropdown--compact' })}<div class="trend-total">${formatCurrency(trend.total)}<small>Approved debit messages only</small></div></div></div>
        <div class="chart-wrap">${overviewTrendChart(trend)}</div>
      </article>
    </div>
    ${renderRecentTransactions()}
  </section>`;
}

function allocationRow(name, value, width, tone) {
  return `<div class="allocation-item"><div class="allocation-row"><span class="allocation-name"><i class="${tone}"></i>${name}</span><span class="allocation-value">${value}</span></div><div class="allocation-track"><div class="allocation-fill ${tone}" style="width:${width}%"></div></div></div>`;
}

function renderRecentTransactions() {
  const items = transactionLedger()
    .filter((item) => item.status !== 'Needs review')
    .slice(0, 6);
  return `<article class="card transactions-card"><div class="card-header"><div><span class="card-label">Activity</span><h3>Recent transactions</h3></div><button class="button button-quiet" data-view="transactions">See all transactions ${icon('arrowRight', 13)}</button></div><div class="transaction-list">${items.length ? items.map((item) => `<div class="transaction-row"><div class="transaction-main"><span class="transaction-icon">${icon(item.icon, 15)}</span><div class="transaction-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.meta)}</span></div></div><div class="transaction-amount">${item.sourceType === 'manual' ? manualDisplayAmount(item.type, item.amount) : signedCurrency(item.amount, item.currency, item.direction)}<small>${item.sourceType === 'manual' ? 'Manual entry' : 'Approved debit'}</small></div></div>`).join('') : '<div class="transaction-empty"><strong>No local activity yet</strong><p>Scan approved Messages alerts or add a manual note to begin.</p></div>'}</div></article>`;
}

function manualIcon(type) {
  return { income: 'trendUp', expense: 'card', cash: 'wallet', transfer: 'arrowRight', adjustment: 'edit' }[type] || 'edit';
}

function manualTypeLabel(type) {
  return { income: 'Income', expense: 'Expense', cash: 'Cash', transfer: 'Transfer', adjustment: 'Adjustment' }[type] || 'Entry';
}

function manualDisplayAmount(type, amount) {
  const formatted = formatCurrency(amount);
  if (type === 'income') return `+${formatted}`;
  if (type === 'expense' || type === 'cash') return `-${formatted}`;
  if (type === 'transfer') return `↔ ${formatted}`;
  return `± ${formatted}`;
}

function transactionLedger() {
  const manual = state.manualTransactions.map((item) => ({
    id: `manual-${item.date}-${item.description}`,
    icon: manualIcon(item.type),
    name: item.description,
    meta: item.date,
    category: manualTypeLabel(item.type),
    type: item.type,
    amount: item.amount,
    currency: 'EGP',
    sourceType: 'manual',
    source: `Manual entry · ${manualTypeLabel(item.type)}`,
    status: 'Manual',
    dateValue: toISODate(item.date),
    originalMessage: null,
    preview: null
  }));
  const ledgerSnapshot = harborLedger.snapshot();
  const pendingReviews = ledgerSnapshot.reviewCandidates
    .map((candidate) => ({
      id: candidate.id,
      sourceId: candidate.sourceId,
      icon: 'alert',
      name: candidate.merchant,
      meta: candidate.date,
      dateValue: toISODate(candidate.date || candidate.receivedAt),
      category: candidate.category,
      amount: candidate.direction === 'credit' ? candidate.amount : -candidate.amount,
      currency: candidate.currency || 'EGP',
      direction: candidate.direction || 'debit',
      sourceType: 'bank',
      source: 'Messages · needs review',
      status: 'Needs review',
      sender: candidate.sender,
      senderProfileId: candidate.senderProfileId,
      senderProfileName: candidate.senderProfileName,
      parserVersion: candidate.parserVersion,
      receivedAt: candidate.receivedAt,
      preview: candidate.preview,
      originalMessage: candidate.originalMessage,
      reasons: candidate.reasons,
      decision: null
    }));
  const automaticallyApproved = ledgerSnapshot.events.map((event) => ({
    id: event.id,
    sourceId: event.sourceId,
    icon: recurringIconForCategory(event.category),
    name: event.merchant,
    meta: event.date,
    dateValue: toISODate(event.date || event.receivedAt),
    category: event.category,
    amount: event.direction === 'credit' ? event.amount : -event.amount,
    currency: event.currency || 'EGP',
    direction: event.direction || 'debit',
      sourceType: 'bank',
      source: event.source || (event.decision?.mode === 'manual' ? 'Messages · manually approved' : 'Messages · approved'),
      status: event.status === 'approved' ? 'Approved' : 'Auto-approved',
      senderProfileId: event.senderProfileId,
      senderProfileName: event.senderProfileName,
      parserVersion: event.parserVersion,
      receivedAt: event.receivedAt,
      preview: event.preview,
      originalMessage: event.originalMessage,
      decision: event.decision
  }));
  return sortTransactionRecords([...manual, ...pendingReviews, ...automaticallyApproved]);
}

function ledgerAmount(item) {
  if (item.sourceType === 'manual') return manualDisplayAmount(item.type, item.amount);
  return signedCurrency(item.amount, item.currency || 'EGP', item.direction);
}

function transactionRowMatches(item) {
  const query = state.transactionQuery.trim().toLowerCase();
  const matchesQuery = !query || `${item.name} ${item.category} ${item.source} ${item.meta}`.toLowerCase().includes(query);
  const matchesFilter = state.transactionFilter === 'all'
    || (state.transactionFilter === 'bank' && item.sourceType === 'bank')
    || (state.transactionFilter === 'manual' && item.sourceType === 'manual')
    || (state.transactionFilter === 'review' && item.status === 'Needs review');
  const matchesCategory = state.transactionCategory === 'all'
    || (item.category || 'Other') === state.transactionCategory;
  return matchesQuery && matchesFilter && matchesCategory;
}

function transactionCategorySelect(ledger) {
  const categories = [...new Set(ledger.map((item) => item.category || 'Other'))]
    .sort((left, right) => left.localeCompare(right));
  return `<div class="transaction-category-control">${sumiDropdown({
    id: 'transaction-category',
    label: 'Category',
    value: state.transactionCategory,
    options: [{ value: 'all', label: 'All categories' }, ...categories.map((category) => ({ value: category, label: category }))],
    inputAttributes: 'data-transaction-category'
  })}</div>`;
}

function renderTransactions() {
  const ledger = transactionLedger();
  const visible = ledger.filter(transactionRowMatches);
  const pageCount = Math.max(1, Math.ceil(visible.length / TRANSACTIONS_PER_PAGE));
  const currentPage = Math.min(state.transactionPage, pageCount);
  state.transactionPage = currentPage;
  const pageStart = (currentPage - 1) * TRANSACTIONS_PER_PAGE;
  const pageItems = visible.slice(pageStart, pageStart + TRANSACTIONS_PER_PAGE);
  const rangeStart = visible.length ? pageStart + 1 : 0;
  const rangeEnd = Math.min(pageStart + TRANSACTIONS_PER_PAGE, visible.length);
  const bankCount = ledger.filter((item) => item.sourceType === 'bank').length;
  const manualCount = ledger.filter((item) => item.sourceType === 'manual').length;
  const reviewCount = ledger.filter((item) => item.status === 'Needs review').length;
  return `<section class="page" aria-labelledby="transactions-title">
    ${renderPageHeading({
      eyebrow: '',
      title: 'Transactions',
      description: 'Search, filter, and manage your local transaction record.',
      action: `${addTransactionButton()}<button class="button button-secondary" data-action="export-transactions"${visible.length ? '' : ' disabled aria-disabled="true"'}>Export view ${icon('arrowRight', 15)}</button>`
    })}
    <div class="transactions-toolbar card"><div class="transaction-filter-group" role="group" aria-label="Transaction filters">
      ${transactionFilterButton('all', 'All activity', ledger.length)}
      ${transactionFilterButton('bank', 'Bank SMS', bankCount)}
      ${transactionFilterButton('manual', 'Manual', manualCount)}
      ${transactionFilterButton('review', 'Needs review', reviewCount)}
    </div><div class="transaction-toolbar-controls">${transactionCategorySelect(ledger)}${currencySelect('transaction-currency')}<label class="transaction-search">${icon('search', 15)}<span class="sr-only">Search transactions</span><input id="transaction-search" type="search" placeholder="Search merchant, category, or source" value="${state.transactionQuery.replace(/"/g, '&quot;')}" /></label></div></div>
    <div class="transactions-page-grid"><article class="card transaction-table-card"><div class="card-header"><div><span class="card-label">Local ledger</span><h2>All activity</h2></div><span class="card-note">Showing ${rangeStart}-${rangeEnd} of ${visible.length}${visible.length !== ledger.length ? ` matching · ${ledger.length} total` : ''}</span></div><div class="transaction-table-scroll"><div class="ledger-table" role="table" aria-label="Transactions">
      <div class="ledger-table-head" role="row"><span role="columnheader">Merchant</span><span role="columnheader">Category</span><span role="columnheader">Source</span><span role="columnheader">Date</span><span role="columnheader">Amount</span></div>
      ${pageItems.length ? pageItems.map(transactionLedgerRow).join('') : `<div class="transaction-empty"><span>${icon('search', 20)}</span><strong>No matching entries</strong><p>Try a different search or filter.</p></div>`}
    </div></div>${visible.length > TRANSACTIONS_PER_PAGE ? renderTransactionPagination(currentPage, pageCount) : ''}</article></div>
  </section>`;
}

function renderTransactionPagination(currentPage, pageCount) {
  return `<nav class="transaction-pagination" aria-label="Transactions pagination"><button class="pagination-button" type="button" data-transaction-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>${icon('arrowLeft', 13)} Previous</button><span class="pagination-status" aria-live="polite">Page <strong>${currentPage}</strong> of ${pageCount}</span><button class="pagination-button" type="button" data-transaction-page="${currentPage + 1}" ${currentPage === pageCount ? 'disabled' : ''}>Next ${icon('arrowRight', 13)}</button></nav>`;
}

function transactionFilterButton(id, label, count) {
  return `<button class="segmented-button ${state.transactionFilter === id ? 'active' : ''}" type="button" data-transaction-filter="${id}">${label} <span>${count}</span></button>`;
}

function transactionLedgerRow(item) {
  const sourceClass = item.sourceType === 'manual' ? 'manual-source' : item.status === 'Needs review' ? 'review-source' : 'bank-source';
  const statusClass = item.status === 'Needs review' ? 'ledger-status-review' : item.sourceType === 'manual' ? 'ledger-status-manual' : 'ledger-status-approved';
  const isDebit = item.direction === 'debit' || (!item.direction && item.amount < 0);
  const canCreateRule = item.sourceType === 'bank' && isDebit && item.status !== 'Needs review';
  const hasRule = state.manualRecurringRules.some((rule) => rule.sourceEventId === item.id);
  const recurringAction = canCreateRule
    ? `<button class="ledger-row-action" type="button" data-action="open-recurring-rule" data-transaction-id="${escapeHtml(item.id)}">${hasRule ? 'Manage recurring' : 'Make recurring'}</button>`
    : '';
  const detailLabel = `View details for ${item.name}`;
  return `<div class="ledger-table-row" role="row"><span class="ledger-merchant"><span class="transaction-icon">${icon(item.icon, 15)}</span><a class="ledger-detail-link" href="${transactionDetailUrl(item.id)}" aria-label="${escapeHtml(detailLabel)}"><strong>${escapeHtml(item.name)}</strong><span>View details ${icon('arrowRight', 12)}</span></a></span><span class="ledger-category">${escapeHtml(item.category)}</span><span class="ledger-source ${sourceClass}">${escapeHtml(item.source)}</span><span class="ledger-date">${escapeHtml(item.meta)}</span><span class="ledger-amount ${item.amount >= 0 ? 'ledger-amount-positive' : ''}">${ledgerAmount(item)}<small class="${statusClass}">${escapeHtml(item.status)}</small>${recurringAction}</span></div>`;
}

function detailTimestamp(value, fallback = 'Not available') {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function transactionDirectionLabel(item) {
  if (item.sourceType === 'manual') return manualTypeLabel(item.type);
  return item.direction === 'credit' ? 'Credit' : 'Debit';
}

function transactionDecisionLabel(item) {
  if (item.sourceType === 'manual') return 'Entered manually';
  if (item.status === 'Needs review') return 'Waiting for review';
  return item.decision?.mode === 'manual' ? 'Approved after review' : 'Automatically approved';
}

function transactionDetailFacts(item) {
  const facts = [
    ['Category', item.category || 'Not available'],
    ['Direction', transactionDirectionLabel(item)],
    ['Ledger date', item.meta || 'Not available'],
    ['Source', item.source || 'Not available']
  ];
  if (item.sourceType === 'bank') {
    facts.push(['Bank profile', item.senderProfileName || 'Not available']);
    facts.push(['Parser', item.parserVersion || 'Not available']);
    facts.push(['Captured', detailTimestamp(item.receivedAt)]);
  }
  return facts.map(([label, value]) => `<div class="transaction-detail-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
}

function renderTransactionDetailAction(item) {
  const isDebit = item.direction === 'debit' || (!item.direction && item.amount < 0);
  const canCreateRule = item.sourceType === 'bank' && isDebit && item.status !== 'Needs review';
  if (canCreateRule) {
    const hasRule = state.manualRecurringRules.some((rule) => rule.sourceEventId === item.id);
    return `<button class="button button-primary" data-action="open-recurring-rule" data-transaction-id="${escapeHtml(item.id)}">${hasRule ? 'Manage recurring' : 'Make recurring'} ${icon('recurring', 14)}</button>`;
  }
  if (item.status === 'Needs review') {
    return '<button class="button button-amber" data-view="review">Open review queue</button>';
  }
  return '';
}

function renderTransactionDetail() {
  const item = transactionLedger().find((transaction) => transaction.id === state.transactionDetailId);
  if (!item) {
    return `<section class="page transaction-detail-page" aria-labelledby="transaction-title">
      ${renderPageHeading({
        eyebrow: 'Transaction record',
        title: 'Transaction not found',
        description: 'This local record is no longer available. It may have been cleared from this browser.',
        action: '<a class="button button-secondary" href="?variant=transactions">Back to transactions</a>'
      })}
    </section>`;
  }
  const message = item.originalMessage || item.preview || '';
  const hasOriginalMessage = Boolean(item.originalMessage);
  const sourceMessage = item.sourceType === 'manual'
    ? {
        title: 'No original message',
        description: 'This is a manual entry, so it is intentionally kept separate from imported bank messages.',
        body: 'Manual transaction - no bank message attached.'
      }
    : hasOriginalMessage
      ? {
          title: 'Original bank message',
          description: 'Stored locally with this transaction. It is not sent to a cloud service.',
          body: message
        }
      : {
          title: 'Original message unavailable',
          description: 'This record was captured before full message retention. Its locally stored redacted preview is shown instead.',
          body: message || 'No local message preview is available for this record.'
        };
  const decisionDetail = item.status === 'Needs review'
    ? (item.reasons?.length ? item.reasons.join(' · ') : 'A human review is required before this message becomes a transaction.')
    : item.sourceType === 'manual'
      ? 'This manual entry never changes imported bank-message evidence.'
      : item.decision?.reason || 'This entry is part of the local ledger.';
  return `<section class="page transaction-detail-page" aria-labelledby="transaction-title">
    ${renderPageHeading({
      eyebrow: 'Transaction record',
      title: escapeHtml(item.name),
      description: 'A complete local record of this transaction and the message that created it.',
      action: `<a class="button button-secondary" href="?variant=transactions">${icon('arrowLeft', 14)} Back to transactions</a>`
    })}
    <div class="transaction-detail-summary">
      <article class="card transaction-detail-amount-card">
        <span class="card-label">Recorded amount</span>
        <strong class="transaction-detail-amount ${item.amount >= 0 ? 'ledger-amount-positive' : ''}">${ledgerAmount(item)}</strong>
        <span class="transaction-detail-status">${escapeHtml(item.status)}</span>
      </article>
      <article class="card transaction-detail-decision-card">
        <span class="card-label">Ledger decision</span>
        <strong>${escapeHtml(transactionDecisionLabel(item))}</strong>
        <p>${escapeHtml(decisionDetail)}</p>
      </article>
    </div>
    <div class="transaction-detail-grid">
      <article class="card transaction-detail-card">
        <div class="card-header"><div><span class="card-label">Transaction fields</span><h2>Recorded details</h2></div></div>
        <dl class="transaction-detail-facts">${transactionDetailFacts(item)}</dl>
      </article>
      <article class="card transaction-detail-card transaction-detail-actions-card">
        <div class="card-header"><div><span class="card-label">Local controls</span><h2>Available actions</h2></div></div>
        <p>${item.sourceType === 'bank' ? 'Recurring rules are local reminders only. They never create a payment or modify bank evidence.' : 'Manual transactions remain separate from imported bank messages.'}</p>
        <div class="transaction-detail-actions">${renderTransactionDetailAction(item) || '<span class="transaction-detail-disabled">No extra action is available for this record.</span>'}</div>
      </article>
      <article class="card transaction-source-message-card">
        <div class="transaction-source-message-header"><div><span class="card-label">Message evidence</span><h2>${sourceMessage.title}</h2><p>${sourceMessage.description}</p></div><span class="transaction-source-message-local">${icon('lock', 13)} LOCAL ONLY</span></div>
        <pre class="transaction-source-message" dir="auto">${escapeHtml(sourceMessage.body)}</pre>
      </article>
    </div>
  </section>`;
}

function overviewTrendChart(trend) {
  const chartWidth = 676;
  const startX = 12;
  const endX = startX + chartWidth;
  const step = chartWidth / (trend.values.length - 1);
  const points = trend.values.map((value, index) => `${startX + (step * index)} ${value}`);
  const linePath = `M${points.join(' L')}`;
  const labelStep = trend.labels.length > 1 ? chartWidth / (trend.labels.length - 1) : chartWidth;
  const labels = trend.labels.map((label, index) => `<text class="chart-label" x="${startX + (labelStep * index)}" y="174">${label}</text>`).join('');
  return `<svg viewBox="0 0 700 180" role="img" aria-label="Approved spending trend rising across ${trend.label}">
    <path class="chart-grid" d="M12 27H688M12 70H688M12 113H688M12 156H688" />
    <path class="chart-area" d="${linePath} L${endX} 156 H${startX} Z" />
    <path class="chart-line" d="${linePath}" />
    <circle class="chart-dot" cx="${endX}" cy="${trend.values[trend.values.length - 1]}" r="5" />
    ${labels}
  </svg>`;
}

function renderRecurring() {
  const live = liveLedgerSummary();
  const detectedPatterns = detectRecurringPatterns(live.debits, { asOf: new Date() });
  const patterns = detectedPatterns.filter((pattern) => !state.dismissedRecurringPatternIds.includes(pattern.id));
  const manualRules = state.manualRecurringRules;
  const recurringEmptyState = detectedPatterns.length && !patterns.length
    ? '<div class="recurring-empty-state"><strong>No active recurring patterns</strong><p>The detected patterns you removed are hidden. Your approved transactions remain unchanged.</p></div>'
    : '<div class="recurring-empty-state"><strong>No recurring patterns yet</strong><p>A pattern appears after two approved debits from the same merchant.</p></div>';

  return `<section class="page recurring-page" aria-labelledby="recurring-title">
    <div class="page-heading recurring-page-heading"><div class="page-heading-copy"><h1 id="recurring-title">Repeated transactions</h1><p class="heading-description">Patterns found in your approved debit transactions.</p></div><div class="heading-actions"><button class="button button-primary" data-view="transactions">Manage in transactions ${icon('arrowRight', 15)}</button></div></div>
    <article class="card recurring-patterns-card">
        <div class="card-header"><div><h2>${patterns.length} pattern${patterns.length === 1 ? '' : 's'}</h2></div><span class="card-note">Approved debits only</span></div>
        <div class="recurring-pattern-table" role="table" aria-label="Recurring patterns">
          <div class="recurring-pattern-head" role="row"><span>Transaction</span><span>Status</span><span>Next expected</span><span>Typical amount</span><span>Action</span></div>
          ${patterns.length ? patterns.map(recurringPatternRow).join('') : recurringEmptyState}
        </div>
    </article>
    ${manualRules.length ? renderManualRecurringRules(manualRules) : ''}
  </section>`;
}

function recurringStatusBadge(status) {
  const labels = { confirmed: 'Confirmed', signal: 'Signal', changed: 'Changed', paused: 'Paused', manual: 'Manual rule' };
  const icons = { confirmed: 'check', signal: 'bolt', changed: 'edit', paused: 'alert', manual: 'edit' };
  return `<span class="recurring-status ${status}">${icon(icons[status] || 'bolt', 11)}${labels[status] || 'Signal'}</span>`;
}

function recurringPatternRow(item) {
  const next = item.nextObservedDate ? formatProjectionDate(item.nextObservedDate) : 'No recent window';
  const actionLabel = `Remove ${item.merchant} recurring pattern`;
  return `<div class="recurring-pattern-row ${item.status}" role="row"><div class="recurring-pattern-name"><span class="recurring-pattern-icon">${icon(recurringIconForCategory(item.category), 15)}</span><span><strong>${escapeHtml(item.merchant)}</strong><small>${escapeHtml(item.cadence)} · ${item.evidenceCount} transactions</small></span></div><div>${recurringStatusBadge(item.status)}</div><div class="recurring-next"><strong>${escapeHtml(next)}</strong></div><div class="recurring-amount"><strong>-${formatCurrency(item.amount, item.currency)}</strong>${item.status === 'changed' ? `<small>Latest ${formatCurrency(item.latestAmount, item.currency)}</small>` : ''}</div><div class="recurring-pattern-actions"><button class="recurring-pattern-dismiss" type="button" data-action="dismiss-recurring-pattern" data-pattern-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(actionLabel)}" title="${escapeHtml(actionLabel)}">${icon('close', 15)}</button></div></div>`;
}

function upcomingCommitment(date, name, meta, amount, currency, status) {
  const formattedDate = formatProjectionDate(date);
  const [day, month] = formattedDate.split(' ');
  return `<div class="upcoming-item ${status}"><div class="upcoming-date"><strong>${escapeHtml(day)}</strong><span>${escapeHtml(month || '')}</span></div><div class="upcoming-copy"><div>${recurringStatusBadge(status)}</div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(meta)}</span></div><strong class="upcoming-amount">-${formatCurrency(amount, currency)}</strong></div>`;
}

function manualRecurringRuleRow(rule) {
  const isPaused = Boolean(rule.paused);
  const status = isPaused ? 'paused' : 'manual';
  return `<div class="recurring-manual-row"><div class="recurring-pattern-name"><span class="recurring-pattern-icon">${icon('edit', 15)}</span><span><strong>${escapeHtml(rule.merchant)}</strong><small>${escapeHtml(rule.category)} · ${escapeHtml(rule.sourceLabel)}</small><span class="recurring-pattern-note">${recurringStatusBadge(status)}${escapeHtml(isPaused ? 'Paused by you. It remains separate from bank evidence.' : rule.note)}</span></span></div><div class="recurring-cadence"><strong>${escapeHtml(rule.cadence)}</strong><small>User selected</small></div><div class="recurring-next"><strong>${escapeHtml(formatProjectionDate(rule.nextExpectedDate))}</strong><small>${isPaused ? 'Tracking paused' : 'Next expected date'}</small></div><div class="recurring-amount"><strong>-${formatCurrency(rule.amount, rule.currency)}</strong><small>Manual amount</small></div><div class="recurring-manual-actions"><button class="ledger-row-action" type="button" data-action="edit-recurring-rule" data-rule-id="${escapeHtml(rule.id)}">Edit</button><button class="ledger-row-action" type="button" data-action="toggle-recurring-rule" data-rule-id="${escapeHtml(rule.id)}">${isPaused ? 'Resume' : 'Pause'}</button><button class="ledger-row-action ledger-row-action-danger" type="button" data-action="delete-recurring-rule" data-rule-id="${escapeHtml(rule.id)}">Remove</button></div></div>`;
}

function renderManualRecurringRules(rules) {
  const emptyState = `<div class="recurring-empty-state compact"><strong>No manual recurring rules</strong><p>Open an approved debit in Transactions and choose Make recurring to define one.</p><button class="button button-secondary" data-view="transactions">Open transactions ${icon('arrowRight', 14)}</button></div>`;
  return `<article class="card recurring-manual-card"><div class="card-header"><div><span class="card-label">Manual rules</span><h2>What you chose to track</h2></div><span class="card-note">Separate from bank evidence</span></div><p class="upcoming-description">Manual rules are local notes created from an approved transaction. They do not add evidence, change totals, or make a payment.</p><div class="recurring-manual-list">${rules.length ? rules.map(manualRecurringRuleRow).join('') : emptyState}</div></article>`;
}

function renderCashFlow() {
  const live = liveLedgerSummary();
  const categoryTotal = Object.values(live.categories).reduce((sum, amount) => sum + amount, 0);
  const categories = categoryBreakdown(live.categories, categoryTotal);
  const debitScopeNote = live.debitTotal === null ? 'Converted currencies only' : 'Approved debits';
  return `<section class="page" aria-labelledby="cash-flow-title">
    ${renderPageHeading({
      eyebrow: '',
      title: 'Cash flow',
      description: 'Approved money moving in and out by day.',
      action: addTransactionButton()
    })}
    <div class="metrics-grid distilled-metrics-grid">
      ${metricCard('Approved debits', approvedSpendingText(live.debits, live.debitTotal), `${live.debits.length} bank SMS approvals`, 'neutral')}
      ${metricCard('Incoming money', live.credits.length ? approvedSpendingText(live.credits, live.creditTotal) : 'Unavailable', live.credits.length ? `${live.credits.length} approved credit messages` : 'No approved credit messages', 'neutral')}
    </div>
    <div class="cashflow-grid">
      <article class="card cashflow-chart-card"><div class="card-header"><div><h2>Spending by day</h2></div><span class="card-note">${debitScopeNote}</span></div><div class="cashflow-chart">${cashFlowBarChart(live.debits)}</div></article>
      <article class="card category-table-card"><div class="card-header"><div><h2>Spending by category</h2></div>${live.debitTotal === null ? '<span class="card-note">Converted currencies only</span>' : ''}</div><div class="category-table">
        ${categories.length ? categories.map((category) => tableRow(category.name, formatCurrency(category.amount), `${category.share.toFixed(1)}%`)).join('') : '<div class="transaction-empty"><strong>No approved debit categories</strong><p>Categories appear after a debit is approved locally.</p></div>'}
      </div></article>
    </div>
  </section>`;
}

function metricCard(label, value, trend, trendTone) {
  return `<article class="card metric-card"><span class="card-label">${label}</span><span class="metric-number">${value}</span><span class="metric-trend ${trendTone === 'neutral' ? 'neutral' : ''}">${trend}</span></article>`;
}

function renderAnalytics() {
  const live = liveLedgerSummary();
  const largest = Object.entries(live.categories).sort((a, b) => b[1] - a[1])[0] || ['No category', 0];
  const categoryTotal = Object.values(live.categories).reduce((sum, amount) => sum + amount, 0);
  const largestShare = categoryTotal ? ((largest[1] / categoryTotal) * 100).toFixed(1) : '0.0';
  const trend = observedTrend(live.debits, 4);
  const categories = categoryBreakdown(live.categories, categoryTotal);
  const debitScopeNote = live.debitTotal === null ? 'Converted currencies only' : 'Approved debits';
  return `<section class="page analytics-page" aria-labelledby="analytics-title">
    ${renderPageHeading({
      eyebrow: '',
      title: 'Analytics',
      description: 'Spending trend and category distribution from approved debits.',
      action: `<button class="button button-secondary" data-view="cash-flow">Open cash flow ${icon('arrowRight', 14)}</button>`
    })}
    <div class="analytics-metrics distilled-metrics-grid">
      ${analyticsMetric('Approved debit spend', approvedSpendingText(live.debits, live.debitTotal), `${live.debits.length} approved messages`, 'moss')}
      ${analyticsMetric('Largest category', `${largestShare}%`, live.debitTotal === null ? `${largest[0]} · converted currencies only` : largest[0], 'sage')}
    </div>
    <div class="analytics-top-grid">
      <article class="card analytics-trend-card">
        <div class="card-header"><div><h2>Spending trend</h2></div><span class="card-note">${debitScopeNote}</span></div>
        <div class="analytics-chart-wrap">${analyticsTrendChart(trend)}</div>
        <div class="analytics-chart-footer"><span>${trend.label}</span><span class="analytics-delta">${formatCurrency(trend.total)}</span></div>
      </article>
      <article class="card analytics-category-card">
        <div class="card-header"><div><h2>Spending by category</h2></div>${live.debitTotal === null ? '<span class="card-note">Converted currencies only</span>' : ''}</div>
        <div class="analytics-allocation-list">
          ${categories.length ? categories.map((category, index) => analyticsAllocationRow(category.name, formatCurrency(category.amount), `${category.share.toFixed(1)}%`, Math.round(category.share), ['', 'tone-2', 'tone-3', 'tone-4', 'tone-5'][index] || 'tone-5')).join('') : '<div class="transaction-empty"><strong>No approved debit allocation</strong><p>Category allocation appears after an approved local debit.</p></div>'}
        </div>
      </article>
    </div>
  </section>`;
}

function analyticsMetric(label, value, detail, tone) {
  return `<article class="card analytics-metric ${tone}"><span class="card-label">${label}</span><span class="analytics-metric-value">${value}</span><span class="analytics-metric-detail">${detail}</span></article>`;
}

function analyticsTrendChart(trend) {
  const startX = 12;
  const endX = 688;
  const step = trend.values.length > 1 ? (endX - startX) / (trend.values.length - 1) : 0;
  const points = trend.values.map((value, index) => `${startX + (step * index)} ${value}`);
  const linePath = `M${points.join(' L')}`;
  const labels = trend.labels.map((label, index) => `<text class="chart-label" x="${startX + (step * index)}" y="195">${escapeHtml(label)}</text>`).join('');
  const peak = Math.min(...trend.values);
  const peakIndex = trend.values.indexOf(peak);
  return `<svg viewBox="0 0 700 220" role="img" aria-label="Approved debit trend from the local ledger">
    <path class="chart-grid" d="M12 24H688M12 74H688M12 124H688M12 174H688" />
    <path class="analytics-current-area" d="${linePath} L${endX} 174 H${startX}Z" />
    <path class="analytics-current-line" d="${linePath}" />
    <circle class="analytics-current-dot" cx="${startX + (step * peakIndex)}" cy="${peak}" r="5" /><circle class="analytics-current-dot" cx="${endX}" cy="${trend.values.at(-1)}" r="5" />
    ${labels}
  </svg>`;
}

function comparisonRow(label, amount, width, tone) {
  return `<div class="comparison-row"><div class="comparison-row-head"><span>${label}</span><strong>${amount}</strong></div><div class="comparison-track"><div class="comparison-fill ${tone}" style="width:${width}%"></div></div></div>`;
}

function analyticsAllocationRow(name, amount, share, width, tone) {
  return `<div class="analytics-allocation-item"><div class="analytics-allocation-head"><span class="analytics-allocation-name"><i class="${tone}"></i>${name}</span><span class="analytics-allocation-value">${amount} <small>${share}</small></span></div><div class="allocation-track"><div class="allocation-fill ${tone}" style="width:${width}%"></div></div></div>`;
}

function rhythmBar(label, value, height, tone) {
  return `<div class="rhythm-column"><div class="rhythm-bar-wrap"><span class="rhythm-value">${value}</span><div class="rhythm-bar ${tone}" style="height:${height}%"></div></div><span class="rhythm-label">${label}</span></div>`;
}

function recentDebitSeries(debits, limit = 4) {
  const totalsByDate = new Map();
  debits.forEach((event) => {
    const date = toISODate(event.date || event.receivedAt);
    if (!date) return;
    const converted = convertCurrency(event.amount, event.currency || 'EGP', 'EGP');
    if (converted !== null) totalsByDate.set(date, (totalsByDate.get(date) || 0) + converted);
  });
  return [...totalsByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-limit)
    .map(([date, total]) => ({ date, total }));
}

function cashFlowBarChart(debits) {
  const series = recentDebitSeries(debits);
  if (!series.length) return '<div class="transaction-empty"><strong>No approved debit activity</strong><p>The chart will appear after an approved local debit.</p></div>';
  const highest = Math.max(...series.map((item) => item.total), 1);
  const spacing = 590 / series.length;
  const bars = series.map(({ date, total }, index) => {
    const height = Math.max(3, (total / highest) * 130);
    const x = 72 + (spacing * index) + ((spacing - 52) / 2);
    const y = 170 - height;
    const label = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `<rect x="${x}" y="${y}" width="52" height="${height}" rx="4" fill="#2e5b48"/><text class="chart-label" x="${x - 10}" y="196">${label}</text>`;
  }).join('');
  return `<svg viewBox="0 0 720 205" role="img" aria-label="Approved debit spending by observed day"><path class="chart-grid" d="M38 20H708M38 70H708M38 120H708M38 170H708"/><path class="chart-grid" d="M38 170V20"/>
    <text class="chart-label" x="4" y="24">${formatCurrency(highest)}</text><text class="chart-label" x="25" y="174">0</text>${bars}
  </svg>`;
}

function forecastRow(date, name, meta, amount, currency = 'EGP') {
  return `<div class="forecast-row"><span class="forecast-date">${date}</span><div class="forecast-copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(meta)}</span></div><span class="forecast-amount">-${formatCurrency(amount, currency)}</span></div>`;
}

function tableRow(name, amount, share) {
  return `<div class="table-row"><span>${name} <small style="color:var(--graphite-faint);font-size:10px">${share}</small></span><span>${amount}</span></div>`;
}

function renderReview() {
  const reviewCandidates = harborLedger.snapshot().reviewCandidates;
  const selectedCandidate = reviewCandidates.find((candidate) => candidate.id === state.reviewCandidateId) || reviewCandidates[0];
  const detail = renderReviewDetail(selectedCandidate);
  return `<section class="page" aria-labelledby="review-title">
    ${renderPageHeading({
      eyebrow: '',
      title: 'Review Queue',
      description: reviewCandidates.length ? `${reviewCandidates.length} transaction${reviewCandidates.length === 1 ? '' : 's'} need your decision.` : 'No transactions need your decision.'
    })}
    ${reviewCandidates.length ? `<div class="review-layout">
      <article class="card queue-card"><div class="card-header"><div><span class="card-label">Inbox</span><h3>Review items</h3></div><span class="uncertain-badge"><span class="status-dot"></span>${reviewQueueBadge()}</span></div><div class="queue-list">
        ${reviewCandidates.map((candidate) => queueItem(candidate.merchant, candidate.date, reviewCandidateAmount(candidate), candidate.id === selectedCandidate?.id, false, candidate.id)).join('')}
      </div></article>
      <article class="card review-detail">${detail}</article>
    </div>` : `<article class="card review-detail review-empty">${detail}</article>`}
  </section>`;
}

function reviewQueueEyebrow() {
  const count = harborLedger.snapshot().reviewCandidates.length;
  return 'Needs your call · ' + count + ' item' + (count === 1 ? '' : 's');
}

function reviewQueueBadge() {
  return harborLedger.snapshot().reviewCandidates.length + ' open';
}

function queueItem(name, meta, amount, active, resolved, candidateId = '') {
  const candidateAttribute = candidateId ? ` data-candidate-id="${escapeHtml(candidateId)}"` : '';
  return `<button class="queue-item ${active ? 'active' : ''} ${resolved ? 'resolved' : ''}" data-action="queue-select"${candidateAttribute}><span class="queue-dot"></span><span><strong>${escapeHtml(name)}</strong><span>${escapeHtml(meta)}</span></span><small>${escapeHtml(amount)}</small></button>`;
}

function renderReviewDetail(candidate) {
  if (!candidate) {
    return `<div class="resolved-state"><span class="resolved-state-icon">${icon('check', 23)}</span><h2>Queue is clear</h2><p>New uncertain transactions will appear here.</p></div>`;
  }
  const merchant = escapeHtml(candidate.merchant || 'Unresolved merchant');
  const date = escapeHtml(candidate.date || 'Unresolved date');
  const category = escapeHtml(candidate.category || 'Unresolved category');
  const sender = escapeHtml(candidate.sender || 'local Messages source');
  const preview = escapeHtml(candidate.preview || 'No redacted preview available.');
  const reasons = escapeHtml((candidate.reasons || ['Needs a human check']).join(' · '));
  const amountValue = Number(candidate.amount) > 0 ? Number(candidate.amount).toFixed(2) : '';
  const dateValue = dateInputValue(candidate.date || candidate.receivedAt);
  return `<div class="detail-topline"><div class="detail-merchant"><span class="merchant-avatar">${escapeHtml((candidate.merchant || 'NA').slice(0, 2).toUpperCase())}</span><div><strong>${merchant}</strong><span>Parsed from ${sender} · ${date}</span></div></div><span class="uncertain-badge"><span class="status-dot"></span>Uncertain parse</span></div>
    <p class="detail-question">Zoid Bank is not fully confident about this transaction. Edit the fields if needed, then approve the saved values into your local totals.</p>
    <div class="parsed-fields">
      <div class="parsed-field"><label for="merchant">Merchant</label><input id="merchant" data-review-field="merchant" value="${merchant}" maxlength="120" ${state.isEditing ? '' : 'disabled'} /></div>
      <div class="parsed-field"><label for="amount">Amount (${escapeHtml(candidate.currency || 'EGP')})</label><input id="amount" data-review-field="amount" type="number" min="0.01" step="0.01" value="${amountValue}" ${state.isEditing ? '' : 'disabled'} /></div>
      <div class="parsed-field"><label for="date">Date</label><input id="date" data-review-field="date" type="date" value="${dateValue}" ${state.isEditing ? '' : 'disabled'} /></div>
      <div class="parsed-field"><label for="category">Category</label><input id="category" data-review-field="category" value="${category}" maxlength="80" ${state.isEditing ? '' : 'disabled'} /></div>
    </div>
    <div class="source-snippet"><span>Local Messages preview · sensitive digits redacted</span><p>"${preview}"</p></div>
    <div class="detail-actions"><p>Reason held: ${reasons}. Approval saves this event locally and does not send a reply or modify Messages.</p><div class="detail-buttons"><button class="button button-secondary" data-action="edit">${icon('edit', 14)}${state.isEditing ? 'Cancel edit' : 'Edit fields'}</button><button class="button button-dismiss" data-action="dismiss-review" data-candidate-id="${escapeHtml(candidate.id)}">Dismiss</button><button class="button button-amber" data-action="approve" data-candidate-id="${escapeHtml(candidate.id)}">${icon('check', 14)}${state.isEditing ? 'Save edit & approve' : 'Approve & save'}</button></div></div>`;
}

function renderSettings() {
  const usdRate = state.fxRates.USD ? state.fxRates.USD.toFixed(2) : '';
  const eurRate = state.fxRates.EUR ? state.fxRates.EUR.toFixed(2) : '';
  return `<section class="page settings-page" aria-labelledby="settings-title">
    ${renderPageHeading({
      eyebrow: '',
      title: 'Settings',
      description: 'Choose how amounts are displayed and which manual conversion rates may be used.'
    })}
    <div class="settings-layout distilled-settings-layout">
      <article class="card settings-section distilled-settings-card">
        <div class="settings-section-head"><div><h2>Display currency</h2></div></div>
        <div class="settings-field">${currencySelect('currency')}<small class="currency-setting-note">Only EGP and currencies with a saved manual rate can be selected.</small></div>
      </article>
      <article class="card settings-section fx-rates-card">
        <div class="settings-section-head"><div><span class="card-label">User-controlled source</span><h2>Manual FX rates</h2></div><span class="source-chip source-chip-review">No live feed</span></div>
        <p class="settings-section-copy">Rates are optional local inputs. Zoid Bank will not invent a rate or convert an amount when a rate is missing.</p>
        <form id="fx-rates-form" class="fx-rates-form">
          <div class="parsed-field"><label for="fx-usd-rate">EGP per 1 USD</label><input id="fx-usd-rate" data-fx-rate="USD" type="number" min="0.0001" step="0.01" value="${usdRate}" placeholder="Enter a rate" /></div>
          <div class="parsed-field"><label for="fx-eur-rate">EGP per 1 EUR</label><input id="fx-eur-rate" data-fx-rate="EUR" type="number" min="0.0001" step="0.01" value="${eurRate}" placeholder="Enter a rate" /></div>
          <div class="fx-rates-actions"><button class="button button-primary" type="submit">Save manual rates ${icon('check', 14)}</button><span class="fx-rates-note">Leave a field empty to disable that conversion.</span></div>
        </form>
      </article>
    </div>
  </section>`;
}

function renderPrototypeSwitcher() {
  const view = currentView();
  const index = views.findIndex((item) => item.id === view.id);
  const previous = views[(index - 1 + views.length) % views.length];
  const next = views[(index + 1) % views.length];
  return `<div class="prototype-switcher" aria-label="Prototype state switcher"><button data-view="${previous.id}" aria-label="Previous state">${icon('arrowLeft', 15)}</button><div class="prototype-label">${view.key} · ${view.label}<span> · prototype state</span></div><button data-view="${next.id}" aria-label="Next state">${icon('arrowRight', 15)}</button></div>`;
}

function renderAddTransactionModal() {
  if (!state.showAddTransaction) return '';
  return `<div class="modal-backdrop" data-action="close-add"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-transaction-title">
    <div class="modal-header"><div><span class="card-label">Manual ledger entry</span><h2 id="add-transaction-title">Add transaction</h2></div><button class="modal-close" data-action="close-add" aria-label="Close">×</button></div>
    <p class="modal-description">Add a personal note for income, expense, cash, transfer, or adjustment. Manual items are stored separately from imported bank SMS messages.</p>
    <form id="manual-transaction-form">
      <div class="manual-form-grid">
        <div class="parsed-field">${sumiDropdown({ id: 'manual-type', label: 'Type', value: 'income', options: [{ value: 'income', label: 'Manual income' }, { value: 'expense', label: 'Manual expense' }, { value: 'cash', label: 'Cash' }, { value: 'transfer', label: 'Transfer' }, { value: 'adjustment', label: 'Adjustment' }] })}</div>
        <div class="parsed-field"><label for="manual-amount">Amount</label><input id="manual-amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></div>
        <div class="parsed-field full"><label for="manual-description">Description</label><input id="manual-description" type="text" maxlength="60" placeholder="e.g. Cash lunch" required /></div>
        <div class="parsed-field"><label for="manual-date">Date</label><input id="manual-date" type="date" value="2026-08-04" required /></div>
        <div class="parsed-field"><label>Source</label><span class="modal-source"><span class="source-chip source-chip-manual">Manual entry</span><small>Never treated as bank SMS</small></span></div>
      </div>
      <div class="modal-actions"><button class="button button-secondary" type="button" data-action="close-add">Cancel</button><button class="button button-primary" type="submit">Save manual entry ${icon('check', 14)}</button></div>
    </form>
  </div></div>`;
}

function renderManualRecurringRuleModal() {
  if (!state.showRecurringRule) return '';
  const existingRule = state.editingRecurringRuleId
    ? state.manualRecurringRules.find((rule) => rule.id === state.editingRecurringRuleId)
    : null;
  const transaction = transactionLedger().find((item) => item.id === (existingRule?.sourceEventId || state.recurringRuleTransactionId));
  if (!existingRule && !transaction) return '';
  const merchant = existingRule?.merchant || transaction.name;
  const amount = existingRule?.amount ?? Math.abs(Number(transaction.amount) || 0);
  const nextExpectedDate = existingRule?.nextExpectedDate || addDays(transaction.dateValue || transaction.meta, 30) || dateInputValue(new Date());
  const sourceLabel = existingRule?.sourceLabel || transaction.source;
  const sourceMeta = existingRule ? `${existingRule.category} · Manual rule` : `${transaction.meta} · ${transaction.category}`;
  const cadenceOptions = manualRecurringCadenceOptions().map((cadence) => ({ value: cadence.key, label: cadence.label }));
  return `<div class="modal-backdrop" data-action="close-recurring-rule"><div class="modal recurring-rule-modal" role="dialog" aria-modal="true" aria-labelledby="manual-recurring-title">
    <div class="modal-header"><div><span class="card-label">Manual recurring rule</span><h2 id="manual-recurring-title">${existingRule ? 'Manage this recurring rule' : 'Track this transaction again'}</h2></div><button class="modal-close" data-action="close-recurring-rule" aria-label="Close">×</button></div>
    <p class="modal-description">This is a local reminder based on one approved imported debit. It never adds bank evidence, changes totals, syncs to the cloud, or makes a payment.</p>
    <div class="recurring-rule-source"><span class="source-chip source-chip-dark">${escapeHtml(sourceLabel)}</span><span>${escapeHtml(sourceMeta)}</span></div>
    <form id="manual-recurring-form">
      <div class="manual-form-grid">
        <div class="parsed-field full"><label for="recurring-merchant">Merchant</label><input id="recurring-merchant" value="${escapeHtml(merchant)}" readonly /></div>
        <div class="parsed-field"><label for="recurring-amount">Amount</label><input id="recurring-amount" type="number" min="0.01" step="0.01" value="${Number(amount).toFixed(2)}" required /></div>
        <div class="parsed-field">${sumiDropdown({ id: 'recurring-cadence', label: 'Cadence', value: existingRule?.cadenceKey || 'monthly', options: cadenceOptions })}</div>
        <div class="parsed-field"><label for="recurring-next-date">Next expected date</label><input id="recurring-next-date" type="date" value="${nextExpectedDate}" required /></div>
        <div class="parsed-field"><label>Evidence</label><span class="modal-source"><span class="source-chip source-chip-dark">Imported debit</span><small>One approved event · manual rule stays separate</small></span></div>
      </div>
      <div class="modal-actions"><button class="button button-secondary" type="button" data-action="close-recurring-rule">Cancel</button><button class="button button-primary" type="submit">${existingRule ? 'Save changes' : 'Save manual rule'} ${icon('check', 14)}</button></div>
    </form>
  </div></div>`;
}

function render() {
  let page = renderOverview();
  if (state.view === 'transactions') page = renderTransactions();
  if (state.view === 'transaction') page = renderTransactionDetail();
  if (state.view === 'analytics') page = renderAnalytics();
  if (state.view === 'recurring') page = renderRecurring();
  if (state.view === 'cash-flow') page = renderCashFlow();
  if (state.view === 'review') page = renderReview();
  if (state.view === 'settings') page = renderSettings();
  app.innerHTML = `<div class="app-shell${isSidebarCollapsed() ? ' sidebar-collapsed' : ''}">${renderSidebar()}<main class="main-shell">${renderTopbar()}${page}</main></div>${renderAddTransactionModal()}${renderManualRecurringRuleModal()}${state.toast ? `<div class="toast">${icon('check', 15)}${state.toast}</div>` : ''}`;
  bindEvents();
}

exposeLedgerBridge();
window.__harborRender = render;
window.__harborShowToast = showToast;

function bindEvents() {
  document.querySelectorAll('[data-sumi-dropdown]').forEach((dropdown) => {
    const trigger = dropdown.querySelector('.sumi-dropdown__trigger');
    const options = Array.from(dropdown.querySelectorAll('.sumi-dropdown__option'));
    trigger?.addEventListener('click', () => {
      const shouldOpen = trigger.getAttribute('aria-expanded') !== 'true';
      closeAllSumiDropdowns(dropdown);
      setSumiDropdownOpen(dropdown, shouldOpen);
    });
    trigger?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSumiDropdownOpen(dropdown, false);
        return;
      }
      if (!event.key.startsWith('Arrow') && event.key !== 'Home' && event.key !== 'End') return;
      event.preventDefault();
      event.stopPropagation();
      setSumiDropdownOpen(dropdown, true);
      const selectedIndex = Math.max(0, options.findIndex((option) => option.getAttribute('aria-selected') === 'true'));
      const targetIndex = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1) : Math.min(options.length - 1, selectedIndex + 1);
      options[targetIndex]?.focus();
    });
    options.forEach((option, optionIndex) => {
      option.addEventListener('click', () => selectSumiDropdownOption(dropdown, option));
      option.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          selectSumiDropdownOption(dropdown, option);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setSumiDropdownOpen(dropdown, false);
          trigger?.focus();
          return;
        }
        if (!event.key.startsWith('Arrow') && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        event.stopPropagation();
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowUp' ? Math.max(0, optionIndex - 1) : Math.min(options.length - 1, optionIndex + 1);
        options[nextIndex]?.focus();
      });
    });
  });
  document.querySelector('[data-sidebar-toggle]')?.addEventListener('click', () => {
    setSidebarCollapsed(!state.sidebarCollapsed);
  });
  document.querySelectorAll('[data-view]').forEach((element) => {
    element.addEventListener('click', () => setView(element.dataset.view));
  });
  document.querySelectorAll('[data-action="settings-save"]').forEach((element) => {
    element.addEventListener('click', () => showToast('Local preferences saved for this prototype session.'));
  });
  document.querySelectorAll('[data-action="open-add"]').forEach((element) => {
    element.addEventListener('click', () => {
      state.showAddTransaction = true;
      render();
      document.querySelector('#manual-type-trigger')?.focus();
    });
  });
  document.querySelectorAll('[data-action="close-add"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      if (event.currentTarget.classList.contains('modal-backdrop') && event.target !== event.currentTarget) return;
      state.showAddTransaction = false;
      render();
    });
  });
  document.querySelectorAll('[data-action="open-recurring-rule"]').forEach((element) => {
    element.addEventListener('click', () => {
      const transaction = transactionLedger().find((item) => item.id === element.dataset.transactionId);
      if (!transaction || transaction.status === 'Needs review') {
        showToast('Review the imported transaction before creating a recurring rule.');
        return;
      }
      const existingRule = state.manualRecurringRules.find((rule) => rule.sourceEventId === transaction.id);
      state.recurringRuleTransactionId = transaction.id;
      state.editingRecurringRuleId = existingRule?.id || null;
      state.showRecurringRule = true;
      render();
      document.querySelector('#recurring-amount')?.focus();
    });
  });
  document.querySelectorAll('[data-action="close-recurring-rule"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      if (event.currentTarget.classList.contains('modal-backdrop') && event.target !== event.currentTarget) return;
      state.showRecurringRule = false;
      state.recurringRuleTransactionId = null;
      state.editingRecurringRuleId = null;
      render();
    });
  });
  document.querySelectorAll('[data-action="edit-recurring-rule"]').forEach((element) => {
    element.addEventListener('click', () => {
      state.editingRecurringRuleId = element.dataset.ruleId;
      state.recurringRuleTransactionId = null;
      state.showRecurringRule = true;
      render();
      document.querySelector('#recurring-amount')?.focus();
    });
  });
  document.querySelectorAll('[data-action="toggle-recurring-rule"]').forEach((element) => {
    element.addEventListener('click', () => {
      const index = state.manualRecurringRules.findIndex((rule) => rule.id === element.dataset.ruleId);
      if (index < 0) return;
      const nextRules = state.manualRecurringRules.slice();
      nextRules[index] = setManualRecurringRulePaused(nextRules[index], !nextRules[index].paused);
      if (!persistManualRecurringRules(nextRules)) {
        showToast('The rule could not be saved locally. Check browser storage and try again.');
        return;
      }
      state.manualRecurringRules = nextRules;
      render();
      showToast(nextRules[index].paused ? 'Manual recurring rule paused locally.' : 'Manual recurring rule resumed locally.');
    });
  });
  document.querySelectorAll('[data-action="dismiss-recurring-pattern"]').forEach((element) => {
    element.addEventListener('click', () => {
      const patternId = element.dataset.patternId;
      if (!patternId || state.dismissedRecurringPatternIds.includes(patternId)) return;
      const nextDismissedPatternIds = [...state.dismissedRecurringPatternIds, patternId];
      if (!persistDismissedRecurringPatternIds(nextDismissedPatternIds)) {
        showToast('The recurring pattern could not be removed locally. Check browser storage and try again.');
        return;
      }
      state.dismissedRecurringPatternIds = nextDismissedPatternIds;
      render();
      showToast('Recurring pattern removed. Approved transactions remain unchanged.');
    });
  });
  document.querySelectorAll('[data-action="delete-recurring-rule"]').forEach((element) => {
    element.addEventListener('click', () => {
      const rule = state.manualRecurringRules.find((candidate) => candidate.id === element.dataset.ruleId);
      if (!rule || !window.confirm(`Remove the recurring rule for ${rule.merchant}? This only removes the local reminder.`)) return;
      const nextRules = state.manualRecurringRules.filter((candidate) => candidate.id !== rule.id);
      if (!persistManualRecurringRules(nextRules)) {
        showToast('The rule could not be removed locally. Check browser storage and try again.');
        return;
      }
      state.manualRecurringRules = nextRules;
      render();
      showToast('Manual recurring rule removed. No bank evidence changed.');
    });
  });
  document.querySelectorAll('[data-action="queue-select"]').forEach((element) => {
    element.addEventListener('click', () => {
      state.reviewCandidateId = element.dataset.candidateId || null;
      state.isEditing = false;
      render();
    });
  });
  document.querySelectorAll('[data-transaction-filter]').forEach((element) => {
    element.addEventListener('click', () => {
      state.transactionFilter = element.dataset.transactionFilter;
      state.transactionPage = 1;
      render();
    });
  });
  document.querySelectorAll('[data-transaction-page]').forEach((element) => {
    element.addEventListener('click', () => {
      state.transactionPage = Number(element.dataset.transactionPage) || 1;
      render();
      document.querySelector('.transaction-table-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  document.querySelector('#trend-timeframe')?.addEventListener('change', (event) => {
    state.trendTimeframe = event.target.value;
    render();
  });
  document.querySelectorAll('[data-display-currency]').forEach((element) => {
    element.addEventListener('change', (event) => {
      if (!DISPLAY_CURRENCY_BY_CODE[event.target.value]) return;
      if (event.target.value !== 'EGP' && !state.fxRates[event.target.value]) {
        showToast('Save a manual rate before selecting this display currency.');
        return;
      }
      state.displayCurrency = event.target.value;
      persistDisplayCurrency(state.displayCurrency);
      render();
    });
  });
  document.querySelector('#fx-rates-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const nextRates = {};
    for (const code of ['USD', 'EUR']) {
      const value = document.querySelector(`[data-fx-rate="${code}"]`)?.value.trim() || '';
      if (!value) continue;
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate <= 0) {
        showToast(`Enter a positive manual rate for ${code}, or leave it empty.`);
        return;
      }
      nextRates[code] = rate;
    }
    if (!persistFxRates(nextRates)) {
      showToast('Manual FX rates could not be saved locally.');
      return;
    }
    state.fxRates = nextRates;
    if (state.displayCurrency !== 'EGP' && !state.fxRates[state.displayCurrency]) {
      state.displayCurrency = 'EGP';
      persistDisplayCurrency('EGP');
    }
    render();
    showToast('Manual FX rates saved locally.');
  });
  document.querySelectorAll('[data-transaction-category]').forEach((element) => {
    element.addEventListener('change', (event) => {
      state.transactionCategory = event.target.value;
      state.transactionPage = 1;
      render();
    });
  });
  document.querySelector('#transaction-search')?.addEventListener('input', (event) => {
    state.transactionQuery = event.target.value;
    state.transactionPage = 1;
    render();
    const nextSearch = document.querySelector('#transaction-search');
    nextSearch?.focus();
    nextSearch?.setSelectionRange(state.transactionQuery.length, state.transactionQuery.length);
  });
  document.querySelectorAll('[data-action="transaction-detail"]').forEach((element) => {
    element.addEventListener('click', () => showToast(`${element.dataset.transactionName} selected. Structured fields stay local to this prototype.`));
  });
  document.querySelectorAll('[data-action="export-transactions"]').forEach((element) => {
    element.addEventListener('click', async () => {
      const items = transactionLedger().filter(transactionRowMatches);
      if (!items.length) {
        showToast('No matching transactions to export.');
        return;
      }
      element.disabled = true;
      try {
        const filename = await downloadTransactionsWorkbook(items);
        showToast(`${items.length} matching transaction${items.length === 1 ? '' : 's'} exported to ${filename}.`);
      } catch (error) {
        console.error('Transaction export failed.', error);
        element.disabled = false;
        showToast('The Excel export could not be created. Try again.');
      }
    });
  });
  const recurringForm = document.querySelector('#manual-recurring-form');
  recurringForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      const input = {
        amount: Number(document.querySelector('#recurring-amount').value),
        cadence: document.querySelector('#recurring-cadence').value,
        nextExpectedDate: document.querySelector('#recurring-next-date').value,
        updatedAt: new Date().toISOString()
      };
      let nextRules;
      let successMessage;
      if (state.editingRecurringRuleId) {
        const index = state.manualRecurringRules.findIndex((rule) => rule.id === state.editingRecurringRuleId);
        if (index < 0) throw new Error('The saved manual rule is no longer available locally.');
        nextRules = state.manualRecurringRules.slice();
        nextRules[index] = updateManualRecurringRule(nextRules[index], input);
        successMessage = 'Manual recurring rule updated locally. No payment was scheduled.';
      } else {
        const transaction = transactionLedger().find((item) => item.id === state.recurringRuleTransactionId);
        if (!transaction) throw new Error('The imported transaction is no longer available locally.');
        const rule = createManualRecurringRule(transaction, { ...input, createdAt: input.updatedAt });
        if (state.manualRecurringRules.some((existingRule) => existingRule.sourceEventId === rule.sourceEventId)) {
          throw new Error('A manual recurring rule already exists for this imported debit.');
        }
        nextRules = [rule, ...state.manualRecurringRules];
        successMessage = 'Manual recurring rule saved locally. No payment was scheduled.';
      }
      if (!persistManualRecurringRules(nextRules)) {
        showToast('The rule could not be saved locally. Check browser storage and try again.');
        return;
      }
      state.manualRecurringRules = nextRules;
      state.showRecurringRule = false;
      state.recurringRuleTransactionId = null;
      state.editingRecurringRuleId = null;
      setView('recurring');
      showToast(successMessage);
    } catch (error) {
      showToast(error.message || 'The recurring rule could not be saved locally.');
    }
  });
  document.querySelectorAll('[data-action="edit"]').forEach((element) => {
    element.addEventListener('click', () => {
      state.isEditing = !state.isEditing;
      render();
    });
  });
  document.querySelectorAll('[data-action="approve"]').forEach((element) => {
    element.addEventListener('click', () => {
      const candidateId = element.dataset.candidateId;
      let edits = null;
      if (state.isEditing) {
        edits = {
          merchant: document.querySelector('[data-review-field="merchant"]')?.value,
          amount: document.querySelector('[data-review-field="amount"]')?.value,
          date: document.querySelector('[data-review-field="date"]')?.value,
          category: document.querySelector('[data-review-field="category"]')?.value
        };
      }
      try {
        const result = approveReviewCandidate(candidateId, edits);
        if (result.kind !== 'approved') {
          if (result.kind === 'invalid') state.isEditing = true;
          showToast(reviewApprovalFailureMessage(result));
          if (result.kind === 'invalid') focusReviewField(result.reasons);
          return;
        }
        state.reviewCandidateId = null;
        state.isEditing = false;
        showToast(edits ? 'Edits saved locally. The review item is now approved.' : 'Saved locally. The review item is now approved.');
      } catch (error) {
        showToast(error.message || 'The review item could not be saved locally.');
        return;
      }
    });
  });
  document.querySelectorAll('[data-action="dismiss-review"]').forEach((element) => {
    element.addEventListener('click', () => {
      const candidateId = element.dataset.candidateId;
      if (!candidateId || !window.confirm('Dismiss this review item? Its source evidence and audit history will remain saved locally.')) return;
      try {
        const result = dismissReviewCandidate(candidateId);
        if (result.kind !== 'dismissed') {
          showToast('This review item is no longer available.');
          return;
        }
        state.reviewCandidateId = null;
        state.isEditing = false;
        render();
        showToast('Review item dismissed. Its source evidence remains saved locally.');
      } catch (error) {
        showToast(error.message || 'The review item could not be dismissed locally.');
      }
    });
  });
  const form = document.querySelector('#manual-transaction-form');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const type = document.querySelector('#manual-type').value;
    const amount = Number(document.querySelector('#manual-amount').value);
    const description = document.querySelector('#manual-description').value.trim();
    const dateValue = document.querySelector('#manual-date').value;
    if (!description || !amount || amount <= 0 || !dateValue) return;
    state.manualTransactions.unshift({ type, amount, description, date: formatManualDate(dateValue) });
    state.showAddTransaction = false;
    showToast(`Manual ${manualTypeLabel(type).toLowerCase()} added. It is labeled separately from bank SMS.`);
  });
}

function setSumiDropdownOpen(dropdown, open) {
  const trigger = dropdown?.querySelector('.sumi-dropdown__trigger');
  const menu = dropdown?.querySelector('.sumi-dropdown__menu');
  if (!trigger || !menu) return;
  trigger.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
}

function closeAllSumiDropdowns(except = null) {
  document.querySelectorAll('[data-sumi-dropdown]').forEach((dropdown) => {
    if (dropdown !== except) setSumiDropdownOpen(dropdown, false);
  });
}

function selectSumiDropdownOption(dropdown, option) {
  const input = dropdown.querySelector('input[type="hidden"]');
  const value = dropdown.querySelector('.sumi-dropdown__value');
  const stateLabels = dropdown.querySelectorAll('.sumi-dropdown__state');
  const options = dropdown.querySelectorAll('.sumi-dropdown__option');
  if (!input || !value) return;
  options.forEach((candidate, index) => {
    const selected = candidate === option;
    candidate.setAttribute('aria-selected', String(selected));
    stateLabels[index].textContent = selected ? 'SELECTED' : '';
  });
  input.value = option.dataset.sumiDropdownValue;
  value.textContent = option.querySelector('span')?.textContent || option.dataset.sumiDropdownValue;
  setSumiDropdownOpen(dropdown, false);
  dropdown.querySelector('.sumi-dropdown__trigger')?.focus();
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function formatManualDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

window.addEventListener('keydown', (event) => {
  const tagName = document.activeElement?.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const index = views.findIndex((view) => view.id === state.view);
  if (index < 0) {
    setView('transactions');
    return;
  }
  const offset = event.key === 'ArrowRight' ? 1 : -1;
  setView(views[(index + offset + views.length) % views.length].id);
});

window.addEventListener('popstate', () => {
  state.view = getViewFromUrl();
  state.transactionDetailId = getTransactionIdFromUrl();
  state.isEditing = false;
  render();
});

window.matchMedia(SIDEBAR_COLLAPSE_MEDIA_QUERY).addEventListener('change', () => render());

document.addEventListener('pointerdown', (event) => {
  document.querySelectorAll('[data-sumi-dropdown]').forEach((dropdown) => {
    if (!dropdown.contains(event.target)) setSumiDropdownOpen(dropdown, false);
  });
});

render();
