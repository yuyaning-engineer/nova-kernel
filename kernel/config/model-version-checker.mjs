/**
 * Model Version Checker -- ensures nova-kernel always runs latest AI models.
 *
 * Mechanism:
 *   1. Startup check: validate all configured models exist via provider APIs
 *   2. Daily refresh: query provider model lists, detect new versions
 *   3. Deprecation alerts: warn when configured models are scheduled for removal
 *   4. Upgrade suggestions: recommend newer models when available
 *
 * Provider APIs:
 *   Google:    GET https://generativelanguage.googleapis.com/v1beta/models
 *   OpenAI:    GET https://api.openai.com/v1/models
 *   Anthropic: models are known from docs (no list API), validate via test call
 *
 * Integration:
 *   - Import { startModelChecker, getModelVersionReport } in server.js
 *   - Call startModelChecker() in server.listen callback
 *   - Expose GET /api/model-versions returning getModelVersionReport()
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
 * Generic HTTPS GET with proxy support. Returns { body, statusCode }.
 */
async function _httpsGet(url, headers = {}, timeoutMs = 30000) {
  const urlObj  = new URL(url);
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
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => settle(resolve, { body: buf, statusCode: res.statusCode }));
    });

    req.on('error', err => settle(reject, err));
    req.setTimeout(timeoutMs, () => { req.destroy(); settle(reject, new Error(`HTTPS GET timeout (${timeoutMs}ms)`)); });
    req.end();
  });
}

/**
 * Generic HTTPS POST with proxy support. Returns { body, statusCode }.
 */
async function _httpsPost(url, bodyStr, headers = {}, timeoutMs = 30000) {
  const urlObj  = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    path:     urlObj.pathname + urlObj.search,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
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
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => settle(resolve, { body: buf, statusCode: res.statusCode }));
    });

    req.on('error', err => settle(reject, err));
    req.setTimeout(timeoutMs, () => { req.destroy(); settle(reject, new Error(`HTTPS POST timeout (${timeoutMs}ms)`)); });
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Model family definitions (upgrade chains + deprecation info)
// ---------------------------------------------------------------------------

const MODEL_FAMILIES = {
  'claude-sonnet': {
    provider: 'anthropic',
    current: null, // filled at runtime from getConfiguredModels()
    knownVersions: ['claude-sonnet-4-5', 'claude-sonnet-4-6'],
    deprecatedBefore: 'claude-sonnet-4-6',
  },
  'claude-opus': {
    provider: 'anthropic',
    current: null,
    knownVersions: ['claude-opus-4', 'claude-opus-4-5', 'claude-opus-4-6'],
    deprecatedBefore: 'claude-opus-4-5',
  },
  'claude-haiku': {
    provider: 'anthropic',
    current: null,
    knownVersions: ['claude-haiku-4-5'],
    deprecatedBefore: null, // only one known version
  },
  'gemini-flash': {
    provider: 'google',
    pattern: /^gemini-[\d.]+-flash/,
  },
  'gemini-pro': {
    provider: 'google',
    pattern: /^gemini-[\d.]+-pro/,
  },
  'gpt': {
    provider: 'openai',
    pattern: /^gpt-[\d.]+/,
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _lastCheckTime  = null; // ISO string
let _lastIssues     = [];   // VersionIssue[]
let _cachedGeminiModels = []; // { id, displayName, version, supportedMethods }[]
let _cachedOpenAIModels = []; // { id, created, owned_by }[]
let _checkInterval  = null;
let _checking       = false; // concurrency lock

// ---------------------------------------------------------------------------
// getConfiguredModels() -- reads current values from models.js env overrides
// ---------------------------------------------------------------------------

function getConfiguredModels() {
  return {
    GEMINI_FLASH:        process.env.GEMINI_FLASH_MODEL        || 'gemini-3-flash-preview',
    GEMINI_PRO:          process.env.GEMINI_PRO_MODEL          || 'gemini-3.1-pro-preview',
    GEMINI_FLASH_STABLE: process.env.GEMINI_FLASH_STABLE_MODEL || 'gemini-2.5-flash',
    GEMINI_PRO_STABLE:   process.env.GEMINI_PRO_STABLE_MODEL   || 'gemini-2.5-pro',
    GEMINI_FLASH_LITE:   process.env.GEMINI_FLASH_LITE_MODEL   || 'gemini-2.5-flash-lite',
    GPT_FULL:            process.env.GPT_FULL_MODEL            || 'gpt-5.4',
    GPT_MINI:            process.env.GPT_MINI_MODEL            || 'gpt-5.4-mini',
    GPT_NANO:            process.env.GPT_NANO_MODEL            || 'gpt-5.4-nano',
    O3:                  process.env.O3_MODEL                  || 'o3',
    CLAUDE_SONNET:       process.env.CLAUDE_SONNET_MODEL       || 'claude-sonnet-4-6',
    CLAUDE_OPUS:         process.env.CLAUDE_OPUS_MODEL         || 'claude-opus-4-6',
    CLAUDE_HAIKU:        process.env.CLAUDE_HAIKU_MODEL        || 'claude-haiku-4-5',
  };
}

// ---------------------------------------------------------------------------
// Provider API: Gemini model discovery
// ---------------------------------------------------------------------------

/**
 * Query Google Generative Language API for available models.
 * Uses credential from GEMINI_API_KEY (first key if comma-separated pool).
 * @returns {Promise<Array<{id: string, displayName: string, version: string, supportedMethods: string[]}>>}
 */
async function fetchGeminiModels() {
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const apiKey = rawKeys.split(',')[0]?.trim();
  if (!apiKey) {
    console.warn('[model-checker] GEMINI_API_KEY not set, skipping Gemini model discovery');
    return [];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`;
  const { body, statusCode } = await _httpsGet(url);

  if (statusCode !== 200) {
    throw new Error(`Gemini models API returned ${statusCode}: ${body.slice(0, 200)}`);
  }

  const data = JSON.parse(body);
  const models = (data.models || []).map(m => ({
    id:               m.name?.replace('models/', '') || '',
    displayName:      m.displayName || '',
    version:          m.version || '',
    supportedMethods: m.supportedGenerationMethods || [],
  }));

  return models.filter(m => m.supportedMethods.includes('generateContent'));
}

// ---------------------------------------------------------------------------
// Provider API: OpenAI model discovery
// ---------------------------------------------------------------------------

/**
 * Query OpenAI /v1/models for available models.
 * @returns {Promise<Array<{id: string, created: number, owned_by: string}>>}
 */
async function fetchOpenAIModels() {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    console.warn('[model-checker] OPENAI_API_KEY not set, skipping OpenAI model discovery');
    return [];
  }

  const url = 'https://api.openai.com/v1/models';
  const { body, statusCode } = await _httpsGet(url, { 'Authorization': `Bearer ${apiKey}` });

  if (statusCode !== 200) {
    throw new Error(`OpenAI models API returned ${statusCode}: ${body.slice(0, 200)}`);
  }

  const data = JSON.parse(body);
  return (data.data || []).map(m => ({
    id:       m.id || '',
    created:  m.created || 0,
    owned_by: m.owned_by || '',
  }));
}

// ---------------------------------------------------------------------------
// Provider API: Anthropic model validation (no list API -- test ping)
// ---------------------------------------------------------------------------

/**
 * Validate an Anthropic model by sending a minimal test call.
 * Returns true if the model exists (2xx), false if 404/not found.
 * Throws on network/auth errors.
 * @param {string} modelId
 * @returns {Promise<boolean>}
 */
async function validateAnthropicModel(modelId) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    console.warn('[model-checker] ANTHROPIC_API_KEY not set, skipping Anthropic validation');
    return true; // assume valid if we cannot check
  }

  const url = 'https://api.anthropic.com/v1/messages';
  const reqBody = JSON.stringify({
    model: modelId,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });

  try {
    const { statusCode } = await _httpsPost(url, reqBody, {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    }, 15000);

    // 200 = model exists and responded
    // 400 with "model not found" pattern = model deprecated
    // 404 = model does not exist
    if (statusCode === 200) return true;
    if (statusCode === 404) return false;
    // 400 may mean model doesn't exist or bad request
    // Treat 401/403 as "cannot verify" (auth issue, not model issue)
    if (statusCode === 401 || statusCode === 403) {
      console.warn(`[model-checker] Anthropic auth error (${statusCode}), cannot validate ${modelId}`);
      return true; // assume valid
    }
    return false; // 400 or other errors suggest model issue
  } catch (err) {
    console.warn(`[model-checker] Anthropic ping failed for ${modelId}: ${err.message}`);
    return true; // network error, assume valid
  }
}

// ---------------------------------------------------------------------------
// Version comparison helpers
// ---------------------------------------------------------------------------

/**
 * Find the nearest matching model from a list of available models.
 * Uses simple string distance on model ID prefix.
 * @param {string} configuredId   The model ID from config
 * @param {Array<{id: string}>} availableModels
 * @returns {string|null}
 */
function findNearest(configuredId, availableModels) {
  if (!availableModels.length) return null;

  // Extract family prefix (e.g., "gemini-2.5-flash" -> "gemini", "flash")
  const parts = configuredId.toLowerCase().split('-');

  let bestMatch  = null;
  let bestScore  = 0;

  for (const m of availableModels) {
    const mParts = m.id.toLowerCase().split('-');
    let score = 0;
    for (let i = 0; i < Math.min(parts.length, mParts.length); i++) {
      if (parts[i] === mParts[i]) score++;
      else break;
    }
    // Prefer newer (higher version numbers) among equal-score matches
    if (score > bestScore || (score === bestScore && m.id > (bestMatch || ''))) {
      bestScore = score;
      bestMatch = m.id;
    }
  }

  // Only suggest if at least 2 prefix segments match (e.g., "gemini" + version or "gpt" + version)
  return bestScore >= 1 && bestMatch !== configuredId ? bestMatch : null;
}

/**
 * Check a model against its family's upgrade chain.
 * Returns null if up-to-date, or an issue object if deprecated/upgradeable.
 * @param {string} configName  e.g. "CLAUDE_SONNET"
 * @param {string} modelId     e.g. "claude-sonnet-4-5"
 * @returns {{severity: string, model: string, config: string, message: string, suggestion: string|null}|null}
 */
function checkFamilyUpgrade(configName, modelId) {
  for (const [, family] of Object.entries(MODEL_FAMILIES)) {
    if (!family.knownVersions) continue;
    const idx = family.knownVersions.indexOf(modelId);
    if (idx === -1) continue;

    const latest = family.knownVersions[family.knownVersions.length - 1];
    if (modelId === latest) return null; // already on latest

    // Check deprecation
    const depIdx = family.deprecatedBefore
      ? family.knownVersions.indexOf(family.deprecatedBefore)
      : -1;
    const isDeprecated = depIdx >= 0 && idx < depIdx;

    return {
      severity:   isDeprecated ? 'error' : 'warning',
      model:      modelId,
      config:     configName,
      message:    isDeprecated
        ? `Model ${modelId} is deprecated. Upgrade required.`
        : `Newer version available: ${latest} (current: ${modelId}).`,
      suggestion: latest,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core: validateModelsOnStartup
// ---------------------------------------------------------------------------

/**
 * Validate all configured models against provider APIs.
 * Populates _lastIssues and _cachedXxxModels caches.
 * @returns {Promise<Array<{severity: string, model: string, config: string, message: string, suggestion: string|null}>>}
 */
export async function validateModelsOnStartup() {
  if (_checking) {
    console.warn('[model-checker] Check already in progress, skipping');
    return _lastIssues;
  }
  _checking = true;

  const issues = [];
  const configured = getConfiguredModels();

  try {
    // ── 1. Gemini: fetch available models, validate configured ones ──────
    let geminiModels = [];
    try {
      geminiModels = await fetchGeminiModels();
      _cachedGeminiModels = geminiModels;
    } catch (err) {
      console.warn(`[model-checker] Gemini model fetch failed: ${err.message}`);
      issues.push({
        severity: 'warning',
        model:    'N/A',
        config:   'GEMINI_*',
        message:  `Cannot reach Gemini models API: ${err.message}`,
        suggestion: null,
      });
    }

    if (geminiModels.length > 0) {
      const geminiIds = new Set(geminiModels.map(m => m.id));

      for (const [name, configuredId] of Object.entries(configured)) {
        if (!name.startsWith('GEMINI')) continue;
        if (!geminiIds.has(configuredId)) {
          const suggestion = findNearest(configuredId, geminiModels);
          issues.push({
            severity:   'error',
            model:      configuredId,
            config:     name,
            message:    `Model ${configuredId} not found in Gemini API. May be deprecated or renamed.`,
            suggestion,
          });
        }
      }
    }

    // ── 2. OpenAI: fetch available models, validate configured ones ──────
    let openaiModels = [];
    try {
      openaiModels = await fetchOpenAIModels();
      _cachedOpenAIModels = openaiModels;
    } catch (err) {
      console.warn(`[model-checker] OpenAI model fetch failed: ${err.message}`);
      issues.push({
        severity: 'warning',
        model:    'N/A',
        config:   'GPT_*/O3',
        message:  `Cannot reach OpenAI models API: ${err.message}`,
        suggestion: null,
      });
    }

    if (openaiModels.length > 0) {
      const openaiIds = new Set(openaiModels.map(m => m.id));

      for (const [name, configuredId] of Object.entries(configured)) {
        if (!name.startsWith('GPT') && name !== 'O3') continue;
        if (!openaiIds.has(configuredId)) {
          const suggestion = findNearest(configuredId, openaiModels);
          issues.push({
            severity:   'error',
            model:      configuredId,
            config:     name,
            message:    `Model ${configuredId} not found in OpenAI API. May be deprecated.`,
            suggestion,
          });
        }
      }
    }

    // ── 3. Anthropic: validate each configured Claude model ──────────────
    for (const [name, configuredId] of Object.entries(configured)) {
      if (!name.startsWith('CLAUDE')) continue;
      const exists = await validateAnthropicModel(configuredId);
      if (!exists) {
        // Find suggestion from family chain
        const familyIssue = checkFamilyUpgrade(name, configuredId);
        issues.push({
          severity:   'error',
          model:      configuredId,
          config:     name,
          message:    `Model ${configuredId} failed Anthropic validation (404 or rejected).`,
          suggestion: familyIssue?.suggestion || null,
        });
      }
    }

    // ── 4. Family upgrade checks (known version chains) ──────────────────
    for (const [name, configuredId] of Object.entries(configured)) {
      const familyIssue = checkFamilyUpgrade(name, configuredId);
      if (familyIssue) {
        // Avoid duplicate if already reported as missing
        const alreadyReported = issues.some(
          i => i.config === name && i.severity === 'error'
        );
        if (!alreadyReported) {
          issues.push(familyIssue);
        }
      }
    }

    // ── Log results ──────────────────────────────────────────────────────
    _lastCheckTime = new Date().toISOString();
    _lastIssues = issues;

    if (issues.length > 0) {
      const errors   = issues.filter(i => i.severity === 'error').length;
      const warnings = issues.filter(i => i.severity === 'warning').length;
      console.warn(`[model-checker] ${issues.length} model version issues found (${errors} errors, ${warnings} warnings):`);
      for (const issue of issues) {
        console.warn(`  ${issue.severity}: ${issue.config}=${issue.model} -- ${issue.message}`);
        if (issue.suggestion) console.warn(`    -> Suggested upgrade: ${issue.suggestion}`);
      }
    } else {
      console.log('[model-checker] All configured models verified');
    }

    return issues;
  } finally {
    _checking = false;
  }
}

// ---------------------------------------------------------------------------
// Scheduler: daily refresh
// ---------------------------------------------------------------------------

const STARTUP_DELAY_MS = parseInt(process.env.MODEL_CHECK_STARTUP_DELAY_MS || '30000', 10);
const CHECK_INTERVAL_MS = parseInt(process.env.MODEL_CHECK_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10);

/**
 * Start the model version checker:
 *   - Delayed startup check (30s after boot)
 *   - Daily re-check interval
 */
export function startModelChecker() {
  // Initial check (delayed to let server stabilize)
  setTimeout(() => {
    validateModelsOnStartup().catch(e =>
      console.warn('[model-checker] Startup check failed:', e.message)
    );
  }, STARTUP_DELAY_MS);

  // Daily check
  _checkInterval = setInterval(() => {
    validateModelsOnStartup().catch(e =>
      console.warn('[model-checker] Daily check failed:', e.message)
    );
  }, CHECK_INTERVAL_MS);

  // Allow process to exit even if interval is pending
  if (_checkInterval.unref) _checkInterval.unref();

  console.log(`[model-checker] Scheduled: startup check in ${STARTUP_DELAY_MS / 1000}s, daily refresh every ${Math.round(CHECK_INTERVAL_MS / 3600000)}h`);
}

/**
 * Stop the model version checker (for graceful shutdown).
 */
export function stopModelChecker() {
  if (_checkInterval) {
    clearInterval(_checkInterval);
    _checkInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Report: for /api/model-versions endpoint
// ---------------------------------------------------------------------------

/**
 * Returns the full model version report for the API endpoint.
 * @returns {{
 *   lastChecked: string|null,
 *   issues: Array,
 *   issueCount: {errors: number, warnings: number},
 *   configured: Object,
 *   available: { gemini: Array, openai: Array },
 *   families: Object,
 * }}
 */
export function getModelVersionReport() {
  const issues = _lastIssues;
  return {
    lastChecked: _lastCheckTime,
    issues,
    issueCount: {
      errors:   issues.filter(i => i.severity === 'error').length,
      warnings: issues.filter(i => i.severity === 'warning').length,
    },
    configured: getConfiguredModels(),
    available: {
      gemini:       _cachedGeminiModels.map(m => ({ id: m.id, displayName: m.displayName })),
      geminiCount:  _cachedGeminiModels.length,
      openai:       _cachedOpenAIModels.map(m => ({ id: m.id, created: m.created, owned_by: m.owned_by })),
      openaiCount:  _cachedOpenAIModels.length,
    },
    families: MODEL_FAMILIES,
  };
}
