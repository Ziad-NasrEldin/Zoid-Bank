import { createBridgeClient } from './harbor-bridge-client.js';
import { mergeLedgerSnapshots, summarizeScanResults } from './harbor-ledger-sync.js';

const BRIDGE_URL = 'http://127.0.0.1:4317';
const controlUrl = window.location.protocol === 'harbor:'
  ? 'http://127.0.0.1:4180/api/messages-bridge'
  : ['http:', 'https:'].includes(window.location.protocol)
    ? new URL('/api/messages-bridge', window.location.href).href
    : null;
const bridgeClient = createBridgeClient({ bridgeUrl: BRIDGE_URL, controlUrl });
let bridgePollTimer = null;
let bridgeUi = null;

const stateLabels = {
  connected: 'Connected',
  starting: 'Starting',
  stopping: 'Stopping',
  stopped: 'Stopped',
  bridge_stopped: 'Stopped',
  bridge_unreachable: 'Needs restart',
  helper_missing: 'Helper missing',
  permission_required: 'Permission needed',
  schema_incompatible: 'Update needed',
  scan_timeout: 'Timed out',
  reader_failed: 'Reader error',
  error: 'Error'
};

function button(label, onClick, className = 'button button-secondary') {
  const element = document.createElement('button');
  element.className = className;
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function listRow(label, value, valueId = '') {
  const row = document.createElement('div');
  row.className = 'settings-list-row';
  const name = document.createElement('span');
  name.textContent = label;
  const detail = document.createElement('strong');
  detail.textContent = value;
  if (valueId) detail.id = valueId;
  row.append(name, detail);
  return row;
}

function sourceAccessLabel(status) {
  if (status.databaseReadable === true) return 'Read-only access confirmed';
  if (status.state === 'permission_required') return 'Full Disk Access required';
  if (status.databaseReadable === false) return 'Unavailable';
  return 'Not checked';
}

function serviceLabel(status) {
  if (status.loaded === true) return 'Loaded at login';
  if (status.loaded === false && status.installed === true) return 'Installed, not loaded';
  if (status.loaded === false) return 'Stopped';
  return status.ok ? 'Running' : 'Not detected';
}

function setUiMessage(message, tone = 'neutral') {
  if (!bridgeUi) return;
  bridgeUi.feedback.textContent = message;
  bridgeUi.feedback.dataset.tone = tone;
  bridgeUi.feedback.hidden = !message;
}

function renderBridgeStatus(status) {
  if (!bridgeUi) return;
  const connected = status.ok && status.state === 'connected';
  const busy = ['starting', 'stopping'].includes(status.state) || Boolean(status.pendingAction);
  const connectionTitles = {
    connected: 'Messages bridge connected',
    permission_required: 'Messages access needs permission',
    schema_incompatible: 'Messages reader needs an update',
    starting: 'Starting the Messages bridge',
    stopping: 'Stopping the Messages bridge',
    stopped: 'Messages bridge is stopped'
  };
  bridgeUi.status.textContent = stateLabels[status.state] || stateLabels[status.code] || 'Unavailable';
  bridgeUi.status.className = connected
    ? 'source-chip source-chip-bank'
    : 'source-chip source-chip-review';
  bridgeUi.message.textContent = status.message || (connected
    ? 'The local Messages source is connected and read-only.'
    : 'The Messages bridge is unavailable.');
  bridgeUi.title.textContent = connectionTitles[status.state] || 'Messages bridge needs attention';
  bridgeUi.message.dataset.state = connected ? 'connected' : 'attention';
  bridgeUi.service.textContent = serviceLabel(status);
  bridgeUi.access.textContent = sourceAccessLabel(status);
  bridgeUi.checked.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date());

  bridgeUi.start.disabled = busy || connected || status.loaded === true || !status.controllable;
  bridgeUi.restart.disabled = busy || !status.controllable;
  bridgeUi.stop.disabled = busy || status.state === 'stopped' || !status.controllable;
  bridgeUi.scan.disabled = busy || !connected;
  if (bridgeUi.reconcileScan) bridgeUi.reconcileScan.disabled = busy || !connected;
  if (bridgeUi.permissions) {
    bridgeUi.permissions.disabled = busy || !status.controllable;
    bridgeUi.permissions.hidden = status.state !== 'permission_required';
  }
  if (bridgeUi.controlNote) bridgeUi.controlNote.hidden = status.controllable;

  if (connected) {
    setUiMessage('', 'neutral');
  } else if (status.state === 'permission_required') {
    setUiMessage('Open System Settings, grant Full Disk Access to the bridge host, then choose Retry connection.', 'error');
  } else if (status.state === 'schema_incompatible') {
    setUiMessage('The Messages database changed after a macOS update. Keep capture stopped until the local reader is updated.', 'error');
  } else if (status.code === 'bridge_unreachable') {
    setUiMessage('The service is loaded but not responding. Choose Restart bridge to recover it.', 'error');
  }
}

function renderAutomationStatus(status) {
  if (!bridgeUi || !status || !bridgeUi.autoIngest) return;
  const enabled = status.enabled === true && status.hardDisabled !== true;
  bridgeUi.autoIngest.checked = enabled;
  bridgeUi.autoIngest.disabled = status.hardDisabled === true || status.running === true;
  bridgeUi.autoIngestState.textContent = status.hardDisabled
    ? 'Disabled by local kill switch'
    : enabled
      ? status.running ? 'Running a local scan' : 'On · checks in the background'
      : 'Off · no background scans';
  bridgeUi.autoIngestNote.textContent = status.hardDisabled
    ? 'The kill switch is active. New Messages alerts will not be ingested.'
    : 'Reads approved bank alerts locally and writes only the local ledger file. It never writes to Messages.';
}

async function refreshBridgeStatus({ announceErrors = false } = {}) {
  try {
    const [status, automation] = await Promise.all([
      bridgeClient.status(),
      bridgeClient.automationStatus().catch(() => null)
    ]);
    renderBridgeStatus(status);
    renderAutomationStatus(automation);
    return status;
  } catch (error) {
    const status = {
      ok: false,
      state: 'error',
      code: error.code,
      message: error.message,
      controllable: Boolean(controlUrl),
      installed: null,
      loaded: null,
      databaseReadable: null
    };
    renderBridgeStatus(status);
    if (announceErrors) setUiMessage(error.message, 'error');
    return status;
  }
}

async function performBridgeAction(action) {
  if (!bridgeUi) return;
  const actionCopy = action === 'stop' ? 'Stopping bridge...' : action === 'restart' ? 'Restarting bridge...' : 'Starting bridge...';
  setUiMessage(actionCopy, 'progress');
  [bridgeUi.start, bridgeUi.restart, bridgeUi.stop, bridgeUi.permissions, bridgeUi.scan, bridgeUi.reconcileScan, bridgeUi.autoIngest].filter(Boolean).forEach((element) => { element.disabled = true; });
  try {
    const status = await bridgeClient.perform(action);
    renderBridgeStatus(status);
    if (action === 'stop') {
      setUiMessage('Messages capture is stopped. Existing ledger entries remain available.', 'success');
    } else if (status.ok) {
      setUiMessage('Messages bridge connected successfully.', 'success');
    } else {
      setUiMessage(status.message || 'The bridge started but still needs attention.', 'error');
    }
  } catch (error) {
    setUiMessage(error.message, 'error');
    await refreshBridgeStatus();
  }
}

async function toggleAutomaticIngestion(event) {
  if (!bridgeUi) return;
  const requested = event.currentTarget.checked;
  bridgeUi.autoIngest.disabled = true;
  setUiMessage(requested ? 'Turning on background ingestion...' : 'Turning off background ingestion...', 'progress');
  try {
    const status = await bridgeClient.setAutomationEnabled(requested);
    renderAutomationStatus(status);
    setUiMessage(requested ? 'Background ingestion is on.' : 'Background ingestion is off. Existing ledger entries remain available.', 'success');
  } catch (error) {
    event.currentTarget.checked = !requested;
    bridgeUi.autoIngest.disabled = false;
    setUiMessage(error.message, 'error');
  }
}

async function openPermissionSettings() {
  if (!bridgeUi) return;
  setUiMessage('Opening Full Disk Access in System Settings...', 'progress');
  try {
    await bridgeClient.perform('open-permissions');
    setUiMessage('System Settings is open. Enable Full Disk Access for the local Messages bridge host, then choose Retry connection.', 'error');
  } catch (error) {
    setUiMessage(error.message, 'error');
  }
}

async function scanMacMessages({ reconcile = false, trigger = bridgeUi?.scan } = {}) {
  if (!bridgeUi) return;
  if (reconcile && !window.confirm('Reconcile the local ledger from Messages without clearing existing entries? Existing approvals and review edits will be preserved.')) return;
  const idleLabel = trigger?.textContent || 'Scan Mac Messages';
  [bridgeUi.scan, bridgeUi.reconcileScan].filter(Boolean).forEach((element) => { element.disabled = true; });
  if (trigger) trigger.textContent = reconcile ? 'Reconciling safely...' : 'Scanning local Messages...';
  setUiMessage(reconcile
    ? 'Reading Messages into a temporary ledger. Existing local entries will be preserved unless the full operation succeeds.'
    : 'Reading approved sender profiles from Apple Messages...', 'progress');
  try {
    const messages = await bridgeClient.scan(5000);
    const result = window.__harborApplyMessageBatch(messages);
    const summary = result.summary || summarizeScanResults(result.results, messages.length);
    window.__harborShowToast(`${reconcile ? 'Ledger reconciled safely. ' : ''}${summary.text}`);
  } catch (error) {
    const summary = error.scanSummary?.text;
    setUiMessage(summary ? `${error.message} ${summary}` : error.message, 'error');
    window.__harborShowToast(summary ? `${error.message} ${summary}` : error.message);
  } finally {
    if (bridgeUi) {
      if (trigger) trigger.textContent = idleLabel;
      bridgeUi.scan.disabled = false;
      if (bridgeUi.reconcileScan) bridgeUi.reconcileScan.disabled = false;
      await refreshBridgeStatus();
    }
  }
}

let isSyncingLedger = false;
async function syncLedgerFromService({ announceErrors = false } = {}) {
  if (isSyncingLedger) return null;
  isSyncingLedger = true;
  try {
    const localSnapshot = window.__harborGetLedgerSnapshot?.();
    if (!localSnapshot) return null;
    const remotePayload = await bridgeClient.ledgerState();
    const merged = mergeLedgerSnapshots(localSnapshot, remotePayload.snapshot);
    if (JSON.stringify(merged) !== JSON.stringify(remotePayload.snapshot)) await bridgeClient.saveLedger(merged);
    window.__harborReplaceLedgerSnapshot(merged, { notifyRemote: false, renderNow: false });
    window.__harborRender();
    return merged;
  } catch (error) {
    if (announceErrors) setUiMessage(`The authoritative local ledger is unavailable. The dashboard is using its last local cache. ${error.message}`, 'error');
    return null;
  } finally {
    isSyncingLedger = false;
  }
}

window.__harborLedgerChanged = async (snapshot) => {
  try {
    const remotePayload = await bridgeClient.ledgerState();
    const merged = mergeLedgerSnapshots(snapshot, remotePayload.snapshot);
    await bridgeClient.saveLedger(merged);
    if (JSON.stringify(merged) !== JSON.stringify(snapshot)) window.__harborReplaceLedgerSnapshot(merged, { notifyRemote: false, renderNow: true });
  } catch (error) {
    setUiMessage(`The local service could not be updated. Your dashboard cache remains available. ${error.message}`, 'error');
  }
};

function renderMessagesSource() {
  const settings = document.querySelector('.settings-layout');
  if (!settings) {
    if (bridgeUi && !document.contains(bridgeUi.status)) {
      clearInterval(bridgePollTimer);
      bridgePollTimer = null;
      bridgeUi = null;
    }
    return;
  }
  if (document.querySelector('#automatic-approval-test-mode')) return;

  const card = document.createElement('section');
  card.id = 'automatic-approval-test-mode';
  card.className = 'card settings-section bridge-control-card';
  card.setAttribute('aria-labelledby', 'automatic-approval-test-title');

  const heading = document.createElement('div');
  heading.className = 'card-header';
  const headingCopy = document.createElement('div');
  const eyebrow = document.createElement('span');
  eyebrow.className = 'card-label';
  eyebrow.textContent = 'Messages source';
  const title = document.createElement('h2');
  title.id = 'automatic-approval-test-title';
  title.textContent = 'Bank alerts on this Mac Mini';
  headingCopy.append(eyebrow, title);
  const status = document.createElement('span');
  status.className = 'source-chip source-chip-review';
  status.textContent = 'Checking...';
  status.setAttribute('aria-live', 'polite');
  heading.append(headingCopy, status);

  const description = document.createElement('p');
  description.className = 'settings-section-copy';
  description.textContent = 'Control the read-only Messages source and scan approved bank alerts.';

  const connection = document.createElement('div');
  connection.className = 'bridge-connection-state';
  const connectionMark = document.createElement('span');
  connectionMark.className = 'bridge-connection-mark';
  connectionMark.textContent = 'MB';
  const connectionCopy = document.createElement('div');
  const connectionTitle = document.createElement('strong');
  connectionTitle.textContent = 'Checking the Messages bridge';
  const connectionMessage = document.createElement('span');
  connectionMessage.textContent = 'Confirming the local service and Messages permission.';
  connectionMessage.setAttribute('aria-live', 'polite');
  connectionCopy.append(connectionTitle, connectionMessage);
  connection.append(connectionMark, connectionCopy);

  const healthDetails = document.createElement('div');
  healthDetails.className = 'settings-list bridge-health-list';
  const serviceRow = listRow('Bridge service', 'Checking...', 'bridge-service-state');
  const accessRow = listRow('Messages access', 'Checking...', 'bridge-access-state');
  const checkedRow = listRow('Last checked', 'Now', 'bridge-last-checked');
  healthDetails.append(serviceRow, accessRow, checkedRow);

  const automationPanel = document.createElement('div');
  automationPanel.className = 'bridge-automation-control';
  const automationCopy = document.createElement('div');
  const automationLabel = document.createElement('label');
  automationLabel.htmlFor = 'automatic-ingestion-toggle';
  automationLabel.textContent = 'Automatic ingestion';
  const automationNote = document.createElement('span');
  automationNote.textContent = 'Reads new bank alerts in the background.';
  automationCopy.append(automationLabel, automationNote);
  const automationState = document.createElement('strong');
  automationState.id = 'automatic-ingestion-state';
  automationState.textContent = 'Checking...';
  const automationToggle = document.createElement('input');
  automationToggle.id = 'automatic-ingestion-toggle';
  automationToggle.type = 'checkbox';
  automationToggle.role = 'switch';
  automationToggle.addEventListener('change', toggleAutomaticIngestion);
  automationPanel.append(automationCopy, automationState, automationToggle);

  const actions = document.createElement('div');
  actions.className = 'bridge-actions';
  const serviceActions = document.createElement('div');
  serviceActions.className = 'bridge-action-group';
  const serviceActionsLabel = document.createElement('span');
  serviceActionsLabel.className = 'bridge-action-label';
  serviceActionsLabel.textContent = 'Bridge service';
  const serviceActionButtons = document.createElement('div');
  serviceActionButtons.className = 'bridge-action-buttons';
  const startButton = button('Start bridge', () => performBridgeAction('start'), 'button button-primary');
  const restartButton = button('Retry connection', () => performBridgeAction('restart'));
  const stopButton = button('Stop bridge', () => performBridgeAction('stop'));
  const permissionButton = button('Open Full Disk Access', openPermissionSettings, 'button button-secondary');
  permissionButton.hidden = true;
  serviceActionButtons.append(startButton, restartButton, stopButton, permissionButton);
  serviceActions.append(serviceActionsLabel, serviceActionButtons);

  const ledgerActions = document.createElement('div');
  ledgerActions.className = 'bridge-action-group';
  const ledgerActionsLabel = document.createElement('span');
  ledgerActionsLabel.className = 'bridge-action-label';
  ledgerActionsLabel.textContent = 'Ledger actions';
  const ledgerActionButtons = document.createElement('div');
  ledgerActionButtons.className = 'bridge-action-buttons';
  const scanButton = button('Scan Mac Messages', scanMacMessages, 'button button-secondary');
  const reconcileScanButton = button('Reconcile without clearing', () => scanMacMessages({ reconcile: true, trigger: reconcileScanButton }), 'button button-secondary');
  const refreshButton = button('Refresh dashboard', () => window.location.reload(), 'button button-secondary');
  ledgerActionButtons.append(scanButton, reconcileScanButton, refreshButton);
  ledgerActions.append(ledgerActionsLabel, ledgerActionButtons);
  actions.append(serviceActions, ledgerActions);

  const controlNote = document.createElement('p');
  controlNote.className = 'bridge-control-note';
  controlNote.textContent = 'Service controls require the local production dashboard. Scanning remains available whenever the bridge is already connected.';
  controlNote.hidden = true;

  const feedback = document.createElement('div');
  feedback.className = 'bridge-feedback';
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  feedback.hidden = true;

  card.append(
    heading,
    description,
    healthDetails,
    automationPanel,
    actions,
    controlNote,
    feedback
  );
  settings.append(card);

  bridgeUi = {
    access: accessRow.querySelector('strong'),
    checked: checkedRow.querySelector('strong'),
    controlNote,
    feedback,
    autoIngest: automationToggle,
    autoIngestNote: automationNote,
    autoIngestState: automationState,
    message: connectionMessage,
    permissions: permissionButton,
    restart: restartButton,
    reconcileScan: reconcileScanButton,
    scan: scanButton,
    service: serviceRow.querySelector('strong'),
    start: startButton,
    status,
    stop: stopButton,
    title: connectionTitle
  };
  clearInterval(bridgePollTimer);
  refreshBridgeStatus({ announceErrors: true });
  bridgePollTimer = window.setInterval(refreshBridgeStatus, 10_000);
}

async function initialSyncWithRetry(retries = 5, delayMs = 500) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await syncLedgerFromService({ announceErrors: attempt === retries });
    if (result) return result;
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(1.5, attempt)));
    }
  }
  return null;
}

let lastSyncedAt = null;
async function pollLedgerUpdates() {
  try {
    const automation = await bridgeClient.automationStatus();
    if (automation?.lastSuccessfulAt) {
      if (lastSyncedAt && automation.lastSuccessfulAt !== lastSyncedAt) {
        lastSyncedAt = automation.lastSuccessfulAt;
        await syncLedgerFromService({ announceErrors: false });
      } else if (!lastSyncedAt) {
        lastSyncedAt = automation.lastSuccessfulAt;
      }
    }
  } catch {
    // Background poll error is non-fatal
  }
}

new MutationObserver(renderMessagesSource).observe(document.body, { childList: true, subtree: true });
renderMessagesSource();
void initialSyncWithRetry();
window.setInterval(pollLedgerUpdates, 15_000);
