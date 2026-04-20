import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const CONNECTORS_DIR = join(ROOT, 'kernel', 'connectors');
const MANIFESTS_DIR = join(CONNECTORS_DIR, 'manifests');
const STATE_PATH = join(CONNECTORS_DIR, 'state.json');
const STATE_TMP_PATH = `${STATE_PATH}.tmp`;
const ENV_PATH = join(ROOT, '.env');
const WATCH_DEBOUNCE_MS = 250;
const HTTP_TIMEOUT_MS = 3000;

let _watcher = null;
let _queuedRun = Promise.resolve();
let _watchTimers = new Map();

function ensureDirs() {
  mkdirSync(MANIFESTS_DIR, { recursive: true });
}

function loadFileEnv() {
  if (!existsSync(ENV_PATH)) return {};

  const env = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index < 1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }

  return env;
}

function getEnvValue(name) {
  if (!name) return '';
  const fileEnv = loadFileEnv();
  return process.env[name] || fileEnv[name] || '';
}

function expandEnvVars(input) {
  return String(input || '').replace(/%([^%]+)%/g, (_, name) => getEnvValue(name));
}

function normalizeValue(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function readJson(pathname) {
  return JSON.parse(readFileSync(pathname, 'utf8'));
}

function isFile(pathname) {
  if (!pathname) return false;
  try {
    return statSync(pathname).isFile();
  } catch {
    return false;
  }
}

function compareSemver(left, right) {
  const leftParts = String(left || '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

function readManifestFile(pathname) {
  const manifest = readJson(pathname);
  return {
    type: 'exec',
    criticality: 'low',
    ...manifest,
  };
}

function readAllManifests() {
  ensureDirs();
  return readdirSync(MANIFESTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readManifestFile(join(MANIFESTS_DIR, name)));
}

function readManifestById(id) {
  const directPath = join(MANIFESTS_DIR, `${id}.json`);
  if (existsSync(directPath)) return readManifestFile(directPath);

  return readAllManifests().find((manifest) => manifest.id === id) || null;
}

function buildConnectorState(manifest, overrides = {}) {
  return {
    id: manifest.id,
    displayName: manifest.displayName || manifest.id,
    path: null,
    version: null,
    status: 'unknown',
    lastChecked: new Date().toISOString(),
    criticality: manifest.criticality || 'low',
    ...overrides,
  };
}

function findExecutableInSearchPaths(manifest) {
  const execNames = Array.isArray(manifest.execNames) ? manifest.execNames : [];
  const searchRoots = Array.isArray(manifest.winSearchPaths) ? manifest.winSearchPaths : [];

  for (const rawRoot of searchRoots) {
    const root = expandEnvVars(rawRoot);
    if (!root || !existsSync(root)) continue;

    if (isFile(root)) {
      const filename = basename(root).toLowerCase();
      if (execNames.some((execName) => execName.toLowerCase() === filename)) return root;
      continue;
    }

    for (const execName of execNames) {
      const directCandidate = join(root, execName);
      if (isFile(directCandidate)) return directCandidate;
    }

    let children = [];
    try {
      children = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name));
    } catch {}

    for (const child of children) {
      for (const execName of execNames) {
        const nestedCandidate = join(child, execName);
        if (isFile(nestedCandidate)) return nestedCandidate;
      }
    }
  }

  return null;
}

function findExecutableOnPath(execNames) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';

  for (const execName of execNames) {
    try {
      const output = execFileSync(locator, [execName], {
        encoding: 'utf8',
        timeout: HTTP_TIMEOUT_MS,
        windowsHide: true,
      });

      for (const line of output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        if (isFile(line)) return line;
      }
    } catch {}
  }

  return null;
}

function resolveExecutable(manifest) {
  const execNames = Array.isArray(manifest.execNames) ? manifest.execNames : [];
  const overrideValue = normalizeValue(getEnvValue(manifest.envOverride));
  if (overrideValue && isFile(overrideValue)) {
    return { path: overrideValue, from: 'env' };
  }

  const searchPathMatch = findExecutableInSearchPaths(manifest);
  if (searchPathMatch) {
    return { path: searchPathMatch, from: 'search-paths' };
  }

  const pathMatch = findExecutableOnPath(execNames);
  if (pathMatch) {
    return { path: pathMatch, from: 'PATH' };
  }

  return {
    path: null,
    from: null,
    error: overrideValue
      ? `env override ${manifest.envOverride} does not point to an existing file`
      : 'executable not found',
  };
}

function quoteCmdArg(value) {
  if (/[\s"]/u.test(value)) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
  }
  return String(value);
}

function readVersion(executablePath, manifest) {
  const args = Array.isArray(manifest.versionArgs) ? manifest.versionArgs : [];
  const isCmdWrapper = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executablePath);
  const result = isCmdWrapper
    ? spawnSync(
      'cmd.exe',
      ['/d', '/s', '/c', [quoteCmdArg(executablePath), ...args.map(quoteCmdArg)].join(' ')],
      {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      }
    )
    : spawnSync(executablePath, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });

  if (result.error) throw result.error;

  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (!output) {
    throw new Error(`version command produced no output${Number.isInteger(result.status) ? ` (exit ${result.status})` : ''}`);
  }

  const match = output.match(new RegExp(manifest.versionRegex));
  if (!match?.[1]) {
    throw new Error(`version regex did not match output: ${output}`);
  }

  return match[1];
}

async function discoverExec(manifest) {
  const state = buildConnectorState(manifest);
  const resolved = resolveExecutable(manifest);

  if (!resolved.path) {
    return {
      ...state,
      status: 'unavailable',
      error: resolved.error,
    };
  }

  state.path = resolved.path;

  try {
    state.version = readVersion(resolved.path, manifest);
  } catch (error) {
    return {
      ...state,
      status: 'unknown',
      error: error.message,
    };
  }

  if (manifest.minVersion && compareSemver(state.version, manifest.minVersion) < 0) {
    return {
      ...state,
      status: 'incompatible',
      error: `requires >= ${manifest.minVersion}`,
    };
  }

  return {
    ...state,
    status: 'ok',
  };
}

async function discoverHttp(manifest) {
  const state = buildConnectorState(manifest);
  const overrideUrl = normalizeValue(getEnvValue(manifest.envOverride));
  const url = overrideUrl || normalizeValue(manifest.url);
  const expectStatus = Number.isInteger(manifest.expectStatus) ? manifest.expectStatus : 200;

  state.path = url || null;

  if (!url) {
    return {
      ...state,
      status: 'unavailable',
      error: 'service url not configured',
    };
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(manifest.timeoutMs || HTTP_TIMEOUT_MS),
    });

    if (response.status !== expectStatus) {
      return {
        ...state,
        status: 'unavailable',
        error: `HTTP ${response.status}`,
      };
    }

    return {
      ...state,
      status: 'ok',
    };
  } catch (error) {
    return {
      ...state,
      status: 'unavailable',
      error: error.message,
    };
  }
}

// AppX (Windows Store apps) discovery removed 2026-04-19:
// Codex Desktop AppX path permanently abandoned; use codex-cli (npm) only.
// Reasons: AppX sandbox forbids spawn from terminal, no MCP entry point,
// 0 local conversation data (cloud-only). Codex CLI handles all use cases.

async function discoverFromManifest(manifest) {
  if (manifest.type === 'http') return discoverHttp(manifest);
  return discoverExec(manifest);
}

function serializeState(stateMap) {
  return {
    updatedAt: new Date().toISOString(),
    connectors: Array.from(stateMap.values()).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function writeStateAtomically(stateMap) {
  ensureDirs();
  const payload = JSON.stringify(serializeState(stateMap), null, 2);
  writeFileSync(STATE_TMP_PATH, payload, 'utf8');

  try {
    renameSync(STATE_TMP_PATH, STATE_PATH);
  } catch {
    writeFileSync(STATE_PATH, payload, 'utf8');
    try {
      rmSync(STATE_TMP_PATH, { force: true });
    } catch {}
  }
}

function readStateFile() {
  ensureDirs();
  if (!existsSync(STATE_PATH)) {
    return { updatedAt: null, connectors: [] };
  }

  try {
    const parsed = readJson(STATE_PATH);
    if (Array.isArray(parsed?.connectors)) return parsed;
  } catch {}

  return { updatedAt: null, connectors: [] };
}

export function getState() {
  const parsed = readStateFile();
  return new Map(
    (parsed.connectors || [])
      .filter((entry) => entry && entry.id)
      .map((entry) => [entry.id, entry]),
  );
}

function buildDedupHash(state) {
  return createHash('sha256')
    .update(`${state.id}:${state.version || 'none'}`)
    .digest('hex')
    .slice(0, 12);
}

async function maybeWriteStatusChangeMemory(previous, current) {
  if (!previous || previous.status === current.status) return;

  const { readMemories, writeMemory } = await import('../memory/memory-writer.mjs');
  const dedupHash = buildDedupHash(current);
  const name = `connector-${current.id}-${current.status}`;
  const dedupLine = `DedupKey: ${dedupHash}`;
  const alreadyWritten = readMemories({ type: 'feedback' })
    .some((entry) => entry.name === name && entry.body.includes(dedupLine));

  if (alreadyWritten) return;

  const body = [
    `Connector: ${current.displayName}`,
    `ID: ${current.id}`,
    `Status: ${previous.status} -> ${current.status}`,
    `Version: ${previous.version || 'n/a'} -> ${current.version || 'n/a'}`,
    `Path: ${current.path || 'n/a'}`,
    current.error ? `Error: ${current.error}` : null,
    dedupLine,
  ].filter(Boolean).join('\n');

  writeMemory({
    type: 'feedback',
    name,
    description: `Connector ${current.id} status changed to ${current.status}`,
    body,
    source: 'connector-discovery',
    confidence: 0.9,
  });
}

async function runSingleDiscovery(id) {
  const manifest = readManifestById(id);
  const nextState = getState();

  if (!manifest) {
    nextState.delete(id);
    writeStateAtomically(nextState);
    return null;
  }

  let connectorState;
  try {
    connectorState = await discoverFromManifest(manifest);
  } catch (error) {
    connectorState = buildConnectorState(manifest, {
      status: 'unknown',
      error: error.message,
    });
  }

  const previous = nextState.get(manifest.id);
  try {
    await maybeWriteStatusChangeMemory(previous, connectorState);
  } catch (error) {
    console.warn(`[connector-discovery] memory write failed for ${manifest.id}: ${error.message}`);
  }

  nextState.set(manifest.id, connectorState);
  writeStateAtomically(nextState);
  return connectorState;
}

async function runAllDiscovery() {
  const manifests = readAllManifests();
  const previousState = getState();
  const nextState = new Map();

  for (const manifest of manifests) {
    let connectorState;
    try {
      connectorState = await discoverFromManifest(manifest);
    } catch (error) {
      connectorState = buildConnectorState(manifest, {
        status: 'unknown',
        error: error.message,
      });
    }

    const previous = previousState.get(manifest.id);
    try {
      await maybeWriteStatusChangeMemory(previous, connectorState);
    } catch (error) {
      console.warn(`[connector-discovery] memory write failed for ${manifest.id}: ${error.message}`);
    }

    nextState.set(manifest.id, connectorState);
  }

  writeStateAtomically(nextState);
  return nextState;
}

function enqueue(task) {
  const run = _queuedRun
    .catch(() => {})
    .then(task);
  _queuedRun = run.catch(() => {});
  return run;
}

export async function discoverAll() {
  return enqueue(() => runAllDiscovery());
}

export async function discover(id) {
  return enqueue(() => runSingleDiscovery(id));
}

export function startWatcher() {
  if (_watcher) return _watcher;

  ensureDirs();
  discoverAll().catch((error) => {
    console.warn(`[connector-discovery] initial discover failed: ${error.message}`);
  });

  _watcher = watch(MANIFESTS_DIR, (_eventType, filename) => {
    if (!filename || !String(filename).endsWith('.json')) return;

    const key = String(filename);
    const existingTimer = _watchTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      _watchTimers.delete(key);

      const fullPath = join(MANIFESTS_DIR, key);
      if (existsSync(fullPath)) {
        discover(basename(key, '.json')).catch((error) => {
          console.warn(`[connector-discovery] manifest reload failed for ${key}: ${error.message}`);
        });
      } else {
        discoverAll().catch((error) => {
          console.warn(`[connector-discovery] manifest rescan failed after ${key}: ${error.message}`);
        });
      }
    }, WATCH_DEBOUNCE_MS);

    _watchTimers.set(key, timer);
  });

  return _watcher;
}

export function stopWatcher() {
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }

  for (const timer of _watchTimers.values()) {
    clearTimeout(timer);
  }
  _watchTimers.clear();
}

export const getConnectorState = getState;
export const startConnectorWatcher = startWatcher;
export const stopConnectorWatcher = stopWatcher;
