/**
 * credential-pool.mjs
 * Multi-credential failover pool for Gemini API keys.
 *
 * Supports multiple keys via comma-separated GEMINI_API_KEYS env var.
 * Falls back to single GEMINI_API_KEY if GEMINI_API_KEYS not set.
 *
 * Strategies: round-robin (default), least-used, fill-first
 * Cooldown: keys that hit 429 are cooled down for COOLDOWN_MS (default 60s)
 *
 * Inspired by hermes-agent/agent/credential_pool.py
 */

// ---------------------------------------------------------------------------
// Configuration (all from env, no hardcoding)
// ---------------------------------------------------------------------------

const COOLDOWN_MS = parseInt(process.env.CREDENTIAL_POOL_COOLDOWN_MS || '60000', 10);
const DISABLE_AFTER_CONSECUTIVE = parseInt(process.env.CREDENTIAL_POOL_DISABLE_AFTER || '3', 10);
const DISABLE_MS = parseInt(process.env.CREDENTIAL_POOL_DISABLE_MS || '300000', 10);
const DEFAULT_STRATEGY = process.env.CREDENTIAL_POOL_STRATEGY || 'round-robin';

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

const STRATEGIES = new Set(['round-robin', 'least-used', 'fill-first']);

// ---------------------------------------------------------------------------
// Pool state
// ---------------------------------------------------------------------------

/** @type {Array<PoolEntry>} */
let _entries = [];

/** Index for round-robin rotation */
let _rrIndex = 0;

/**
 * @typedef {Object} PoolEntry
 * @property {string}  key
 * @property {number}  requestCount
 * @property {number}  lastUsed         — epoch ms, 0 = never
 * @property {number}  cooldownUntil    — epoch ms, 0 = not cooling
 * @property {number}  consecutiveErrors
 * @property {number}  disabledUntil    — epoch ms, 0 = not disabled
 */

/**
 * Create a fresh entry from a raw key string.
 * @param {string} key
 * @returns {PoolEntry}
 */
function _makeEntry(key) {
  return {
    key,
    requestCount: 0,
    lastUsed: 0,
    cooldownUntil: 0,
    consecutiveErrors: 0,
    disabledUntil: 0,
  };
}

// ---------------------------------------------------------------------------
// Initialization — parse env vars once on import
// ---------------------------------------------------------------------------

function _init() {
  const multi = (process.env.GEMINI_API_KEYS || '').trim();
  const single = (process.env.GEMINI_API_KEY || '').trim();

  /** @type {string[]} */
  let keys = [];

  if (multi) {
    keys = multi.split(',').map(k => k.trim()).filter(Boolean);
  }

  // Fallback: single key (always include if not already present)
  if (single && !keys.includes(single)) {
    if (keys.length === 0) {
      keys.push(single);
    }
    // If multi already contains single, skip duplicate
  }

  // Deduplicate while preserving order
  const seen = new Set();
  const unique = [];
  for (const k of keys) {
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(k);
    }
  }

  _entries = unique.map(_makeEntry);

  if (_entries.length > 0) {
    console.log(`[credential-pool] Initialized with ${_entries.length} key(s), strategy=${DEFAULT_STRATEGY}, cooldown=${COOLDOWN_MS}ms`);
  } else {
    console.warn('[credential-pool] No GEMINI_API_KEYS or GEMINI_API_KEY configured — pool is empty');
  }
}

_init();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return entries that are currently available (not cooling down, not disabled).
 * @returns {PoolEntry[]}
 */
function _available() {
  const now = Date.now();
  return _entries.filter(e =>
    now >= e.cooldownUntil &&
    now >= e.disabledUntil,
  );
}

/**
 * Find entry by key value.
 * @param {string} key
 * @returns {PoolEntry|undefined}
 */
function _find(key) {
  return _entries.find(e => e.key === key);
}

// ---------------------------------------------------------------------------
// Strategy selectors
// ---------------------------------------------------------------------------

/**
 * Round-robin: cycle through available entries in order.
 * @param {PoolEntry[]} available
 * @returns {PoolEntry}
 */
function _selectRoundRobin(available) {
  // Map available back to their indices in _entries for stable rotation
  if (available.length === 1) return available[0];
  _rrIndex = _rrIndex % _entries.length;
  // Find the next available entry starting from _rrIndex
  for (let i = 0; i < _entries.length; i++) {
    const idx = (_rrIndex + i) % _entries.length;
    const entry = _entries[idx];
    if (available.includes(entry)) {
      _rrIndex = idx + 1;
      return entry;
    }
  }
  // Fallback (shouldn't happen if available.length > 0)
  return available[0];
}

/**
 * Least-used: pick the entry with the lowest requestCount.
 * @param {PoolEntry[]} available
 * @returns {PoolEntry}
 */
function _selectLeastUsed(available) {
  let best = available[0];
  for (let i = 1; i < available.length; i++) {
    if (available[i].requestCount < best.requestCount) {
      best = available[i];
    }
  }
  return best;
}

/**
 * Fill-first: always use the first available entry until it's cooled down.
 * @param {PoolEntry[]} available
 * @returns {PoolEntry}
 */
function _selectFillFirst(available) {
  return available[0];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the best available API key based on the chosen strategy.
 *
 * @param {string} [strategy] — override strategy for this call
 * @returns {string|null} API key string, or null if pool is empty / all keys unavailable
 */
export function getKey(strategy) {
  const strat = strategy || DEFAULT_STRATEGY;
  const available = _available();

  if (available.length === 0) {
    // Last resort: if all keys are on cooldown/disabled, return the one
    // whose cooldown expires soonest (graceful degradation)
    if (_entries.length > 0) {
      const soonest = _entries.reduce((a, b) =>
        Math.max(a.cooldownUntil, a.disabledUntil) < Math.max(b.cooldownUntil, b.disabledUntil) ? a : b,
      );
      console.warn(`[credential-pool] All keys unavailable, forcing least-blocked key (cooldown until ${new Date(Math.max(soonest.cooldownUntil, soonest.disabledUntil)).toISOString()})`);
      soonest.lastUsed = Date.now();
      soonest.requestCount++;
      return soonest.key;
    }
    return null;
  }

  /** @type {PoolEntry} */
  let selected;
  switch (strat) {
    case 'least-used':
      selected = _selectLeastUsed(available);
      break;
    case 'fill-first':
      selected = _selectFillFirst(available);
      break;
    case 'round-robin':
    default:
      selected = _selectRoundRobin(available);
      break;
  }

  selected.lastUsed = Date.now();
  selected.requestCount++;
  return selected.key;
}

/**
 * Report a successful request for a key. Resets consecutive error counter.
 * @param {string} key
 */
export function reportSuccess(key) {
  const entry = _find(key);
  if (!entry) return;
  entry.consecutiveErrors = 0;
  // If it was on cooldown/disabled but succeeded, clear those states
  entry.cooldownUntil = 0;
  entry.disabledUntil = 0;
}

/**
 * Report an error for a key.
 * - 429 → cooldown for COOLDOWN_MS
 * - 3+ consecutive errors → temporarily disable for DISABLE_MS
 *
 * @param {string} key
 * @param {number|null} [statusCode]
 */
export function reportError(key, statusCode) {
  const entry = _find(key);
  if (!entry) return;

  entry.consecutiveErrors++;
  const masked = key.length > 8 ? key.slice(0, 4) + '...' + key.slice(-4) : '****';

  if (statusCode === 429) {
    entry.cooldownUntil = Date.now() + COOLDOWN_MS;
    console.warn(
      `[credential-pool] Key ${masked} hit 429 rate limit, cooldown until ${new Date(entry.cooldownUntil).toISOString()}`,
    );
  }

  if (entry.consecutiveErrors >= DISABLE_AFTER_CONSECUTIVE) {
    entry.disabledUntil = Date.now() + DISABLE_MS;
    console.warn(
      `[credential-pool] Key ${masked} disabled after ${entry.consecutiveErrors} consecutive errors, until ${new Date(entry.disabledUntil).toISOString()}`,
    );
  }
}

/**
 * Return a health summary of the pool.
 * @returns {{
 *   poolSize: number,
 *   available: number,
 *   cooldown: number,
 *   disabled: number,
 *   strategy: string,
 *   entries: Array<{
 *     index: number,
 *     requestCount: number,
 *     consecutiveErrors: number,
 *     status: 'available'|'cooldown'|'disabled',
 *     cooldownUntil: string|null,
 *     disabledUntil: string|null,
 *   }>
 * }}
 */
export function getStats() {
  const now = Date.now();
  const entries = _entries.map((e, i) => {
    let status = 'available';
    if (now < e.disabledUntil) status = 'disabled';
    else if (now < e.cooldownUntil) status = 'cooldown';
    return {
      index: i,
      requestCount: e.requestCount,
      consecutiveErrors: e.consecutiveErrors,
      status,
      cooldownUntil: e.cooldownUntil > 0 ? new Date(e.cooldownUntil).toISOString() : null,
      disabledUntil: e.disabledUntil > 0 ? new Date(e.disabledUntil).toISOString() : null,
    };
  });

  return {
    poolSize: _entries.length,
    available: _available().length,
    cooldown: entries.filter(e => e.status === 'cooldown').length,
    disabled: entries.filter(e => e.status === 'disabled').length,
    strategy: DEFAULT_STRATEGY,
    entries,
  };
}

/**
 * Number of keys in the pool.
 * @type {number}
 */
export const poolSize = _entries.length;
