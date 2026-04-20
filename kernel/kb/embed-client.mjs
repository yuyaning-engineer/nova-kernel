/**
 * kb/embed-client.mjs — Embedding 客户端 (KB v2)
 *
 * 当前后端: Ollama nomic-embed-text @ :11434
 * (替代原设计 ObsidianAI qwen3-embedding-8b @ :8899 - 后者需独立部署)
 *
 * 接口签名兼容原版 (probe / embed / rerank)
 * 切换后端: 设 KB_EMBED_URL + KB_EMBED_MODEL
 */

const URL = process.env.KB_EMBED_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.KB_EMBED_MODEL || 'nomic-embed-text';
const TIMEOUT_MS = parseInt(process.env.KB_EMBED_TIMEOUT_MS || '30000', 10);

async function _fetch(path, body, method = 'POST', timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(`${URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    return parsed;
  } finally { clearTimeout(t); }
}

export async function probe() {
  try {
    const r = await _fetch('/api/tags', null, 'GET', 1500);
    const hasModel = (r.models || []).some(m => m.name?.startsWith(MODEL.split(':')[0]));
    return { ok: true, hasModel, model: MODEL, raw: r };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * embed(["a","b"], "document") -> { ok, vectors, model, dim }
 * Ollama 一次只 embed 1 条 → 串行循环
 */
export async function embed(texts, mode = 'document', opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('texts 必填');

  const ping = await probe();
  if (!ping.ok) return { ok: false, reason: `Ollama @ ${URL} 不可达：${ping.reason}` };
  if (!ping.hasModel) return { ok: false, reason: `Ollama 无模型 ${MODEL}: ollama pull ${MODEL}` };

  const vectors = [];
  for (const text of texts) {
    try {
      const r = await _fetch('/api/embeddings', { model: MODEL, prompt: String(text || '').slice(0, opts.max_length || 8192) });
      if (!Array.isArray(r.embedding)) {
        return { ok: false, reason: 'Ollama 返回无 embedding 字段', raw_keys: Object.keys(r || {}) };
      }
      vectors.push(r.embedding);
    } catch (e) {
      return { ok: false, reason: `embed 第 ${vectors.length + 1} 条失败: ${e.message}` };
    }
  }
  return { ok: true, vectors, model: MODEL, dim: vectors[0]?.length || 0 };
}

/**
 * Ollama 无原生 rerank。返 ok=false，调用方应用 vector-store 的余弦排序兜底。
 */
export async function rerank(query, documents, opts = {}) {
  return {
    ok: false,
    reason: 'Ollama backend 无 rerank — 用余弦排序代替',
    fallback_to: 'cosine_similarity',
  };
}
