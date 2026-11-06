import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const launchAgentLabel = 'com.harbor.local-bridge';
const defaultAgentPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel}.plist`);
const defaultBridgeUrl = 'http://127.0.0.1:4317';
const installScript = path.join(root, 'scripts', 'install-harbor-launchagent.sh');
const uninstallScript = path.join(root, 'scripts', 'uninstall-harbor-launchagent.sh');

export class BridgeControlError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'BridgeControlError';
    this.code = code;
    this.status = status;
  }
}

function fileExists(filePath) {
  return access(filePath).then(() => true, () => false);
}

function runFile(file, args, { timeoutMs = 45_000, maxOutputBytes = 128 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: root, timeout: timeoutMs, maxBuffer: maxOutputBytes }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).trim().split('\n').at(-1);
        reject(new BridgeControlError('control_command_failed', detail || 'The bridge control command failed.'));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new BridgeControlError('invalid_bridge_response', 'The bridge returned an invalid health response.');
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function createBridgeSupervisor({
  agentPath = process.env.HARBOR_BRIDGE_AGENT_PATH || defaultAgentPath,
  bridgeUrl = process.env.HARBOR_BRIDGE_URL || defaultBridgeUrl,
  runFileImpl = runFile,
  fileExistsImpl = fileExists,
  fetchJsonImpl = fetchJson
} = {}) {
  let pendingAction = null;

  async function isLoaded() {
    try {
      await runFileImpl('/bin/launchctl', ['print', `gui/${process.getuid()}/${launchAgentLabel}`], { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async function status() {
    const [installed, loaded] = await Promise.all([fileExistsImpl(agentPath), isLoaded()]);
    try {
      const health = await fetchJsonImpl(`${bridgeUrl}/health`);
      if (pendingAction === 'stop') {
        return {
          ...health,
          ok: false,
          state: 'stopping',
          code: null,
          message: 'Stopping the Messages bridge...',
          installed,
          loaded,
          controllable: true,
          pendingAction
        };
      }
      return {
        ...health,
        installed,
        loaded,
        controllable: true,
        pendingAction
      };
    } catch {
      const stopping = pendingAction === 'stop' && loaded;
      const state = stopping ? 'stopping' : pendingAction && pendingAction !== 'stop' ? 'starting' : 'stopped';
      return {
        ok: false,
        state,
        code: loaded ? 'bridge_unreachable' : 'bridge_stopped',
        message: stopping
          ? 'Stopping the Messages bridge...'
          : loaded
          ? 'The bridge service is loaded but not responding. Restart it to recover.'
          : 'The Messages bridge is stopped. Start it here to connect.',
        helperAvailable: null,
        databaseReadable: null,
        installed,
        loaded,
        controllable: true,
        pendingAction
      };
    }
  }

  async function waitForStatus({ attempts = 20, intervalMs = 250 } = {}) {
    let current = await status();
    for (let attempt = 1; attempt < attempts && current.state === 'starting'; attempt += 1) {
      await delay(intervalMs);
      current = await status();
    }
    return current;
  }

  async function waitForStopped({ attempts = 20, intervalMs = 100 } = {}) {
    let current = await status();
    for (let attempt = 1; attempt < attempts && current.state === 'stopping'; attempt += 1) {
      await delay(intervalMs);
      current = await status();
    }
    return current;
  }

  async function perform(action) {
    if (!['start', 'stop', 'restart', 'open-permissions'].includes(action)) {
      throw new BridgeControlError('invalid_action', 'Choose start, stop, restart, or open permissions.', 400);
    }
    if (pendingAction) {
      throw new BridgeControlError('bridge_busy', `The bridge is already ${pendingAction === 'stop' ? 'stopping' : 'starting'}.`, 409);
    }

    pendingAction = action;
    try {
      if (action === 'open-permissions') {
        await runFileImpl('/usr/bin/open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], { timeoutMs: 5000 });
        return await status();
      }
      if (action === 'stop') {
        await runFileImpl('/bin/zsh', [uninstallScript]);
        return await waitForStopped();
      }

      await runFileImpl('/bin/zsh', [installScript]);
      return await waitForStatus();
    } finally {
      pendingAction = null;
    }
  }

  return { perform, status };
}
