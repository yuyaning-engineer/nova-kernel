/**
 * kb/transcript-reader.mjs — Claude Code session transcript 读取器
 *
 * Claude Code 的 session 对话存在 ~/.claude/projects/<workspace>/<session>.jsonl
 * 每行 JSON：{type: 'user'|'assistant'|'system', message:{...}, timestamp}
 *
 * 提供：
 *   listSessions()           — 列所有 session 文件
 *   getCurrentSessionPath()  — 猜本次 session 的 jsonl 文件
 *   readSession(path, opts)  — 读 + 过滤 tool_use 噪音 + 结构化
 *   sliceByTurns(msgs, n)    — 取最近 N 个 user-assistant 来回
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DEFAULT_PROJECT = process.env.NOVA_CLAUDE_PROJECT_DIR
  || join(HOME, '.claude', 'projects', 'D--claude');

export function listSessions(projectDir = DEFAULT_PROJECT) {
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const full = join(projectDir, f);
      const st = statSync(full);
      return { id: f.replace(/\.jsonl$/, ''), path: full, mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function getCurrentSessionPath(projectDir = DEFAULT_PROJECT) {
  // 当前 session = 最近被写的 jsonl（保险：只看 30 分钟内活跃的）
  const sessions = listSessions(projectDir);
  if (!sessions.length) return null;
  const top = sessions[0];
  return Date.now() - top.mtime < 30 * 60 * 1000 ? top.path : top.path;
}

/**
 * 读 session 文件，提取 user / assistant 文本对话。
 * 过滤掉 tool_use / tool_result 噪音（除非 keep_tools=true）。
 *
 * @returns Array<{role, text, ts, turn_n}>
 */
export function readSession(path, { keep_tools = false, max_messages = 0 } = {}) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const out = [];
  let userTurn = 0;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const t = o.type;
    if (t !== 'user' && t !== 'assistant') continue;
    const msg = o.message || {};
    const role = msg.role || t;
    const ts = o.timestamp || '';
    let text = '';
    const c = msg.content;

    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          text += (text ? '\n' : '') + part.text;
        } else if (keep_tools && part?.type === 'tool_use') {
          text += `\n[tool_use: ${part.name}]`;
        } else if (keep_tools && part?.type === 'tool_result') {
          const tr = typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '');
          text += `\n[tool_result: ${tr.slice(0, 200)}]`;
        }
      }
    }

    if (!text.trim()) continue;
    if (role === 'user') userTurn++;
    out.push({ role, text: text.trim(), ts, turn_n: userTurn });
    if (max_messages && out.length >= max_messages) break;
  }
  return out;
}

/**
 * 按 user-turn 切片，取最近 N 个回合（含对应 assistant 回复）
 */
export function sliceByTurns(messages, n = 20) {
  if (!n || n <= 0) return messages;
  const turns = new Set();
  for (let i = messages.length - 1; i >= 0 && turns.size < n; i--) {
    if (messages[i].role === 'user') turns.add(messages[i].turn_n);
  }
  if (!turns.size) return messages;
  return messages.filter(m => turns.has(m.turn_n));
}

/**
 * 估算 token 数（粗算：中文 1 字 ≈ 1.5 token，英文 4 字 ≈ 1 token）
 */
export function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    const t = m.text || '';
    const cn = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    total += Math.round(cn * 1.5 + (t.length - cn) / 4);
  }
  return total;
}

/**
 * 渲染成 LLM 友好的对话格式（user/assistant 来回）
 */
export function renderTranscript(messages, { with_turn_num = true } = {}) {
  return messages.map(m => {
    const tag = with_turn_num ? `[T${m.turn_n} ${m.role}]` : `[${m.role}]`;
    return `${tag}\n${m.text}`;
  }).join('\n\n---\n\n');
}
