/**
 * providers.mjs — SDK-based AI Provider implementations
 *
 * Replaces CLI spawn for Claude/OpenAI with proper SDK calls.
 * Google/Gemini is NOT handled here — it uses the existing _callGemini path
 * in ai-executor.mjs (which already has proxy support, credential pool, retry).
 *
 * SDK clients are lazy-loaded: only initialized on first call to that provider.
 * API keys are read from environment variables by each SDK:
 *   - Anthropic: ANTHROPIC_API_KEY
 *   - OpenAI:    OPENAI_API_KEY
 *
 * Exports:
 *   callProvider(provider, model, prompt, systemContext, options) → ProviderResult
 */

import { classifyError } from './error-classifier.mjs';
import { checkPromptBudget } from './worker-guard.mjs';
import { request as httpRequest } from 'node:http';

// ---------------------------------------------------------------------------
// Lazy-loaded SDK clients — initialized once on first use
// ---------------------------------------------------------------------------

/** @type {import('@anthropic-ai/sdk').default | null} */
let _anthropicClient = null;

/** @type {import('openai').default | null} */
let _openaiClient = null;

/**
 * @returns {Promise<import('@anthropic-ai/sdk').default>}
 */
async function getAnthropicClient() {
  if (!_anthropicClient) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    _anthropicClient = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return _anthropicClient;
}

/**
 * @returns {Promise<import('openai').default>}
 */
async function getOpenAIClient() {
  if (!_openaiClient) {
    const { default: OpenAI } = await import('openai');
    _openaiClient = new OpenAI(); // reads OPENAI_API_KEY from env
  }
  return _openaiClient;
}

// ---------------------------------------------------------------------------
// Provider call implementations
// ---------------------------------------------------------------------------

// Anthropic Prompt Caching 常量
// 最小 cache token 门槛：Sonnet/Opus 1024，Haiku 2048
// 我们用 1024 (Sonnet) 作下限：>= 1024 chars ≈ 400+ tokens 稳过门槛
const ANTHROPIC_CACHE_MIN_CHARS = 1024;
// 1h extended cache 需要 beta header
const ANTHROPIC_CACHE_1H_BETA = 'extended-cache-ttl-2025-04-11';

// 从 system context 里拆出"固定前缀（可缓存）+ 会话专属后缀（不缓存）"
// 约定：Nova 给的 systemContext 格式 = 固定前缀 (MEMORY+USER) + '\n\n---DYNAMIC---\n\n' + 会话专属
// 如果没这个分隔符，则把整个 systemContext 视为可缓存部分（更多 token 节省）
function _splitSystemForCache(systemContext) {
  if (!systemContext) return { stable: null, dynamic: null };
  const SEP = '\n\n---DYNAMIC---\n\n';
  const idx = systemContext.indexOf(SEP);
  if (idx < 0) return { stable: systemContext, dynamic: null };
  return {
    stable: systemContext.slice(0, idx),
    dynamic: systemContext.slice(idx + SEP.length),
  };
}

/**
 * Call Anthropic Claude via SDK (Messages API) with Prompt Caching.
 *
 * System prompt 拆成两段：
 *   [固定前缀 (带 cache_control:ephemeral)] + [动态后缀 (不缓存)]
 * 命中时 token 成本降 90%，延迟降 50-85%。
 *
 * @param {string} model         e.g. 'claude-sonnet-4-5', 'claude-opus-4'
 * @param {string} prompt        User message content
 * @param {string} systemContext  System prompt (optional)
 * @param {object} options
 * @param {string} [options.cacheTtl]  '5m' | '1h'（默认 5m；1h 需设 NOVA_CLAUDE_CACHE_TTL=1h）
 * @returns {Promise<string>}    AI response text
 */
async function _callAnthropic(model, prompt, systemContext, options = {}) {
  const { maxTokens = 4096 } = options;
  const cacheTtl = options.cacheTtl || process.env.NOVA_CLAUDE_CACHE_TTL || '5m';
  const client = await getAnthropicClient();

  const { stable, dynamic } = _splitSystemForCache(systemContext);

  const params = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };

  // 构建 system：数组形式才能标 cache_control
  if (stable && stable.length >= ANTHROPIC_CACHE_MIN_CHARS) {
    const systemBlocks = [
      {
        type: 'text',
        text: stable,
        cache_control: cacheTtl === '1h'
          ? { type: 'ephemeral', ttl: '1h' }
          : { type: 'ephemeral' },
      },
    ];
    if (dynamic) {
      // 动态段不标 cache_control，命中时自动 invalidate 到这段之前
      systemBlocks.push({ type: 'text', text: dynamic });
    }
    params.system = systemBlocks;
  } else if (systemContext) {
    // 太短不值得缓存
    params.system = systemContext;
  }

  // 1h TTL 需要 beta header
  const requestOpts = cacheTtl === '1h'
    ? { headers: { 'anthropic-beta': ANTHROPIC_CACHE_1H_BETA } }
    : undefined;

  const msg = await client.messages.create(params, requestOpts);

  // 记录 cache 效果到日志（不阻塞返回）
  if (msg.usage && (msg.usage.cache_creation_input_tokens || msg.usage.cache_read_input_tokens)) {
    const u = msg.usage;
    const totalIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    const hitRate = totalIn > 0 ? ((u.cache_read_input_tokens || 0) / totalIn * 100).toFixed(1) : '0.0';
    console.log(`[providers][claude] cache: creation=${u.cache_creation_input_tokens || 0} read=${u.cache_read_input_tokens || 0} input=${u.input_tokens || 0} hit_rate=${hitRate}%`);
  }

  const textBlock = msg.content.find(b => b.type === 'text');
  if (!textBlock) {
    throw new Error(`Anthropic response has no text content: ${JSON.stringify(msg.content).slice(0, 200)}`);
  }
  return textBlock.text;
}

/**
 * Call OpenAI via SDK (Chat Completions API).
 * Uses 'developer' role for system context (o-series models use this).
 *
 * @param {string} model         e.g. 'o3', 'gpt-5.4-mini'
 * @param {string} prompt        User message content
 * @param {string} systemContext  System prompt (optional)
 * @param {object} options
 * @returns {Promise<string>}    AI response text
 */
async function _callOpenAI(model, prompt, systemContext, options = {}) {
  const client = await getOpenAIClient();

  const messages = [];
  if (systemContext) {
    // o-series and gpt-5 use 'developer' role; falls back gracefully on older models
    messages.push({ role: 'developer', content: systemContext });
  }
  messages.push({ role: 'user', content: prompt });

  const res = await client.chat.completions.create({
    model,
    messages,
  });

  const content = res.choices?.[0]?.message?.content;
  if (content == null) {
    throw new Error(`OpenAI response has no content: ${JSON.stringify(res.choices).slice(0, 200)}`);
  }
  return content;
}

// ---------------------------------------------------------------------------
// Antigravity Local Bridge (OpenAI-compatible @ localhost:11435)
// ---------------------------------------------------------------------------
// 免费使用 Antigravity 订阅下的模型（Claude Sonnet 4.6、Opus 4.6、Gemini 3.x、GPT-OSS 120B）
// 由 VSCode 扩展 marcodiniz.ag-local-bridge 托管；端口可通过 NOVA_ANTIGRAVITY_BRIDGE 覆盖

const ANTIGRAVITY_BRIDGE_URL = process.env.NOVA_ANTIGRAVITY_BRIDGE || 'http://127.0.0.1:11435';
const OLLAMA_BASE_URL = process.env.NOVA_OLLAMA_URL || 'http://127.0.0.1:11434';

/**
 * Call Antigravity via ag-local-bridge (OpenAI-compatible chat completions).
 *
 * @param {string} model           e.g. 'antigravity-claude-sonnet-4-6' / 'antigravity-gemini-3.1-pro-high'
 * @param {string} prompt          User message content
 * @param {string} systemContext   System prompt (optional, 自动拆 stable/dynamic 段)
 * @param {object} options
 * @returns {Promise<string>}
 */
async function _callAntigravity(model, prompt, systemContext, options = {}) {
  const { maxTokens = 4096, timeoutMs = 120_000, _retry = 0 } = options;

  // 【2026-04-18 修复】ag-local-bridge 会把 system role 转成 "[System]\n..." 文本
  // 塞进对话（见其 src/sidecar/raw.js），导致底层 Antigravity Cascade 模型
  // 不把它当作真正的 system prompt —— 实测 Claude 会说"没有 system prompt"。
  //
  // 解决：双重保险
  //   (a) 保留 system role 传给 ag-bridge（它内部该怎么转就怎么转）
  //   (b) 同时在 user message 顶部用强约束语言包装记忆，确保模型认真对待
  const messages = [];
  if (systemContext) {
    const { stable, dynamic } = _splitSystemForCache(systemContext);
    const sys = dynamic ? `${stable}\n\n${dynamic}` : stable;
    if (sys) messages.push({ role: 'system', content: sys });
  }

  // (b) 把 systemContext 作为 user message 的强约束前缀
  let userContent = prompt;
  if (systemContext && systemContext.length > 100) {
    userContent = [
      '【Nova Kernel 注入 — 你必须在回答前先理解以下上下文】',
      '',
      systemContext,
      '',
      '【Nova Kernel 注入结束】',
      '',
      '用户请求：',
      prompt,
    ].join('\n');
  }
  messages.push({ role: 'user', content: userContent });

  const body = JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const url = new URL('/v1/chat/completions', ANTIGRAVITY_BRIDGE_URL);
    const req = httpRequest({
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          // 429 限流：自动重试一次（最多 2 次，避免死循环）
          // 但若 body 明显是 "model not found" 类型，直接报错不重试
          const isModelNotFound = /model not found|unknown model|unavailable|not subscribed/i.test(raw);
          if (res.statusCode === 429 && !isModelNotFound && _retry < 2) {
            const waitMs = 1500 + _retry * 1000; // 1.5s / 2.5s
            console.warn(`[providers][antigravity] 429 rate limit, retry in ${waitMs}ms (attempt ${_retry + 1}/2)`);
            await new Promise(r => setTimeout(r, waitMs));
            try {
              const out = await _callAntigravity(model, prompt, systemContext, { ...options, _retry: _retry + 1 });
              return resolve(out);
            } catch (retryErr) { return reject(retryErr); }
          }
          if (isModelNotFound) {
            return reject(new Error(`Antigravity 订阅不包含模型 "${model}": ${raw.slice(0, 300)}`));
          }
          return reject(new Error(`Antigravity bridge HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
        }
        try {
          const parsed = JSON.parse(raw);
          const content = parsed?.choices?.[0]?.message?.content;
          if (!content) return reject(new Error(`Antigravity bridge: empty content`));
          resolve(content);
        } catch (e) {
          reject(new Error(`Antigravity bridge JSON parse failed: ${e.message}`));
        }
      });
    });
    req.on('error', err => {
      // 区分 "bridge 未启动" vs 其他
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`Antigravity bridge 未启动或不可达 (${ANTIGRAVITY_BRIDGE_URL}). 请确认 Antigravity IDE 正在运行，且已安装 ag-local-bridge 扩展。`));
      } else reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Antigravity bridge 超时 (${timeoutMs}ms)`));
    });
    req.write(body);
    req.end();
  });
}

/**
 * 探测 ag-local-bridge 是否可用（给 health check / model-router 用）
 */
export async function probeAntigravityBridge(timeoutMs = 2000) {
  return new Promise(resolve => {
    const url = new URL('/v1/models', ANTIGRAVITY_BRIDGE_URL);
    const req = httpRequest({
      hostname: url.hostname, port: url.port || 80,
      path: url.pathname, method: 'GET', timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ ok: res.statusCode === 200, models: parsed?.data?.map(m => m.id) || [] });
        } catch { resolve({ ok: false, models: [] }); }
      });
    });
    req.on('error', () => resolve({ ok: false, models: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, models: [] }); });
    req.end();
  });
}

/**
 * Call Ollama via its OpenAI-compatible chat completions endpoint.
 *
 * @param {string} model           e.g. 'ollama-qwen2.5:7b'
 * @param {string} prompt          User message content
 * @param {string} systemContext   System prompt (optional)
 * @param {object} options
 * @returns {Promise<string>}
 */
async function _callOllama(model, prompt, systemContext, options = {}) {
  const { maxTokens = 4096, timeoutMs = 120_000, _retry = 0 } = options;

  const messages = [];
  if (systemContext) {
    const { stable, dynamic } = _splitSystemForCache(systemContext);
    const sys = dynamic ? `${stable}\n\n${dynamic}` : stable;
    if (sys) messages.push({ role: 'system', content: sys });
  }

  let userContent = prompt;
  if (systemContext && systemContext.length > 100) {
    userContent = [
      'Nova Kernel injected context. Read it before answering.',
      '',
      systemContext,
      '',
      'End injected context.',
      '',
      'User request:',
      prompt,
    ].join('\n');
  }
  messages.push({ role: 'user', content: userContent });

  const resolvedModel = model.startsWith('ollama-') ? model.slice('ollama-'.length) : model;
  const body = JSON.stringify({
    model: resolvedModel,
    messages,
    max_tokens: maxTokens,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const url = new URL('/v1/chat/completions', OLLAMA_BASE_URL);
    const req = httpRequest({
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          const isModelNotFound = /model not found|unknown model|unavailable|not found/i.test(raw);
          if (res.statusCode === 429 && !isModelNotFound && _retry < 2) {
            const waitMs = 1500 + _retry * 1000;
            console.warn(`[providers][ollama] 429 rate limit, retry in ${waitMs}ms (attempt ${_retry + 1}/2)`);
            await new Promise(r => setTimeout(r, waitMs));
            try {
              const out = await _callOllama(model, prompt, systemContext, { ...options, _retry: _retry + 1 });
              return resolve(out);
            } catch (retryErr) { return reject(retryErr); }
          }
          if (isModelNotFound) {
            return reject(new Error(`Ollama model "${resolvedModel}" not available: ${raw.slice(0, 300)}`));
          }
          return reject(new Error(`Ollama HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
        }
        try {
          const parsed = JSON.parse(raw);
          const content = parsed?.choices?.[0]?.message?.content;
          if (!content) return reject(new Error('Ollama: empty content'));
          resolve(content);
        } catch (e) {
          reject(new Error(`Ollama JSON parse failed: ${e.message}`));
        }
      });
    });
    req.on('error', err => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error(`Ollama not reachable (${OLLAMA_BASE_URL}). Confirm the local server is running.`));
      } else reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Ollama timeout (${timeoutMs}ms)`));
    });
    req.write(body);
    req.end();
  });
}

export async function probeOllama(timeoutMs = 2000) {
  return new Promise(resolve => {
    const url = new URL('/api/tags', OLLAMA_BASE_URL);
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'GET',
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ ok: res.statusCode === 200, models: parsed?.models?.map(m => m.name) || [] });
        } catch { resolve({ ok: false, models: [] }); }
      });
    });
    req.on('error', () => resolve({ ok: false, models: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, models: [] }); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main dispatch function
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ProviderResult
 * @property {boolean} ok          Whether the call succeeded
 * @property {string}  [output]    AI response text (on success)
 * @property {string}  model       Model used
 * @property {string}  provider    Provider used ('anthropic' | 'openai')
 * @property {number}  time_ms     Wall-clock time for the call
 * @property {string}  [error]     Error message (on failure)
 * @property {string}  [errorCategory]  Classified error category
 * @property {boolean} [retryable]      Whether the error is retryable
 */

/**
 * Call an AI provider via SDK.
 *
 * NOTE: Does NOT handle provider='google' — that uses the existing _callGemini
 * path in ai-executor.mjs with full proxy/credential-pool/retry support.
 *
 * @param {string} provider       'anthropic' | 'openai'
 * @param {string} model          Model identifier
 * @param {string} prompt         Full prompt (with context already prepended)
 * @param {string} systemContext   System-level context (MEMORY.md + USER.md)
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000]  Timeout in ms
 * @param {number} [options.maxTokens=4096]    Max output tokens
 * @returns {Promise<ProviderResult>}
 */
export async function callProvider(provider, model, prompt, systemContext, options = {}) {
  const { timeoutMs = 120000, maxTokens = 4096 } = options;
  const startTime = Date.now();

  // Prompt budget 检查（Opus 建议的"隐性降质"防护）
  checkPromptBudget(systemContext, prompt, `${provider}/${model}`);

  // Timeout race
  let _timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    _timeoutId = setTimeout(
      () => reject(new Error(`Provider timeout (${timeoutMs}ms) — ${provider}/${model}`)),
      timeoutMs,
    );
  });

  try {
    let apiCall;

    switch (provider) {
      case 'anthropic':
        apiCall = _callAnthropic(model, prompt, systemContext, { maxTokens });
        break;

      case 'openai':
        apiCall = _callOpenAI(model, prompt, systemContext, { maxTokens });
        break;

      case 'antigravity':
        // 走本机 ag-local-bridge :11435，model 形如 'antigravity-claude-sonnet-4-6'
        apiCall = _callAntigravity(model, prompt, systemContext, { maxTokens, timeoutMs });
        break;

      case 'ollama':
        apiCall = _callOllama(model, prompt, systemContext, { maxTokens, timeoutMs });
        break;

      default:
        throw new Error(`Unknown provider: ${provider} (use 'anthropic' | 'openai' | 'antigravity' | 'ollama'; google uses _callGemini path)`);
    }

    const output = await Promise.race([apiCall, timeoutPromise]);

    return {
      ok: true,
      output,
      model,
      provider,
      time_ms: Date.now() - startTime,
    };

  } catch (err) {
    const classified = classifyError(err, null, null);
    return {
      ok: false,
      error: err.message,
      model,
      provider,
      time_ms: Date.now() - startTime,
      errorCategory: classified.category,
      retryable: classified.retryable,
    };

  } finally {
    clearTimeout(_timeoutId);
  }
}

/**
 * Reset cached SDK clients (for testing or credential rotation).
 */
export function resetClients() {
  _anthropicClient = null;
  _openaiClient = null;
}
