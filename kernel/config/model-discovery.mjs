/**
 * Model Auto-Discovery -- queries provider APIs to always use the latest models.
 * kernel/config/model-discovery.mjs
 *
 * On startup (5s delay) and at a configurable interval (default: daily):
 *   1. Query Gemini API -> find latest flash/pro models
 *   2. Query OpenAI API -> find latest gpt models
 *   3. Anthropic -> env-overridable (no list API), known naming scheme
 *   4. Store discovered models in live registry
 *   5. All model lookups go through getLatestModel() -> live registry -> static fallback
 *
 * Fallback: if API query fails, static defaults from models.js are used.
 *
 * Environment variables:
 *   MODEL_DISCOVERY_INTERVAL_MS  -- refresh interval (default: 86400000 = 24h)
 *   MODEL_DISCOVERY_STARTUP_MS   -- delay before first discovery (default: 5000)
 *   CLAUDE_SONNET_MODEL          -- override Anthropic sonnet model ID
 *   CLAUDE_OPUS_MODEL            -- override Anthropic opus model ID
 *   CLAUDE_HAIKU_MODEL           -- override Anthropic haiku model ID
 */

import { request as httpsRequest } from 'https';
import { request as httpRequest }  from 'http';

// ---------------------------------------------------------------------------
// Proxy infrastructure (mirrors ai-executor.mjs pattern)
// ---------------------------------------------------------------------------

const _PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || '';

function _connectViaProxy(targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(_PROXY_URL);
    const req = httpRequest({
      hostname: proxy.hostname,
      port:     proxy.port,
      method:   'CONNECT',
      path:     `${targetHost}:${targetPort}`,
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Proxy CONNECT timeout')); });
    req.on('error', reject);
    req.on('connect', (_res, socket) => {
      if (_res.statusCode === 200) { resolve(socket); }
      else { reject(new Error(`Proxy CONNECT failed: ${_res.statusCode}`)); }
    });
    req.end();
  });
}

/**
 * Proxy-aware HTTPS GET. Returns raw response body string.
 */
async function _httpsGet(url, headers = {}, timeoutMs = 15000) {
  const urlObj = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    path:     urlObj.pathname + urlObj.search,
    method:   'GET',
    headers,
  };

  if (_PROXY_URL) {
    const socket = await _connectViaProxy(urlObj.hostname, 443, timeoutMs);
    options.socket = socket;
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn, val) => { if (!done) { done = true; fn(val); } };

    const req = httpsRequest(options, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => settle(resolve, buf));
    });
    req.on('error', err => settle(reject, err));
    req.setTimeout(timeoutMs, () => { req.destroy(); settle(reject, new Error(`HTTPS GET timeout (${timeoutMs}ms)`)); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Live Registry -- populated by discovery, overrides static models.js
// ---------------------------------------------------------------------------

const _liveRegistry = {
  // Gemini
  gemini_flash:        null,
  gemini_pro:          null,
  gemini_flash_stable: null,
  gemini_pro_stable:   null,
  gemini_flash_lite:   null,
  // OpenAI
  openai_full:         null,
  openai_mini:         null,
  openai_nano:         null,
  // Claude (Anthropic)
  claude_sonnet:       null,
  claude_opus:         null,
  claude_haiku:        null,
  // Derived / aliased roles
  gemini_voter:        null,
  codex_voter:         null,
  codex_mini:          null,
  codex_full:          null,
  o3:                  null,
  o4_mini:             null,
  // Meta
  _lastDiscovery:      null,
  _discoveryErrors:    [],
  _rawGeminiModels:    [],
  _rawOpenAIModels:    [],
};

// ---------------------------------------------------------------------------
// Static fallbacks -- used before first discovery completes or on failure
// ---------------------------------------------------------------------------

const _STATIC_FALLBACKS = {
  gemini_flash:        process.env.GEMINI_FLASH_MODEL        || 'gemini-3-flash-preview',
  gemini_pro:          process.env.GEMINI_PRO_MODEL          || 'gemini-3.1-pro-preview',
  gemini_flash_stable: process.env.GEMINI_FLASH_STABLE_MODEL || 'gemini-2.5-flash',
  gemini_pro_stable:   process.env.GEMINI_PRO_STABLE_MODEL   || 'gemini-2.5-pro',
  gemini_flash_lite:   process.env.GEMINI_FLASH_LITE_MODEL   || 'gemini-2.5-flash-lite',
  openai_full:         process.env.GPT_FULL_MODEL            || 'gpt-5.4',
  openai_mini:         process.env.GPT_MINI_MODEL            || 'gpt-5.4-mini',
  openai_nano:         process.env.GPT_NANO_MODEL            || 'gpt-5.4-nano',
  claude_sonnet:       process.env.CLAUDE_SONNET_MODEL       || 'claude-sonnet-4-6',
  claude_opus:         process.env.CLAUDE_OPUS_MODEL         || 'claude-opus-4-6',
  claude_haiku:        process.env.CLAUDE_HAIKU_MODEL        || 'claude-haiku-4-5',
  gemini_voter:        process.env.GEMINI_VOTER_MODEL        || null, // resolved from gemini_pro
  codex_voter:         process.env.CODEX_VOTER_MODEL         || null, // resolved from openai_mini
  codex_mini:          process.env.CODEX_MINI_MODEL          || null,
  codex_full:          process.env.CODEX_FULL_MODEL          || null,
  o3:                  process.env.O3_MODEL                  || 'o3',
  o4_mini:             process.env.O4_MINI_MODEL             || null, // maps to openai_mini
};

// ---------------------------------------------------------------------------
// Gemini Discovery
// ---------------------------------------------------------------------------

/**
 * Query Google Generative Language API for available models.
 * Filters to models that support generateContent.
 * Selects the latest flash/pro in each tier (preview > stable).
 */
async function _discoverGeminiModels() {
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const apiKey = rawKeys.split(',')[0]?.trim();
  if (!apiKey) return;

  try {
    const raw = await _httpsGet(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
    );
    const data = JSON.parse(raw);
    const models = (data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => ({
        id: m.name?.replace('models/', '') || '',
        displayName: m.displayName || '',
        version: m.version || '',
      }));

    _liveRegistry._rawGeminiModels = models;

    // Classify into families
    const flashModels = models.map(m => m.id).filter(id => /flash/.test(id) && !/lite|tts|image/.test(id));
    const proModels   = models.map(m => m.id).filter(id => /pro/.test(id) && !/tts|image|customtools|deep-research|computer-use/.test(id));
    const liteModels  = models.map(m => m.id).filter(id => /flash-lite/.test(id));

    // Sort: prefer "*-latest" aliases (Google's official latest pointers, more stable)
    // > version-numbered preview > version-numbered stable
    const sortByVersion = (a, b) => {
      const aLatest = /-latest$/.test(a) ? 1 : 0;
      const bLatest = /-latest$/.test(b) ? 1 : 0;
      if (aLatest !== bLatest) return bLatest - aLatest;
      const va = parseFloat(a.match(/[\d.]+/)?.[0] || '0');
      const vb = parseFloat(b.match(/[\d.]+/)?.[0] || '0');
      if (vb !== va) return vb - va;
      // Among same version, preview > non-preview (for "latest" slot)
      const aPreview = a.includes('preview') ? 1 : 0;
      const bPreview = b.includes('preview') ? 1 : 0;
      return bPreview - aPreview;
    };

    flashModels.sort(sortByVersion);
    proModels.sort(sortByVersion);
    liteModels.sort(sortByVersion);

    // Latest flash: highest version (preview preferred)
    if (flashModels.length > 0) {
      _liveRegistry.gemini_flash = flashModels[0];
    }
    // Stable flash: highest version, non-preview
    const stableFlash = flashModels.find(m => !m.includes('preview'));
    if (stableFlash) _liveRegistry.gemini_flash_stable = stableFlash;

    // Latest pro
    if (proModels.length > 0) {
      _liveRegistry.gemini_pro = proModels[0];
    }
    // Stable pro
    const stablePro = proModels.find(m => !m.includes('preview'));
    if (stablePro) _liveRegistry.gemini_pro_stable = stablePro;

    // Lite
    if (liteModels.length > 0) {
      _liveRegistry.gemini_flash_lite = liteModels[0];
    }

    // Derived: gemini_voter = pro
    _liveRegistry.gemini_voter = _liveRegistry.gemini_pro;

    console.log(`[model-discovery] Gemini: flash=${_liveRegistry.gemini_flash}, pro=${_liveRegistry.gemini_pro}, stable_flash=${_liveRegistry.gemini_flash_stable}, stable_pro=${_liveRegistry.gemini_pro_stable}`);
  } catch (e) {
    _liveRegistry._discoveryErrors.push({ provider: 'google', error: e.message, time: new Date().toISOString() });
    console.warn(`[model-discovery] Gemini discovery failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// OpenAI Discovery
// ---------------------------------------------------------------------------

/**
 * Query OpenAI /v1/models for available GPT models.
 * Selects latest full/mini/nano variants.
 */
async function _discoverOpenAIModels() {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return;

  try {
    const raw = await _httpsGet(
      'https://api.openai.com/v1/models',
      { 'Authorization': `Bearer ${apiKey}` }
    );
    const data = JSON.parse(raw);
    const allModels = (data.data || []).map(m => m.id);
    _liveRegistry._rawOpenAIModels = allModels;

    // GPT family: gpt-X.Y, gpt-X.Y-mini, gpt-X.Y-nano
    const gptModels = allModels.filter(m => /^gpt-\d/.test(m));

    // Sort by version descending (higher = newer)
    const sortGpt = (a, b) => {
      const va = parseFloat(a.match(/gpt-([\d.]+)/)?.[1] || '0');
      const vb = parseFloat(b.match(/gpt-([\d.]+)/)?.[1] || '0');
      return vb - va;
    };
    gptModels.sort(sortGpt);

    const gptFull = gptModels.find(m => !m.includes('mini') && !m.includes('nano'));
    const gptMini = gptModels.find(m => m.includes('mini'));
    const gptNano = gptModels.find(m => m.includes('nano'));

    if (gptFull) _liveRegistry.openai_full = gptFull;
    if (gptMini) _liveRegistry.openai_mini = gptMini;
    if (gptNano) _liveRegistry.openai_nano = gptNano;

    // Derived roles
    _liveRegistry.codex_voter = _liveRegistry.openai_mini;
    _liveRegistry.codex_mini  = _liveRegistry.openai_mini;
    _liveRegistry.codex_full  = _liveRegistry.openai_full;
    _liveRegistry.o4_mini     = _liveRegistry.openai_mini; // o4-mini retired, maps to gpt mini

    console.log(`[model-discovery] OpenAI: full=${_liveRegistry.openai_full}, mini=${_liveRegistry.openai_mini}, nano=${_liveRegistry.openai_nano}`);
  } catch (e) {
    _liveRegistry._discoveryErrors.push({ provider: 'openai', error: e.message, time: new Date().toISOString() });
    console.warn(`[model-discovery] OpenAI discovery failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Anthropic Discovery (no list API -- env override or known naming scheme)
// ---------------------------------------------------------------------------

function _discoverAnthropicModels() {
  // Claude CLI 支持别名: 'sonnet' / 'opus' / 'haiku' → 自动解析为最新版本
  // 这样 Anthropic 发布新版本后，CLI 自动使用最新的，无需改任何配置
  // env var 覆盖仍然支持（如需锁定到特定版本号如 'claude-sonnet-4-6'）
  _liveRegistry.claude_sonnet = process.env.CLAUDE_SONNET_MODEL || 'sonnet';
  _liveRegistry.claude_opus   = process.env.CLAUDE_OPUS_MODEL   || 'opus';
  _liveRegistry.claude_haiku  = process.env.CLAUDE_HAIKU_MODEL  || 'haiku';
  console.log(`[model-discovery] Anthropic: sonnet=${_liveRegistry.claude_sonnet}, opus=${_liveRegistry.claude_opus}, haiku=${_liveRegistry.claude_haiku}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the latest discovered model for a given role.
 * Falls back to static defaults (env vars / hardcoded) if discovery hasn't
 * populated the role yet.
 *
 * @param {string} role  One of the registry keys: gemini_flash, gemini_pro,
 *                       gemini_flash_stable, gemini_pro_stable, gemini_flash_lite,
 *                       openai_full, openai_mini, openai_nano,
 *                       claude_sonnet, claude_opus, claude_haiku,
 *                       gemini_voter, codex_voter, codex_mini, codex_full,
 *                       o3, o4_mini
 * @returns {string}     Resolved model ID string
 */
export function getLatestModel(role) {
  // 1. Live registry (populated by discovery)
  const live = _liveRegistry[role];
  if (live) return live;

  // 2. Static fallback (env vars + hardcoded defaults)
  const fallback = _STATIC_FALLBACKS[role];
  if (fallback) return fallback;

  // 3. Resolve derived roles from their base
  switch (role) {
    case 'gemini_voter': return getLatestModel('gemini_pro');
    case 'codex_voter':  return getLatestModel('openai_mini');
    case 'codex_mini':   return getLatestModel('openai_mini');
    case 'codex_full':   return getLatestModel('openai_full');
    case 'o4_mini':      return getLatestModel('openai_mini');
    default:             return 'gemini-2.5-flash'; // absolute last resort
  }
}

/**
 * Run full discovery across all providers.
 * Safe to call concurrently -- providers run in parallel, errors are caught.
 * @returns {object} Discovery report
 */
export async function runDiscovery() {
  _liveRegistry._discoveryErrors = [];

  await Promise.allSettled([
    _discoverGeminiModels(),
    _discoverOpenAIModels(),
  ]);
  _discoverAnthropicModels();

  _liveRegistry._lastDiscovery = new Date().toISOString();

  return getDiscoveryReport();
}

/**
 * Get full discovery report (for dashboard / API endpoint).
 */
export function getDiscoveryReport() {
  return {
    lastDiscovery: _liveRegistry._lastDiscovery,
    errors: [..._liveRegistry._discoveryErrors],
    models: {
      gemini_flash:        _liveRegistry.gemini_flash        || _STATIC_FALLBACKS.gemini_flash,
      gemini_pro:          _liveRegistry.gemini_pro          || _STATIC_FALLBACKS.gemini_pro,
      gemini_flash_stable: _liveRegistry.gemini_flash_stable || _STATIC_FALLBACKS.gemini_flash_stable,
      gemini_pro_stable:   _liveRegistry.gemini_pro_stable   || _STATIC_FALLBACKS.gemini_pro_stable,
      gemini_flash_lite:   _liveRegistry.gemini_flash_lite   || _STATIC_FALLBACKS.gemini_flash_lite,
      claude_sonnet:       _liveRegistry.claude_sonnet       || _STATIC_FALLBACKS.claude_sonnet,
      claude_opus:         _liveRegistry.claude_opus         || _STATIC_FALLBACKS.claude_opus,
      claude_haiku:        _liveRegistry.claude_haiku        || _STATIC_FALLBACKS.claude_haiku,
      openai_full:         _liveRegistry.openai_full         || _STATIC_FALLBACKS.openai_full,
      openai_mini:         _liveRegistry.openai_mini         || _STATIC_FALLBACKS.openai_mini,
      openai_nano:         _liveRegistry.openai_nano         || _STATIC_FALLBACKS.openai_nano,
    },
    discoveredGeminiCount: _liveRegistry._rawGeminiModels.length,
    discoveredOpenAICount: _liveRegistry._rawOpenAIModels.length,
    source: _liveRegistry._lastDiscovery ? 'live' : 'static_fallback',
  };
}

// ---------------------------------------------------------------------------
// Lifecycle -- startup and periodic refresh
// ---------------------------------------------------------------------------

let _refreshInterval = null;

const STARTUP_DELAY_MS = parseInt(process.env.MODEL_DISCOVERY_STARTUP_MS || '5000', 10);
const REFRESH_MS       = parseInt(process.env.MODEL_DISCOVERY_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);

/**
 * Start model auto-discovery:
 *   - Initial discovery after STARTUP_DELAY_MS (default: 5s)
 *   - Periodic refresh every REFRESH_MS (default: 24h)
 */
export function startModelDiscovery() {
  // Initial discovery (delayed to let server stabilize)
  setTimeout(() => {
    runDiscovery().catch(e => console.warn('[model-discovery] Initial run failed:', e.message));
  }, STARTUP_DELAY_MS);

  // Periodic refresh
  _refreshInterval = setInterval(() => {
    runDiscovery().catch(e => console.warn('[model-discovery] Refresh failed:', e.message));
  }, REFRESH_MS);

  // Allow process to exit even if interval is pending
  if (_refreshInterval.unref) _refreshInterval.unref();

  console.log(`[model-discovery] Auto-discovery started (initial in ${STARTUP_DELAY_MS / 1000}s, refresh every ${Math.round(REFRESH_MS / 3600000)}h)`);
}

/**
 * Stop model auto-discovery (for graceful shutdown / tests).
 */
export function stopModelDiscovery() {
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
    _refreshInterval = null;
  }
}
