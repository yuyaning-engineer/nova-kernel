/**
 * ai-executor.mjs
 * 鏍规嵁 task-type router 閫夋嫨鏈€浼?AI 妯″瀷/provider锛岃皟鐢ㄥ搴?SDK 鎴?CLI 鎵ц prompt銆? *
 * 鎵ц璺緞:
 *   1. Task-Type Router (primary) 鈥?inferTaskType 鈫?ROUTING_TABLE 鈫?provider dispatch
 *      - provider='google'    鈫?鍐呯疆 _callGemini (HTTPS, credential pool, proxy, retry)
 *      - provider='anthropic' 鈫?providers.mjs SDK (Anthropic Messages API)
 *      - provider='openai'    鈫?providers.mjs SDK (OpenAI Chat Completions)
 *
 *   2. Legacy worker-based routing (backward compat, when task_type not inferrable)
 *      - worker='gemini' 鈫?_callGemini
 *      - worker='codex'  鈫?_callCodexCLI (spawn, fallback only)
 *      - worker='claude' 鈫?_callClaudeCLI (spawn, fallback only)
 *
 * 鎵€鏈夊嚟鎹粠鐜鍙橀噺璇诲彇:
 *   Gemini:    GEMINI_API_KEY(S)
 *   Anthropic: ANTHROPIC_API_KEY (SDK auto-reads)
 *   OpenAI:    OPENAI_API_KEY   (SDK auto-reads)
 *   Codex/Claude CLI: 鍚勮嚜 CLI 鍐呴儴閴存潈
 */

import { readFileSync, writeFileSync, statSync } from 'fs';
import { join }               from 'path';
import { spawn }              from 'child_process';
import { request as httpsRequest } from 'https';
import { request as httpRequest }  from 'http';
import { classifyError, computeBackoff } from './error-classifier.mjs';
import { getKey, reportSuccess, reportError, poolSize } from './credential-pool.mjs';
import { selectModel, recordCall, recordError as routerRecordError, estimateTokens, markUnavailable } from './model-router.mjs';
import { geminiBreaker, codexBreaker, claudeBreaker, anthropicSDKBreaker, openaiSDKBreaker, antigravityBreaker, ollamaBreaker } from '../utils/circuit-breaker.mjs';
import { inferTaskType, ROUTING_TABLE, getRoute } from './task-router.mjs';
import { wrapWithGuard, scanContamination, isWorkerMode } from './worker-guard.mjs';
import { callProvider } from './providers.mjs';
import { isProviderAvailable, getHealthyRoute } from './worker-health.mjs';
import { getNextInChain, recordFallback } from './fallback-chain.mjs';

// ---------------------------------------------------------------------------
// 鍑嵁 & 鐜
// ---------------------------------------------------------------------------
const KERNEL_ROOT    = process.env.NOVA_KERNEL_ROOT || 'D:/nova-kernel';

const CODEX_BIN  = process.env.CODEX_BIN  || 'codex';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// ---------------------------------------------------------------------------
// 涓婁笅鏂囨敞鍏ワ細璇诲彇 MEMORY.md 鍜?USER.md 浣滀负 system context
// ---------------------------------------------------------------------------

// 绯荤粺涓婁笅鏂囩紦瀛橈細鍩轰簬鏂囦欢 mtime 鐨勪簨浠跺紡澶辨晥
let _ctxCache = null;
let _ctxMtime = 0;         // MEMORY.md + USER.md 鐨?max(mtime)
let _ctxCheckAt = 0;
const CTX_STAT_MIN_MS = 500;
const CTX_MAX_CHARS   = 40_000;

function _loadSystemContext() {
  const now = Date.now();
  const memoryPath = join(KERNEL_ROOT, 'kernel/memory/MEMORY.md');
  const userPath   = join(KERNEL_ROOT, 'kernel/memory/USER.md');

  if (_ctxCache !== null && (now - _ctxCheckAt) < CTX_STAT_MIN_MS) {
    return _ctxCache;
  }

  // 鏌ユ枃浠?mtime锛屾湭鍙樺垯澶嶇敤缂撳瓨
  let maxMtime = 0;
  for (const p of [memoryPath, userPath]) {
    try {
      const st = statSync(p);
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    } catch {}
  }
  _ctxCheckAt = now;
  if (_ctxCache !== null && maxMtime === _ctxMtime) {
    return _ctxCache;
  }

  const parts = [];
  for (const [label, p] of [['=== SYSTEM MEMORY ===', memoryPath], ['=== USER MODEL ===', userPath]]) {
    try {
      const content = readFileSync(p, 'utf8');
      parts.push(label + '\n' + content);
    } catch (err) {
      console.warn(`[ai-executor] 绯荤粺涓婁笅鏂囪鍙栧け璐? ${p} 鈥?${err.message}`);
    }
  }

  let result = parts.join('\n\n');
  if (result.length > CTX_MAX_CHARS) {
    result = result.slice(0, CTX_MAX_CHARS) + '\n[...涓婁笅鏂囧凡鎴柇锛岃秴鍑?40000 瀛楃闄愬埗...]';
    console.warn(`[ai-executor] 绯荤粺涓婁笅鏂囪秴鍑?${CTX_MAX_CHARS} 瀛楃闄愬埗锛屽凡鎴柇`);
  }

  _ctxCache = result;
  _ctxMtime = maxMtime;
  return result;
}

/**
 * Build the user message with task context prepended.
 *
 * 銆?026-04-18 淇銆戞鍓嶆鍑芥暟涔熸妸 systemContext 鎷艰繘 user message锛? * 鍚屾椂 callProvider 鍙堟妸 systemContext 浣滀负鐙珛 system 鍙傛暟浼犱竴娆★紝
 * 瀵艰嚧璁板繂琚?*閲嶅娉ㄥ叆涓ゅ€?*锛坱oken 娴垂 + 鍙兘瑙﹀彂闀垮害闄愬埗锛夈€? *
 * 鐜板湪鑱岃矗娓呮櫚锛? *   - systemContext 鐢卞悇 provider 鑷繁澶勭悊锛圓nthropic/OpenAI SDK: system param锛? *     Gemini: system_instruction锛汚ntigravity: user 娑堟伅椤堕儴寮虹害鏉燂級
 *   - 鏈嚱鏁板彧璐熻矗锛歵ask-specific context + 鍘?prompt 鐨勬嫾鎺? */
function _buildFullPrompt(prompt, context) {
  if (context && Object.keys(context).length > 0) {
    return `=== TASK CONTEXT ===\n${JSON.stringify(context, null, 2)}\n\n${prompt}`;
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Gemini API 璋冪敤锛圢ode.js native HTTPS 鈥?F-001/F-002 淇锛?// 涓嶄娇鐢?curl锛氶伩鍏?API Key 娉勬紡鍒拌繘绋嬪垪琛ㄣ€侀伩鍏嶅懡浠よ闀垮害闄愬埗
// ---------------------------------------------------------------------------

/**
 * Node.js native HTTPS POST锛屼笉渚濊禆绗笁鏂瑰簱鍜屽閮ㄥ懡浠ゃ€? * API Key 閫氳繃 header 浼犺緭锛屼笉鏆撮湶鍦ㄥ懡浠よ鍙傛暟涓€? * Body 閫氳繃娴佸紡鍐欏叆锛屾棤 OS 鍛戒护琛岄暱搴﹂檺鍒躲€? *
 * @param {string} url
 * @param {string} bodyStr  JSON 瀛楃涓? * @param {Object} headers
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
// 鈹€鈹€ HTTPS_PROXY 浠ｇ悊闅ч亾 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const _PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || '';

/**
 * 閫氳繃 HTTP CONNECT 闅ч亾杩炴帴鍒?HTTPS 鐩爣锛堝綋 HTTPS_PROXY 閰嶇疆鏃讹級銆? * @returns {Promise<import('net').Socket>}
 */
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

async function _httpsPost(url, bodyStr, headers = {}, timeoutMs = 120000) {
  const urlObj  = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    path:     urlObj.pathname + urlObj.search,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
  };

  // 濡傛灉閰嶇疆浜嗕唬鐞嗭紝閫氳繃 CONNECT 闅ч亾杩炴帴
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
    req.setTimeout(timeoutMs, () => { req.destroy(); settle(reject, new Error(`HTTPS timeout (${timeoutMs}ms)`)); });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * @param {string} model    e.g. "gemini-3-flash-preview"
 * @param {string} prompt
 * @param {object} context  浠诲姟闄勫甫鐨勪笟鍔′笂涓嬫枃
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function _callGemini(model, prompt, context, timeoutMs) {
  const apiKey = getKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY(S) 未配置，无法执行 Gemini 任务 (credential pool 为空)');
  }

  const fullText = _buildFullPrompt(prompt, context);
  const systemContext = _loadSystemContext();

  const url  = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  // Gemini 鍘熺敓鏀寔 system_instruction锛堢郴缁熺骇鎸囦护锛屼笉娣峰叆瀵硅瘽锛?
  const body = { contents: [{ parts: [{ text: fullText }] }] };
  if (systemContext) {
    body.system_instruction = { parts: [{ text: systemContext }] };
  }
  const reqBody = JSON.stringify(body);

  const MAX_RETRIES = 3;
  // 姣忔璇锋眰鐨勮秴鏃朵笉瓒呰繃鎬昏秴鏃剁殑 40%锛岀暀绌洪棿缁?retry + backoff
  const perRequestTimeout = Math.min(timeoutMs, Math.max(10000, Math.floor(timeoutMs * 0.4)));
  const deadline = Date.now() + timeoutMs;

  // Track the current key for this call; may rotate on 429
  let currentKey = apiKey;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (Date.now() >= deadline) break;  // 鎬昏秴鏃跺厹搴?
    let res;
    try {
      res = await _httpsPost(url, reqBody, { 'x-goog-api-key': currentKey }, perRequestTimeout);
    } catch (networkErr) {
      // Network-level error (timeout, ECONNREFUSED, etc.)
      reportError(currentKey, null);
      const classified = classifyError(networkErr, null, null);
      if (classified.retryable && attempt < MAX_RETRIES) {
        const wait = computeBackoff(classified, attempt);
        console.warn(`[ai-executor][gemini] ${classified.category} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retry in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        // Try to rotate to a different key for next attempt
        const nextKey = getKey();
        if (nextKey) currentKey = nextKey;
        continue;
      }
      const err = new Error(`Gemini ${classified.category}: ${networkErr.message}`);
      err.classified = classified;
      throw err;
    }

    let parsed;
    try   { parsed = JSON.parse(res.body); }
    catch { throw new Error(`Gemini 鍝嶅簲闈?JSON: ${res.body.slice(0, 300)}`); }

    // Successful response
    if (res.statusCode >= 200 && res.statusCode < 300) {
      reportSuccess(currentKey);
      const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text == null) {
        throw new Error(`Gemini 杩斿洖鏍煎紡寮傚父: ${JSON.stringify(parsed).slice(0, 300)}`);
      }
      return text;
    }

    // HTTP error 鈥?report to pool and classify
    reportError(currentKey, res.statusCode);
    const apiErr = new Error(`Gemini API error ${res.statusCode}: ${parsed?.error?.message || JSON.stringify(parsed?.error || {})}`);
    const classified = classifyError(apiErr, res.statusCode, parsed);
    if (classified.retryable && attempt < MAX_RETRIES) {
      const wait = computeBackoff(classified, attempt);
      console.warn(`[ai-executor][gemini] ${classified.category} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retry in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      // On 429, rotate to next key for retry
      if (res.statusCode === 429) {
        const nextKey = getKey();
        if (nextKey) currentKey = nextKey;
      }
      continue;
    }

    apiErr.classified = classified;
    throw apiErr;
  }
}

/**
 * 渚涘閮ㄦā鍧楋紙vote-aggregator 绛夛級鐩存帴璋冪敤 Gemini API銆? * F-006 淇锛歷ote-aggregator 涓嶅啀渚濊禆涓嶅瓨鍦ㄧ殑 `gemini` CLI銆? *
 * @param {string} model
 * @param {string} prompt
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<string>}
 */
export async function callGeminiAPI(model, prompt, timeoutMs = 60000) {
  return _callGemini(model, prompt, {}, timeoutMs);
}

// ---------------------------------------------------------------------------
// CLI 宸ュ叿锛氬甫瓒呮椂鐨?spawn锛堜繚鐣欎綔涓?fallback锛?// ---------------------------------------------------------------------------

/**
 * 閫氳繃 child_process.spawn 鎵ц CLI锛宻tdin 鍐欏叆 stdinPayload锛屾敹闆?stdout/stderr銆? *
 * @param {string}   bin         鍙墽琛屾枃浠惰矾寰勬垨鍚嶇О
 * @param {string[]} args        鍙傛暟鍒楄〃
 * @param {string}   [stdinPayload]  鍐欏叆 stdin 鐨勫唴瀹癸紙濡?prompt锛? * @param {number}   timeoutMs
 * @param {object}   [envExtra]  棰濆鐜鍙橀噺
 * @returns {Promise<string>}    stdout 鍐呭锛坱rim 鍚庯級
 */
function _spawnCLI(bin, args, stdinPayload = '', timeoutMs = 120000, envExtra = {}) {
  return new Promise((resolve, reject) => {
    let _settled = false;
    function _settle(fn, val) { if (!_settled) { _settled = true; fn(val); } }

    const child = spawn(bin, args, {
      env:   { ...process.env, ...envExtra },
      // Windows 涓?npm 鍏ㄥ眬瀹夎鐨?CLI 鏄?.cmd wrapper锛岄渶瑕?shell: true 鎵嶈兘瑙ｆ瀽
      // Linux/macOS 涓?shell: false 涔熻兘宸ヤ綔锛坰hebang 澶勭悊锛?      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', err => {
      _settle(reject, new Error(`CLI spawn error (${bin}): ${err.message}`));
    });

    child.on('close', code => {
      if (code === 0) {
        _settle(resolve, stdout.trim());
      } else {
        // 灏?stderr 闄勫湪閿欒娑堟伅閲岋紙鎴柇闃叉杩囬暱锛?
        const detail = stderr.trim().slice(0, 400) || `exit code ${code}`;
        _settle(reject, new Error(`CLI exited ${code}: ${detail}`));
      }
    });

    // 瓒呮椂澶勭悊锛歋IGTERM + 5s 鍚?SIGKILL 鍏滃簳锛圵indows 涓?SIGTERM 鏃犳晥锛?
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const sigkillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, 5000);
      // 鑻ヨ繘绋嬪湪 SIGKILL 鍓嶅凡閫€鍑猴紝娓呯悊 sigkillTimer
      child.once('close', () => clearTimeout(sigkillTimer));
      _settle(reject, new Error(`CLI timeout after ${timeoutMs}ms (${bin})`));
    }, timeoutMs);

    // 纭繚瀛愯繘绋嬮€€鍑哄悗娓呯悊澶栧眰 timer
    child.on('close', () => clearTimeout(timer));
    child.on('error', () => clearTimeout(timer));

    // 鍐欏叆 stdin锛屽鐞嗚儗鍘?
    if (stdinPayload) {
      const canContinue = child.stdin.write(stdinPayload, 'utf8');
      if (!canContinue) {
        child.stdin.once('drain', () => child.stdin.end());
      } else {
        child.stdin.end();
      }
    } else {
      child.stdin.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Codex CLI 璋冪敤锛坒allback path锛?// ---------------------------------------------------------------------------

/**
 * 閫氳繃 Codex CLI 鎵ц prompt 鈥?淇濈暀浣滀负 OpenAI SDK 涓嶅彲鐢ㄦ椂鐨?fallback銆? */
async function _callCodexCLI(model, prompt, context, timeoutMs) {
  // Codex CLI: prompt 閫氳繃 stdin 浼犲叆锛堢敤 '-' 鍙傛暟鍛婅瘔 codex 浠?stdin 璇诲彇锛?  // 涓嶅姞绯荤粺涓婁笅鏂囷紙Codex 鏈夎嚜宸辩殑涓婁笅鏂囩鐞嗭級
  // 鐢?--json 杈撳嚭 JSONL 渚夸簬瑙ｆ瀽锛?o 鎶婃渶缁堝洖澶嶅啓鍒颁复鏃舵枃浠?
  const args = ['exec', '--full-auto', '--skip-git-repo-check', '-'];
  if (model && model !== 'codex' && model !== 'gpt-5.4') args.push('-m', model);

  return _spawnCLI(CODEX_BIN, args, prompt, Math.max(timeoutMs - 3000, 10000));
}

// ---------------------------------------------------------------------------
// Claude Code CLI 璋冪敤锛坒allback path锛?// ---------------------------------------------------------------------------

/**
 * 閫氳繃 Claude Code CLI锛坄claude -p`锛夋墽琛?prompt 鈥?淇濈暀浣滀负 Anthropic SDK 涓嶅彲鐢ㄦ椂鐨?fallback銆? */
async function _callClaudeCLI(model, prompt, context, timeoutMs) {
  const fullPrompt = _buildFullPrompt(prompt, context);

  const args = ['--print'];
  if (model) args.push('--model', model);

  return _spawnCLI(CLAUDE_BIN, args, fullPrompt, Math.max(timeoutMs - 3000, 10000));
}

// ---------------------------------------------------------------------------
// Gemini with retry 鈥?wrapper for circuit breaker + _callGemini
// ---------------------------------------------------------------------------

/**
 * Call Gemini through circuit breaker. Used by both task-router and legacy paths.
 */
async function _callGeminiWithBreaker(model, prompt, context, timeoutMs) {
  return geminiBreaker.call(() => _callGemini(model, prompt, context, timeoutMs));
}

// ---------------------------------------------------------------------------
// SDK provider call with circuit breaker
// ---------------------------------------------------------------------------

/**
 * Call Anthropic/OpenAI SDK through circuit breaker.
 * Passes system context separately (SDK supports system role natively).
 */
async function _callSDKProviderWithBreaker(provider, model, prompt, context, timeoutMs, task = null) {
  const baseSystemContext = _loadSystemContext();
  // Worker 妯″紡涓嬫敞鍏ュ弽姹℃煋 guard锛堣蛋 providers.mjs 鐨?---DYNAMIC--- 鍒嗘 + cache锛?
  const systemContext = wrapWithGuard(baseSystemContext, task);
  const fullPrompt = _buildFullPrompt(prompt, context);

  const breaker = provider === 'anthropic'   ? anthropicSDKBreaker :
                  provider === 'ollama'      ? ollamaBreaker :
                  provider === 'antigravity' ? antigravityBreaker :
                                               openaiSDKBreaker;

  return breaker.call(async () => {
    const result = await callProvider(provider, model, fullPrompt, systemContext, {
      timeoutMs,
      maxTokens: 4096,
    });
    if (!result.ok) {
      const err = new Error(result.error);
      err.providerResult = result;
      throw err;
    }
    // Worker 妯″紡锛氭壂鎻忚緭鍑烘薄鏌?
    if (task && isWorkerMode(task)) {
      const scan = scanContamination(result.output);
      if (scan.contaminated) {
        console.warn(`[worker-guard] 妫€娴嬪埌瑙掕壊姹℃煋 task=${task.task_id} matches=${JSON.stringify(scan.matches)}`);
        // 瀹¤璁板綍锛堜笉鎷︽埅锛屽彧鍛婅锛涗弗閲嶆薄鏌撳彲浠ユ敼鎴愭姏閿欓噸璇曪級
      }
    }
    return result.output;
  });
}

function _resolveFallbackAttempt(model, providerHint = null, preferAntigravityForClaudeCli = false) {
  if (model && model.startsWith('antigravity-')) return { provider: 'antigravity', model };
  if (model && model.startsWith('ollama-')) return { provider: 'ollama', model };
  if (model && model.startsWith('gemini-')) return { provider: 'google', model };
  if (model && model.startsWith('claude-') && !providerHint) return { provider: 'anthropic', model };
  if (model && model.startsWith('gpt-') && !providerHint) return { provider: 'openai', model };
  if (providerHint === 'claude' && preferAntigravityForClaudeCli && model && !model.startsWith('antigravity-')) {
    return { provider: 'antigravity', model: `antigravity-${model}` };
  }
  return { provider: providerHint, model };
}

async function _executeModelAttempt({ provider, model, prompt, context, timeout_ms, timeoutPromise, task }) {
  const resolved = _resolveFallbackAttempt(model, provider);

  if (resolved.model && resolved.model.startsWith('antigravity-')) {
    const output = await Promise.race([
      _callSDKProviderWithBreaker('antigravity', resolved.model, prompt, context, timeout_ms, task),
      timeoutPromise,
    ]);
    return { output, provider: 'antigravity', model: resolved.model };
  }

  if (resolved.model && resolved.model.startsWith('ollama-')) {
    const output = await Promise.race([
      _callSDKProviderWithBreaker('ollama', resolved.model, prompt, context, timeout_ms, task),
      timeoutPromise,
    ]);
    return { output, provider: 'ollama', model: resolved.model };
  }

  if (resolved.provider === 'google') {
    if (poolSize === 0) throw new Error('GEMINI_API_KEY(S) 未配置，无法执行 Gemini 任务 (credential pool 为空)');
    const output = await Promise.race([
      _callGeminiWithBreaker(resolved.model, prompt, context, timeout_ms),
      timeoutPromise,
    ]);
    return { output, provider: 'google', model: resolved.model };
  }

  if (resolved.provider === 'claude') {
    const output = await Promise.race([
      claudeBreaker.call(() => _callClaudeCLI(resolved.model, prompt, context, timeout_ms)),
      timeoutPromise,
    ]);
    return { output, provider: 'claude-cli', model: resolved.model };
  }

  if (resolved.provider === 'codex') {
    const output = await Promise.race([
      codexBreaker.call(() => _callCodexCLI(resolved.model, prompt, context, timeout_ms)),
      timeoutPromise,
    ]);
    return { output, provider: 'codex-cli', model: resolved.model };
  }

  const sdkProvider = resolved.provider || _resolveFallbackAttempt(resolved.model).provider;
  const output = await Promise.race([
    _callSDKProviderWithBreaker(sdkProvider, resolved.model, prompt, context, timeout_ms, task),
    timeoutPromise,
  ]);
  return { output, provider: sdkProvider, model: resolved.model };
}


// ---------------------------------------------------------------------------
// 涓诲鍑?// ---------------------------------------------------------------------------

/**
 * 鏍规嵁 task_type锛堟垨 worker fallback锛夊垎鍙戝埌鏈€浼?AI provider锛? *
 * Primary path (task-type router):
 *   inferTaskType 鈫?ROUTING_TABLE 鈫?provider dispatch
 *   Fallback chain: primary model 鈫?fallback model 鈫?CLI fallback
 *
 * Legacy path (backward compat):
 *   worker='gemini'/'codex'/'claude' 鈫?鐩存帴璺敱
 *
 * @param {{
 *   task_id:         string,
 *   prompt:          string,
 *   worker:          string,        // 'gemini' | 'codex' | 'claude' (legacy, still supported)
 *   suggested_model: string,
 *   complexity:      number,
 *   task_type?:      string,        // NEW: explicit task type (key in ROUTING_TABLE)
 *   context?:        object,
 *   timeout_ms?:     number,
 * }} task
 *
 * @returns {Promise<{
 *   ok:        boolean,
 *   output?:   string,
 *   model?:    string,
 *   time_ms?:  number,
 *   error?:    string,
 *   taskType?: string,
 *   provider?: string,
 * }>}
 */
export async function executeWithAI(task) {
  const {
    task_id,
    prompt,
    worker,
    suggested_model,
    complexity = 2,
    task_type  = null,
    context    = {},
    timeout_ms = 120000,
  } = task;

  const start = Date.now();

  // 蹇€熷弬鏁版牎楠?
  if (!prompt) {
    return { ok: false, error: 'prompt 涓嶈兘涓虹┖' };
  }

  // 鈹€鈹€ Task-Type Routing (primary path) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // getRoute() lazily resolves modelRole -> actual model ID via model-discovery
  const taskType = inferTaskType(prompt, task_type, complexity);
  let route = { ...getRoute(taskType) };

  // 鈹€鈹€ Health-aware rerouting: skip known-down providers proactively 鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const healthyRoute = getHealthyRoute(taskType, ROUTING_TABLE);
  if (healthyRoute && healthyRoute.source !== 'primary') {
    console.warn(`[ai-executor][worker-health] pre-routing override: ${route.provider}/${route.model} 鈫?${healthyRoute.provider}/${healthyRoute.model} (source: ${healthyRoute.source})`);
    route = { ...route, provider: healthyRoute.provider, model: healthyRoute.model };
  }

  console.log(`[ai-executor][task-router] task=${task_id} taskType=${taskType} 鈫?${route.provider}/${route.model} (fallback: ${route.fallbackProvider}/${route.fallbackModel})`);

  // Use suggested_model override if provided and same provider
  const primaryModel = suggested_model || route.model;

  // 澶栧眰瓒呮椂锛堝弻淇濋櫓锛氬悇 provider 鍐呴儴涔熸湁瓒呮椂锛?
  let _timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    _timeoutId = setTimeout(
      () => reject(new Error(`executeWithAI: 浠诲姟瓒呮椂 (${timeout_ms}ms)`)),
      timeout_ms,
    );
  });

  try {
    let output;
    let actualModel = primaryModel;
    let actualProvider = route.provider;
    let wasFallback = false;

    try {
      const primaryAttempt = await _executeModelAttempt({
        provider: route.provider,
        model: primaryModel,
        prompt,
        context,
        timeout_ms,
        timeoutPromise,
        task,
      });
      output = primaryAttempt.output;
      actualModel = primaryAttempt.model;
      actualProvider = primaryAttempt.provider;
    } catch (primaryErr) {
      console.warn(`[ai-executor][task-router] primary ${route.provider}/${primaryModel} failed: ${primaryErr.message} -> trying fallback chain`);
      wasFallback = true;

      let currentModel = primaryModel;
      let currentErr = primaryErr;
      let isFirstFailure = true;
      const attemptedModels = new Set([primaryModel]);

      try {
        while (true) {
          const chainCandidate = getNextInChain(currentModel, attemptedModels);
          const nextAttempt = chainCandidate
            ? { provider: null, model: chainCandidate, source: 'chain', preferAntigravityForClaudeCli: false }
            : (isFirstFailure && route.fallbackModel && !attemptedModels.has(route.fallbackModel))
              ? {
                provider: route.fallbackProvider,
                model: route.fallbackModel,
                source: 'route',
                preferAntigravityForClaudeCli: route.fallbackProvider === 'claude',
              }
              : null;

          if (!nextAttempt?.model) {
            throw currentErr;
          }

          const resolvedAttempt = _resolveFallbackAttempt(
            nextAttempt.model,
            nextAttempt.provider,
            nextAttempt.preferAntigravityForClaudeCli,
          );

          recordFallback(currentModel, resolvedAttempt.model, currentErr.message);
          attemptedModels.add(resolvedAttempt.model);

          try {
            const fallbackAttempt = await _executeModelAttempt({
              provider: resolvedAttempt.provider,
              model: resolvedAttempt.model,
              prompt,
              context,
              timeout_ms,
              timeoutPromise,
              task,
            });
            output = fallbackAttempt.output;
            actualModel = fallbackAttempt.model;
            actualProvider = fallbackAttempt.provider;
            break;
          } catch (fallbackErr) {
            console.warn(`[ai-executor][task-router] ${nextAttempt.source} fallback ${resolvedAttempt.provider}/${resolvedAttempt.model} failed: ${fallbackErr.message}`);
            currentModel = resolvedAttempt.model;
            currentErr = fallbackErr;
            isFirstFailure = false;
          }
        }
      } catch (fallbackErr) {
        console.warn(`[ai-executor][task-router] fallback chain exhausted: ${fallbackErr.message}`);

        const workerLower = (worker || '').toLowerCase();
        if (workerLower === 'codex') {
          console.warn('[ai-executor] last-resort: trying Codex CLI');
          const routed = selectModel('codex', complexity);
          actualModel = routed.model;
          actualProvider = 'codex-cli';
          output = await Promise.race([
            codexBreaker.call(() => _callCodexCLI(routed.model, prompt, context, timeout_ms)),
            timeoutPromise,
          ]);
        } else if (workerLower === 'claude') {
          console.warn('[ai-executor] last-resort: trying Claude CLI');
          const routed = selectModel('claude', complexity);
          actualModel = routed.model;
          actualProvider = 'claude-cli';
          output = await Promise.race([
            claudeBreaker.call(() => _callClaudeCLI(routed.model, prompt, context, timeout_ms)),
            timeoutPromise,
          ]);
        } else {
          throw fallbackErr;
        }
      }
    }

    const time_ms = Date.now() - start;

    // 鈹€鈹€ 鎴愭湰杩借釜 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    const inputTokens  = estimateTokens(prompt);
    const outputTokens = estimateTokens(output);
    recordCall({
      model:         actualModel,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      latency_ms:    time_ms,
      ok:            true,
      was_fallback:  wasFallback,
    });

    return { ok: true, output, model: actualModel, provider: actualProvider, taskType, time_ms };

  } catch (err) {
    const time_ms = Date.now() - start;
    const classified = err.classified || classifyError(err, null, null);

    // 鈹€鈹€ 閿欒鎴愭湰杩借釜 + 鍙敤鎬ф爣璁?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    const statusCode = classified.statusCode || null;
    routerRecordError(primaryModel, statusCode);
    recordCall({
      model:         primaryModel,
      input_tokens:  estimateTokens(prompt),
      output_tokens: 0,
      latency_ms:    time_ms,
      ok:            false,
      was_fallback:  false,
    });

    return {
      ok: false, model: primaryModel, provider: route.provider, taskType, time_ms,
      error: err.message,
      errorCategory: classified.category,
      retryable:     classified.retryable,
    };

  } finally {
    clearTimeout(_timeoutId);
  }
}


