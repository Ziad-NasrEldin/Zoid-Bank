import { copyFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LEDGER_STORAGE_KEY, normalizeLedgerSnapshotResult } from './harbor-ledger-sync.js';

const applicationDirectory = path.join(os.homedir(), 'Library', 'Application Support', 'Zoid Bank');

export const defaultLedgerPath = process.env.HARBOR_LEDGER_PATH || path.join(applicationDirectory, 'ledger.json');
export const defaultAutomationConfigPath = process.env.HARBOR_AUTOMATION_CONFIG_PATH || path.join(applicationDirectory, 'automation.json');

export function backupPathFor(filePath) {
  return `${filePath}.bak`;
}

function ensureParent(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

export function atomicWriteText(filePath, value, { preserveBackup = true } = {}) {
  ensureParent(filePath);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryPath, value, { encoding: 'utf8', mode: 0o600 });
    if (preserveBackup && readText(filePath) !== null) {
      copyFileSync(filePath, backupPathFor(filePath));
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

export function recoverFileFromBackup(filePath, value) {
  atomicWriteText(filePath, value, { preserveBackup: false });
}

export function readText(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function readJsonFile(filePath) {
  const raw = readText(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createFileStorage(filePath = defaultLedgerPath) {
  return {
    getItem(key) {
      if (key !== LEDGER_STORAGE_KEY) return null;
      return readText(filePath);
    },
    setItem(key, value) {
      if (key !== LEDGER_STORAGE_KEY) return;
      const nextText = String(value);
      try {
        normalizeLedgerSnapshotResult(JSON.parse(nextText), { allowLegacy: true });
      } catch {
        const error = new Error('The replacement ledger snapshot is invalid and was not written.');
        error.code = 'invalid_ledger_snapshot';
        throw error;
      }
      const existing = readText(filePath);
      if (existing !== null) {
        try {
          normalizeLedgerSnapshotResult(JSON.parse(existing), { allowLegacy: true });
        } catch {
          const error = new Error('The authoritative ledger is corrupt and cannot be overwritten automatically.');
          error.code = 'ledger_corrupt';
          throw error;
        }
      } else if (readText(backupPathFor(filePath)) !== null) {
        const error = new Error('The authoritative ledger is missing while a backup exists. Recover it deliberately before writing.');
        error.code = 'ledger_missing_backup_available';
        throw error;
      }
      atomicWriteText(filePath, nextText);
    },
    removeItem(key) {
      if (key !== LEDGER_STORAGE_KEY) return;
      try {
        unlinkSync(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  };
}

