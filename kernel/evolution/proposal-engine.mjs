/**
 * Nova Kernel — AI 提案引擎
 * kernel/evolution/proposal-engine.mjs
 *
 * 核心设计：AI 不能直接改 L0/L2 禁区，但可以**写提案**。
 * 提案流程：
 *   1. AI 调 submitProposal(target_path, proposed_content, rationale)
 *   2. Nova 落地到 evolution/proposals/ 目录
 *   3. 同时提交给异步议会（Claude Opus + Gemini Pro）投票
 *   4. 议会结论 + 提案全文 → 展示给 Driver Claude
 *   5. Driver 把结论展示给用户，等用户批 approve/veto
 *   6. 用户批 → Driver 调 applyProposal() 真正落地
 *
 * 这是"受约束的自由"的关键通道：AI 想改宪法？写提案。想改 kernel？写提案。
 * 人类是最终裁决者，但 AI 有合法路径表达诉求，而不是硬碰墙。
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { auditLog } from '../audit/audit.js';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const PROPOSALS_DIR = join(ROOT, 'evolution', 'proposals');

function _ensureDir() {
  if (!existsSync(PROPOSALS_DIR)) mkdirSync(PROPOSALS_DIR, { recursive: true });
}

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _proposalId(title) {
  return `${_today()}-${title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40)}-${randomUUID().slice(0, 4)}`;
}

/**
 * 提交一个提案
 * @param {object} p
 * @param {string} p.title            简短描述
 * @param {string} p.target_path      要改的文件
 * @param {string} p.change_type      'patch' | 'replace' | 'append'
 * @param {string} p.proposed_content diff 或完整新内容
 * @param {string} p.rationale        为什么要改
 * @param {string} p.risk_level       'L1' | 'L2' | 'L3'
 * @param {string} p.proposed_by      谁提的（如 claude-opus-4-6-thinking / codex / driver）
 * @param {boolean} [p.auto_council=true]  自动提交议会
 */
export async function submitProposal(p) {
  if (!p.title || !p.target_path || !p.proposed_content || !p.rationale) {
    throw new Error('title / target_path / proposed_content / rationale 都必填');
  }
  _ensureDir();

  const proposal_id = _proposalId(p.title);
  const filepath = join(PROPOSALS_DIR, `${proposal_id}.md`);
  const ts = new Date().toISOString();

  const md = [
    '---',
    `proposal_id: ${proposal_id}`,
    `title: ${p.title}`,
    `target_path: ${p.target_path}`,
    `change_type: ${p.change_type || 'patch'}`,
    `proposed_by: ${p.proposed_by || 'unknown-ai'}`,
    `risk_level: ${p.risk_level || 'L2'}`,
    `created_at: ${ts}`,
    `status: pending_review`,
    '---',
    '',
    '## 动机',
    p.rationale,
    '',
    '## 改动',
    '',
    '```',
    String(p.proposed_content).slice(0, 8000),
    '```',
    '',
    '## 风险',
    p.risks || '(未提供)',
    '',
    '## 回滚方案',
    p.rollback || '(未提供)',
  ].join('\n');

  writeFileSync(filepath, md, 'utf8');

  auditLog({
    event: 'proposal.submitted',
    operator: p.proposed_by || 'unknown',
    target: proposal_id,
    detail: { title: p.title, target_path: p.target_path, risk_level: p.risk_level },
  });

  let council_ticket = null;
  if (p.auto_council !== false) {
    try {
      const { submitForAsyncVote } = await import('../council/async-council.mjs');
      const r = submitForAsyncVote({
        task_id: `proposal-${proposal_id}`,
        operator: p.proposed_by || 'unknown-ai',
        prompt: `评审一个对 Nova 代码的改动提案：\n\n标题：${p.title}\n目标文件：${p.target_path}\n风险等级：${p.risk_level}\n\n动机：${p.rationale}\n\n改动内容（前 2000 字）：\n${String(p.proposed_content).slice(0, 2000)}`,
        project: 'nova-evolution',
        payload: { proposal_id, filepath },
      });
      council_ticket = r.ticket_id;
    } catch (e) {
      console.warn('[proposal-engine] 议会提交失败:', e.message);
    }
  }

  return {
    ok: true,
    proposal_id,
    filepath,
    council_ticket,
    review_url: `curl 'http://127.0.0.1:3700/council/ticket?id=${council_ticket}' -H 'Authorization: Bearer <token>'`,
  };
}

export function listProposals({ status } = {}) {
  _ensureDir();
  const files = readdirSync(PROPOSALS_DIR).filter(f => f.endsWith('.md') && f !== 'README.md');
  const out = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(PROPOSALS_DIR, f), 'utf8');
      const meta = {};
      const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fm) {
        for (const line of fm[1].split('\n')) {
          const i = line.indexOf(':');
          if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
      }
      if (status && meta.status !== status) continue;
      out.push({ filename: f, ...meta });
    } catch {}
  }
  return out;
}

export function getProposal(proposal_id) {
  _ensureDir();
  const filepath = join(PROPOSALS_DIR, `${proposal_id}.md`);
  if (!existsSync(filepath)) {
    // 尝试匹配前缀
    const files = readdirSync(PROPOSALS_DIR).filter(f => f.startsWith(proposal_id) || f.includes(proposal_id));
    if (files.length === 0) return { ok: false, error: '未找到' };
    return { ok: true, filepath: join(PROPOSALS_DIR, files[0]), content: readFileSync(join(PROPOSALS_DIR, files[0]), 'utf8') };
  }
  return { ok: true, filepath, content: readFileSync(filepath, 'utf8') };
}

/**
 * 应用一个已批准的提案（Driver 调，审计记录谁批准了）
 * 注意：真正的 apply 是 Driver 的责任（读 proposal → 执行 change），
 * 这里只标记 status 并记录审计，避免自动 apply 造成意外。
 */
export function markApproved(proposal_id, operator) {
  const p = getProposal(proposal_id);
  if (!p.ok) return p;
  // 只改 frontmatter 的 status 行
  let newContent = p.content.replace(/^status:\s*.+$/m, `status: approved`);
  if (!newContent.includes('approved_by:')) {
    newContent = newContent.replace(/^---\s*$/m, `approved_by: ${operator}\napproved_at: ${new Date().toISOString()}\n---`);
  }
  writeFileSync(p.filepath, newContent, 'utf8');
  auditLog({ event: 'proposal.approved', operator, target: proposal_id, detail: { filepath: p.filepath } });
  return { ok: true, proposal_id, filepath: p.filepath };
}

export function markRejected(proposal_id, operator, reason = '') {
  const p = getProposal(proposal_id);
  if (!p.ok) return p;
  let newContent = p.content.replace(/^status:\s*.+$/m, `status: rejected`);
  newContent = newContent.replace(/^---\s*$/m, `rejected_by: ${operator}\nrejected_at: ${new Date().toISOString()}\nreject_reason: ${reason}\n---`);
  writeFileSync(p.filepath, newContent, 'utf8');
  auditLog({ event: 'proposal.rejected', operator, target: proposal_id, detail: { reason } });
  return { ok: true, proposal_id };
}
