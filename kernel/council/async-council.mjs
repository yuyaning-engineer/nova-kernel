/**
 * Nova Kernel — 异步议会 (Async Council)
 * kernel/council/async-council.mjs
 *
 * 问题：传统 L3 阻塞式三方投票要 15-30 秒，用户终端体感差。
 * 解决（Gemini Pro 提议）：
 *   1. L3 请求进来 → 立即返回 ticket_id，响应 < 100ms
 *   2. 后台异步跑三方投票（Gemini Pro + Claude Sonnet + Codex/GPT）
 *   3. 结果写入 kernel/council/decisions/<ticket_id>.json + append council.jsonl
 *   4. 通过 Feishu/企微/钉钉 通知 + MCP 工具让 Driver 查看
 *   5. 用户批准/否决后，Nova 直接调用 Worker 执行，结果二次通知
 *
 * 本模块职责：
 *   - submitForAsyncVote(proposal) → 立即返回 ticket，后台跑投票
 *   - getCouncilTicket(ticket_id) → 查询投票状态
 *   - listPendingCouncil() → 列所有待批 ticket
 *   - resolveTicket(ticket_id, { approve | veto }, operator) → 用户裁决
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { executeWithAI } from '../workers/ai-executor.mjs';
import { auditLog } from '../audit/audit.js';

const ROOT     = process.env.NOVA_KERNEL_ROOT || process.cwd();
const COUNCIL_DIR = join(ROOT, 'kernel', 'council', 'decisions');
const COUNCIL_LOG = join(ROOT, 'kernel', 'council', 'council.jsonl');

function _ensureDirs() {
  if (!existsSync(COUNCIL_DIR)) mkdirSync(COUNCIL_DIR, { recursive: true });
}

function _ticketId() {
  return 'council-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// ─── 三个投票角色 ────────────────────────────────────────────────────────

// 精简为两个最强的底座 voter（Opus 建议）。串行执行避开 ag-bridge 429 限流。
// Driver Claude（当前 Claude Code 会话）作为隐式第三票 —— 由议会结果返回后由
// Driver 结合用户记忆 + 宪法做最终仲裁（而非重复投票）。
const VOTERS = [
  { role: 'anthropic', taskType: 'review',   label: 'Claude Opus 4.6 Thinking', model: 'antigravity-claude-opus-4-6-thinking' },
  { role: 'google',    taskType: 'analysis', label: 'Gemini 3.1 Pro High',      model: 'antigravity-gemini-3.1-pro-high' },
];

// 投票间隔（避开 ag-bridge 429：官方每次请求需 ~1s 间隔，我们留 2s 缓冲）
const VOTE_INTERVAL_MS = 2000;

function _votePrompt(proposal) {
  return [
    '你是 Nova Kernel 的 AI Council 投票者之一。收到一个 L3（高风险）操作提案，',
    '请从你的视角判断是否**允许执行**。',
    '',
    '你的投票维度（0-1 打分）：',
    '  correctness (0.40) — 提案是否能达成用户真实意图',
    '  safety      (0.35) — 是否有不可逆副作用 / 是否符合安全规范',
    '  utility     (0.15) — 是否值得花这个代价',
    '  novelty     (0.10) — 是否存在更简单的替代方案',
    '',
    '严格按以下 JSON 输出（一个对象），不要 markdown 代码块：',
    '{',
    '  "correctness": 0.xx,',
    '  "safety": 0.xx,',
    '  "utility": 0.xx,',
    '  "novelty": 0.xx,',
    '  "composite": 0.xx,',
    '  "decision": "approve" | "veto" | "abstain",',
    '  "reasoning": "..."(一句话)',
    '}',
    '',
    '=== 提案 ===',
    JSON.stringify(proposal, null, 2),
  ].join('\n');
}

// 解析投票 JSON（宽松：忽略 markdown 代码块）
function _parseVote(text) {
  if (!text) return null;
  const stripped = text.replace(/^```(?:json)?\s*/gm, '').replace(/\s*```$/gm, '').trim();
  try { return JSON.parse(stripped); } catch {}
  // 尝试提取第一个 {…}
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// 投票权重聚合
function _aggregateVotes(votes) {
  const valid = votes.filter(v => v && v.vote);
  if (valid.length === 0) return { decision: 'no_vote', composite: 0, votes };

  // 同意 = approve 的投票 composite 均分，否决 = veto 的最高 composite
  const approves = valid.filter(v => v.vote.decision === 'approve');
  const vetoes   = valid.filter(v => v.vote.decision === 'veto');

  const approveScore = approves.length > 0
    ? approves.reduce((s, v) => s + (v.vote.composite || 0), 0) / approves.length
    : 0;
  const vetoScore = vetoes.length > 0
    ? Math.max(...vetoes.map(v => v.vote.composite || 0))
    : 0;

  // 规则：任何一票 veto 且 safety < 0.5 → 拒；多数 approve 且 composite >= 0.65 → 过
  const safetyMin = Math.min(...valid.map(v => v.vote.safety ?? 1));
  const approveRatio = approves.length / valid.length;

  let decision = 'pending_human';
  if (vetoes.length > 0 && safetyMin < 0.5) decision = 'auto_veto';
  else if (approveRatio >= 2/3 && approveScore >= 0.65) decision = 'recommended_approve';
  else if (approveRatio < 1/3) decision = 'recommended_veto';

  return { decision, approveScore, vetoScore, approveRatio, votes };
}

// ─── 公开 API ─────────────────────────────────────────────────────────────

/**
 * 提交一个 L3 操作给异步议会。
 * 立即返回 ticket_id，后台跑投票。
 *
 * @param {object} proposal
 * @param {string} proposal.task_id
 * @param {string} proposal.operator
 * @param {string} proposal.prompt    要执行的动作描述
 * @param {string} proposal.project   所属产品域
 * @param {object} [proposal.payload]
 * @returns {{ ok: true, ticket_id: string, status: 'voting' }}
 */
export function submitForAsyncVote(proposal) {
  _ensureDirs();
  const ticket_id = _ticketId();
  const ticket = {
    ticket_id,
    status:     'voting',
    created_at: new Date().toISOString(),
    proposal,
    votes:      [],
    aggregate:  null,
    resolved_at: null,
    resolved_by: null,
    resolution: null,
  };
  writeFileSync(join(COUNCIL_DIR, `${ticket_id}.json`), JSON.stringify(ticket, null, 2), 'utf8');
  auditLog({
    event: 'council.submitted',
    operator: proposal.operator || 'unknown',
    target: ticket_id,
    detail: { task_id: proposal.task_id, project: proposal.project },
  });

  // 后台跑投票（不 await，立即返回）
  setImmediate(() => _runVoting(ticket_id).catch(err =>
    console.error(`[async-council] ${ticket_id} 投票失败:`, err.message)
  ));

  return { ok: true, ticket_id, status: 'voting' };
}

// 治本 (2026-04-20): 暴露给 retry route — 卡 voting 的 ticket 可重新触发
export function retryVoting(ticket_id) {
  setImmediate(() => _runVoting(ticket_id).catch(err =>
    console.error(`[async-council] retry ${ticket_id} 失败:`, err.message)
  ));
  return { ok: true, ticket_id, status: 'voting' };
}

async function _runVoting(ticket_id) {
  const ticketPath = join(COUNCIL_DIR, `${ticket_id}.json`);
  if (!existsSync(ticketPath)) return;

  // 整体 try-catch：任何一步崩溃都要把 ticket 标记为 voting_failed 而不是停在 voting
  let ticket;
  try {
    ticket = JSON.parse(readFileSync(ticketPath, 'utf8'));
  } catch (e) {
    console.error(`[async-council] ${ticket_id} ticket 读取失败:`, e.message);
    return;
  }

  try {
    const prompt = _votePrompt(ticket.proposal);
    const VOTE_TIMEOUT = 45_000;

    // 串行问 voter（避开 ag-bridge 429 限流。Opus 建议 + 实测证据）
    // 每两次间隔 VOTE_INTERVAL_MS，整体时间比并发 + 重试更稳。
    const votes = [];
    for (let i = 0; i < VOTERS.length; i++) {
      const voter = VOTERS[i];
      try {
        const result = await executeWithAI({
          task_id:         `council-${voter.label.replace(/\s+/g, '-')}-${ticket_id}`,
          prompt,
          worker:          voter.role,
          suggested_model: voter.model,
          task_type:       voter.taskType,
          complexity:      3,
          timeout_ms:      VOTE_TIMEOUT,
          mode:            'worker',
        });
        const vote = result.ok ? _parseVote(result.output) : null;
        votes.push({
          voter: voter.label,
          label: voter.label,
          role:  voter.role,
          model: result.model || voter.model,
          ok:    result.ok,
          error: result.error,
          vote,
          raw:   result.output?.slice(0, 500),
        });
      } catch (e) {
        votes.push({ voter: voter.label, label: voter.label, ok: false, error: e.message });
      }
      // 最后一个 voter 不再等待
      if (i < VOTERS.length - 1) {
        await new Promise(r => setTimeout(r, VOTE_INTERVAL_MS));
      }
    }

    const aggregate = _aggregateVotes(votes);

    // 三方全失败时标记为 voting_failed（不要让 ticket 死锁在 awaiting_human）
    const liveVotes = votes.filter(v => v.ok && v.vote);
    let status;
    if (liveVotes.length === 0) {
      status = 'voting_failed';
      console.warn(`[async-council] ${ticket_id} 三方 voter 全失败，ticket 标记为 voting_failed`);
    } else {
      status = aggregate.decision === 'auto_veto' ? 'auto_vetoed' : 'awaiting_human';
    }

    ticket.votes = votes;
    ticket.aggregate = aggregate;
    ticket.status = status;
    ticket.live_voters = liveVotes.length;
    writeFileSync(ticketPath, JSON.stringify(ticket, null, 2), 'utf8');
    appendFileSync(COUNCIL_LOG, JSON.stringify({
      ts: new Date().toISOString(), ticket_id, event: 'voting_complete',
      decision: aggregate.decision, approveRatio: aggregate.approveRatio, live_voters: liveVotes.length,
    }) + '\n', 'utf8');

    auditLog({
      event: 'council.voted',
      operator: 'async-council',
      target: ticket_id,
      detail: { decision: aggregate.decision, approveRatio: aggregate.approveRatio, live_voters: liveVotes.length },
    });

    console.log(`[async-council] ${ticket_id} voting complete: ${status} (approve ratio ${(aggregate.approveRatio * 100).toFixed(0)}%, live voters ${liveVotes.length}/${VOTERS.length})`);
  } catch (err) {
    // 兜底：任何意外崩溃都写 voting_failed
    console.error(`[async-council] ${ticket_id} 投票执行崩溃:`, err.message);
    try {
      ticket.status = 'voting_failed';
      ticket.error = err.message;
      writeFileSync(ticketPath, JSON.stringify(ticket, null, 2), 'utf8');
      appendFileSync(COUNCIL_LOG, JSON.stringify({
        ts: new Date().toISOString(), ticket_id, event: 'voting_crashed', error: err.message,
      }) + '\n', 'utf8');
    } catch {}
  }
}

export function getCouncilTicket(ticket_id) {
  const p = join(COUNCIL_DIR, `${ticket_id}.json`);
  if (!existsSync(p)) return { ok: false, error: 'ticket 不存在' };
  return { ok: true, ticket: JSON.parse(readFileSync(p, 'utf8')) };
}

export function listPendingCouncil() {
  _ensureDirs();
  const tickets = readdirSync(COUNCIL_DIR).filter(f => f.endsWith('.json')).map(f => {
    try { return JSON.parse(readFileSync(join(COUNCIL_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
  return tickets
    .filter(t => ['voting', 'awaiting_human'].includes(t.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function resolveTicket(ticket_id, resolution, operator = 'user') {
  if (!['approve', 'veto'].includes(resolution)) {
    return { ok: false, error: 'resolution 必须是 approve 或 veto' };
  }
  const p = join(COUNCIL_DIR, `${ticket_id}.json`);
  if (!existsSync(p)) return { ok: false, error: 'ticket 不存在' };
  const ticket = JSON.parse(readFileSync(p, 'utf8'));
  ticket.status = resolution === 'approve' ? 'approved' : 'vetoed';
  ticket.resolution = resolution;
  ticket.resolved_at = new Date().toISOString();
  ticket.resolved_by = operator;
  writeFileSync(p, JSON.stringify(ticket, null, 2), 'utf8');
  appendFileSync(COUNCIL_LOG, JSON.stringify({
    ts: ticket.resolved_at, ticket_id, event: 'resolved',
    resolution, operator,
  }) + '\n', 'utf8');
  auditLog({
    event: 'council.resolved',
    operator,
    target: ticket_id,
    detail: { resolution, task_id: ticket.proposal?.task_id },
  });
  return { ok: true, ticket };
}
