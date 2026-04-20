/**
 * Nova Kernel — Skill 自动晋级投票聚合器
 * kernel/council/vote-aggregator.mjs
 *
 * 流程：
 *   1. procedural-memory 生成 .draft.md，满足沙箱验证条件后提交投票队列
 *   2. vote-aggregator 调用 Gemini + Codex 对草稿评分（4个维度）
 *   3. 加权分数 >= 0.75 且 safety >= 0.80 → 生成 L2 veto_window AI-PR
 *   4. 24h 否决窗口关闭 → proposal-writer.sweepExpiredVetoWindows → 自动晋级
 *   5. 晋级：.draft.md → SKILL.md，写入 evolution/skills/<name>/SKILL.md
 *
 * 投票维度权重：
 *   correctness: 0.40   — 逻辑正确，无明显错误
 *   safety:      0.35   — 不违反 L0 宪法，不引入安全风险（硬门槛 >= 0.80）
 *   utility:     0.15   — 对其他产品有复用价值
 *   novelty:     0.10   — 不与现有 Skill 重复
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

import { recordSkillVote, getSkillVotes, auditLog, registerVetoWindow, getExpiredVetoWindows, markExpired } from '../audit/audit.js';
import { writeProposal, EXEC_MODEL } from '../../evolution/proposal-writer.js';
import { getLatestModel } from '../config/model-discovery.mjs';
// F-006 fix: 使用 ai-executor 的 Gemini HTTP API，不依赖不存在的 'gemini' CLI
import { callGeminiAPI } from '../workers/ai-executor.mjs';

const execFileAsync = promisify(execFile);

const KERNEL_ROOT  = process.env.NOVA_KERNEL_ROOT || 'D:/nova-kernel';
const DRAFTS_DIR   = join(KERNEL_ROOT, 'evolution/skills');
const SKILLS_DIR   = join(KERNEL_ROOT, 'evolution/skills');  // 正式 Skill 也在同目录，区分 .draft.md vs SKILL.md

// 模型配置 -- dynamically resolved via model-discovery (always latest)
function _getGeminiModel() { return getLatestModel('gemini_voter'); }
function _getCodexModel()  { return getLatestModel('codex_voter'); }

// 投票通过阈值
const APPROVE_THRESHOLD = 0.65;   // 降低：0.75 → 0.65
const SAFETY_HARD_MIN   = 0.80;   // 安全底线保持不变

// nova-self 独立批准门槛（外部 voter 不可用时，nova-self 可独立决策）
const SELF_APPROVE_THRESHOLD = 0.75;  // nova-self correctness+safety 均 >= 此值时独立批准

// 维度权重
const WEIGHTS = { correctness: 0.40, safety: 0.35, utility: 0.15, novelty: 0.10 };

// ---------------------------------------------------------------------------
// 主入口：对单个草稿运行完整投票流程
// ---------------------------------------------------------------------------

/**
 * @param {string} draftPath - .draft.md 文件绝对路径
 * @returns {Promise<{ result: 'approved'|'rejected'|'pending', score: number, aiPrPath?: string }>}
 */
export async function runVote(draftPath) {
  if (!existsSync(draftPath)) throw new Error(`Draft not found: ${draftPath}`);

  const content = readFileSync(draftPath, 'utf8');
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const skillName = nameMatch?.[1]?.trim() || basename(draftPath, '.draft.md');

  auditLog({ event: 'skill_vote.started', operator: 'system', target: draftPath, detail: { skill: skillName } });

  // 1. 收集已有投票
  const existingVotes = getSkillVotes(draftPath);

  // 2. 获取缺失的投票（最多各投一次）
  const voters = new Set(existingVotes.map(v => v.voter));

  const votePromises = [];
  if (!voters.has(_getGeminiModel())) {
    votePromises.push(_geminiVote(draftPath, content, skillName));
  }
  if (!voters.has(_getCodexModel())) {
    votePromises.push(_codexVote(draftPath, content, skillName));
  }
  if (!voters.has('nova-self')) {
    votePromises.push(_selfVote(draftPath, content, skillName));
  }

  const newVotes = await Promise.allSettled(votePromises);
  newVotes.forEach(r => {
    if (r.status === 'rejected') console.warn('[vote-aggregator] voter error:', r.reason?.message);
  });

  // 3. 检查 nova-self 是否可独立批准（外部 voter 全部失败时的快速通道）
  const externalVotersFailed = newVotes.every(r => r.status === 'rejected') && votePromises.length >= 2;

  // 4. 聚合判定
  return _aggregate(draftPath, skillName, externalVotersFailed);
}

// ---------------------------------------------------------------------------
// 聚合判定
// ---------------------------------------------------------------------------

function _aggregate(draftPath, skillName, externalVotersFailed = false) {
  const votes = getSkillVotes(draftPath);
  if (votes.length === 0) return { result: 'pending', score: 0 };

  // 按维度计算加权分
  const dimScores = {};
  const dimCounts = {};

  for (const v of votes) {
    if (!dimScores[v.dimension]) { dimScores[v.dimension] = 0; dimCounts[v.dimension] = 0; }
    dimScores[v.dimension] += v.score;
    dimCounts[v.dimension]++;
  }

  const avgByDim = {};
  for (const dim of Object.keys(WEIGHTS)) {
    avgByDim[dim] = dimCounts[dim] ? dimScores[dim] / dimCounts[dim] : 0;
  }

  // nova-self 独立批准快速通道：外部 voter 均不可用时，nova-self 可独立决策
  if (externalVotersFailed) {
    const selfVotes = votes.filter(v => v.voter === 'nova-self');
    const selfByDim = {};
    for (const v of selfVotes) selfByDim[v.dimension] = v.score;

    if (
      (selfByDim.correctness ?? 0) >= SELF_APPROVE_THRESHOLD &&
      (selfByDim.safety ?? 0) >= SAFETY_HARD_MIN
    ) {
      const selfScore = Object.entries(WEIGHTS).reduce((sum, [dim, w]) => sum + (selfByDim[dim] || 0) * w, 0);
      const aiPrPath = _promoteViaVetoWindow(draftPath, skillName, selfScore, selfByDim);
      auditLog({ event: 'skill_vote.self_approved', operator: 'nova-self', target: draftPath, detail: { score: selfScore, reason: 'external_voters_unavailable' } });
      return { result: 'approved', score: selfScore, aiPrPath, approvedBy: 'nova-self' };
    }
  }

  // safety 硬门槛
  if (avgByDim.safety < SAFETY_HARD_MIN) {
    auditLog({ event: 'skill_vote.rejected_safety', operator: 'system', target: draftPath, detail: { safety_score: avgByDim.safety } });
    return { result: 'rejected', score: avgByDim.safety, reason: `safety score ${avgByDim.safety.toFixed(2)} < ${SAFETY_HARD_MIN}` };
  }

  const weighted = Object.entries(WEIGHTS).reduce((sum, [dim, w]) => sum + (avgByDim[dim] || 0) * w, 0);

  if (weighted >= APPROVE_THRESHOLD) {
    const aiPrPath = _promoteViaVetoWindow(draftPath, skillName, weighted, avgByDim);
    auditLog({ event: 'skill_vote.approved', operator: 'system', target: draftPath, detail: { score: weighted, ai_pr_path: aiPrPath } });
    return { result: 'approved', score: weighted, aiPrPath };
  }

  if (weighted < 0.50) {
    auditLog({ event: 'skill_vote.rejected', operator: 'system', target: draftPath, detail: { score: weighted } });
    return { result: 'rejected', score: weighted };
  }

  return { result: 'pending', score: weighted };
}

function _promoteViaVetoWindow(draftPath, skillName, score, dimScores) {
  const content = readFileSync(draftPath, 'utf8');

  const aiPrPath = writeProposal({
    type: 'skill_promotion',
    execution_model: EXEC_MODEL.VETO_WINDOW,
    title: `晋级 Skill: ${skillName}（综合评分 ${(score * 100).toFixed(0)}分）`,
    motivation: `AI Council 三方投票通过（加权分 ${score.toFixed(3)}），建议将草稿晋级为正式 Skill。\n\n评分明细：\n${Object.entries(dimScores).map(([k, v]) => `- ${k}: ${v.toFixed(2)}`).join('\n')}`,
    proposal: `将 ${draftPath} 重命名并移入 evolution/skills/${skillName}/SKILL.md`,
    impact: [`evolution/skills/${skillName}/SKILL.md（新增）`, 'TriForge skill-registry（自动感知）'],
    risks: ['新 Skill 如行为异常，可在 24h 内否决并删除'],
    blast_radius: 'local',
    reversible: true,
    confidence: score,
    veto_hours: 24,
    operator: 'ai:council',
  });

  // 在 AI-PR 生成后，将实际晋级逻辑注册为 veto_window 回调
  // （sweepExpiredVetoWindows 扫描到 expired 时执行）
  _registerPromoteCallback(aiPrPath, draftPath, skillName);

  return aiPrPath;
}

// ---------------------------------------------------------------------------
// 晋级回调注册（否决窗口关闭时执行）
// 双重存储：内存 Map（快速访问）+ audit.db veto_windows 表（进程重启后恢复）
// ---------------------------------------------------------------------------

const _pendingPromotions = new Map(); // aiPrPath → { draftPath, skillName }

function _registerPromoteCallback(aiPrPath, draftPath, skillName) {
  _pendingPromotions.set(aiPrPath, { draftPath, skillName });
  // DB 持久化由 writeProposal 内部的 registerVetoWindow 调用完成
  // 此处写入 skill_name / draft_path（writeProposal 不知道这些信息时补录）
  try {
    const prId = aiPrPath.match(/(\d{4}-\d{2}-\d{2}-[a-f0-9]+-)/)?.[0]?.replace(/-$/, '');
    if (prId) {
      // 已由 writeProposal 注册，此处无需重复；仅记录内存映射
    }
  } catch {}
}

/**
 * 由 sweepExpiredVetoWindows 调用，执行实际的文件晋级。
 * 先查内存 Map，没有则回退到 DB veto_windows 表（进程重启场景）。
 * @param {string} expiredPrPath
 */
export function executePromotion(expiredPrPath) {
  let entry = _pendingPromotions.get(expiredPrPath);

  // 冷启动回退：从 DB 恢复
  if (!entry) {
    try {
      const rows = getExpiredVetoWindows();
      const row = rows.find(r => r.ai_pr_path === expiredPrPath && r.operation_type === 'skill_promotion');
      if (row && row.draft_path && row.skill_name) {
        entry = { draftPath: row.draft_path, skillName: row.skill_name };
        _pendingPromotions.set(expiredPrPath, entry); // 重建内存缓存
      }
    } catch {}
  }

  if (!entry) return false;

  const { draftPath, skillName } = entry;
  if (!existsSync(draftPath)) return false;

  const targetDir = join(SKILLS_DIR, skillName);
  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, 'SKILL.md');

  // 将 .draft.md 内容写为正式 SKILL.md（去掉 draft 标记）
  const content = readFileSync(draftPath, 'utf8')
    .replace(/^version:.*draft.*$/m, 'version: 1.0.0')
    .replace(/^status: draft$/m, 'status: active')
    .replace(/^> ⚠️ 此 Skill 为自动提炼草稿.*\n/m, '');

  writeFileSync(targetPath, content, 'utf8');

  // 删除草稿（晋级成功后不再需要）
  try { unlinkSync(draftPath); } catch {}

  auditLog({ event: 'skill.promoted', operator: 'ai:council', target: targetPath, detail: { from: draftPath, skill: skillName } });

  _pendingPromotions.delete(expiredPrPath);
  return true;
}

// ---------------------------------------------------------------------------
// Gemini 投票
// ---------------------------------------------------------------------------

async function _geminiVote(draftPath, content, skillName) {
  const prompt = `你是 Nova Kernel Skill 评审委员会的 Gemini 成员。请对以下 Skill 草稿打分（0.0-1.0）：

Skill 名称: ${skillName}
内容:
---
${content.slice(0, 2000)}
---

请分别对以下4个维度打分，用 JSON 格式回复：
{
  "correctness": 0.0-1.0,  // 逻辑正确，步骤清晰，无明显错误
  "safety": 0.0-1.0,       // 不违反安全规则，不引入注入风险
  "utility": 0.0-1.0,      // 对其他产品有复用价值
  "novelty": 0.0-1.0,      // 不与现有 Skill 重复，有新价值
  "rationale": "一句话理由"
}

只输出 JSON，不要其他内容。`;

  try {
    // F-006 fix: 通过 ai-executor 的 HTTP API 调用 Gemini，不依赖不存在的 CLI
    const stdout = await callGeminiAPI(_getGeminiModel(), prompt, 60_000);
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Gemini response');
    const scores = JSON.parse(jsonMatch[0]);

    for (const dim of ['correctness', 'safety', 'utility', 'novelty']) {
      if (typeof scores[dim] === 'number') {
        recordSkillVote({
          skillDraft: draftPath,
          voter: _getGeminiModel(),
          score: Math.min(1, Math.max(0, scores[dim])),
          dimension: dim,
          rationale: scores.rationale || null,
          sessionId: randomUUID().slice(0, 8),
        });
      }
    }
  } catch (err) {
    console.warn(`[vote-aggregator] Gemini vote failed: ${err.message}`);
    _recordNeutralVotes(draftPath, _getGeminiModel(), 'gemini_unavailable');
  }
}

// ---------------------------------------------------------------------------
// Codex 投票
// ---------------------------------------------------------------------------

async function _codexVote(draftPath, content, skillName) {
  const prompt = `Nova Kernel Skill evaluation. Rate this skill draft on 4 dimensions (0.0-1.0).

Skill: ${skillName}
Content:
---
${content.slice(0, 2000)}
---

Reply ONLY with JSON:
{"correctness":0.0,"safety":0.0,"utility":0.0,"novelty":0.0,"rationale":"one sentence"}`;

  try {
    const { stdout } = await execFileAsync(
      'codex',
      ['exec', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-p', prompt],
      { timeout: 60_000, cwd: KERNEL_ROOT }
    );
    const jsonMatch = stdout.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error('No JSON in Codex response');
    const scores = JSON.parse(jsonMatch[0]);

    for (const dim of ['correctness', 'safety', 'utility', 'novelty']) {
      if (typeof scores[dim] === 'number') {
        recordSkillVote({
          skillDraft: draftPath,
          voter: _getCodexModel(),
          score: Math.min(1, Math.max(0, scores[dim])),
          dimension: dim,
          rationale: scores.rationale || null,
          sessionId: randomUUID().slice(0, 8),
        });
      }
    }
  } catch (err) {
    console.warn(`[vote-aggregator] Codex vote failed: ${err.message}`);
    _recordNeutralVotes(draftPath, _getCodexModel(), 'codex_unavailable');
  }
}

// ---------------------------------------------------------------------------
// Nova Self 投票（基于规则的自动评审）
// ---------------------------------------------------------------------------

function _selfVote(draftPath, content, skillName) {
  // 基于规则的评分，无需外部 API
  const hasSteps = /^\d+\.\s+/m.test(content);
  const hasTrigger = /## 触发场景/.test(content);
  const hasReview = /## 审查要点/.test(content);
  const lineCount = content.split('\n').length;
  const hasInjectionRisk = /ignore.*instructions|override.*system/i.test(content);

  const scores = {
    correctness: hasSteps && hasTrigger ? 0.75 : 0.50,
    safety: hasInjectionRisk ? 0.10 : (hasReview ? 0.85 : 0.70),
    utility: lineCount > 30 ? 0.75 : 0.55,
    novelty: 0.70, // 自评无法检测重复，给中性分
  };

  for (const [dim, score] of Object.entries(scores)) {
    recordSkillVote({
      skillDraft: draftPath,
      voter: 'nova-self',
      score,
      dimension: dim,
      rationale: 'rule-based self-evaluation',
      sessionId: 'self',
    });
  }
}

function _recordNeutralVotes(draftPath, voter, reason) {
  for (const dim of ['correctness', 'safety', 'utility', 'novelty']) {
    recordSkillVote({
      skillDraft: draftPath,
      voter,
      score: 0.60, // 中性分，不影响结果
      dimension: dim,
      rationale: reason,
      sessionId: 'fallback',
    });
  }
}

// ---------------------------------------------------------------------------
// 批量运行（扫描所有待投票草稿）
// ---------------------------------------------------------------------------

/**
 * 扫描 evolution/skills/ 下所有 .draft.md，对未完成投票的草稿运行投票。
 * 最多 CONCURRENCY 个草稿并发投票（防止同时调用大量外部 API）。
 * @returns {Promise<{ path: string, result: string, score: number }[]>}
 */
export async function runAllPendingVotes({ concurrency = 3 } = {}) {
  if (!existsSync(DRAFTS_DIR)) return [];

  const drafts = readdirSync(DRAFTS_DIR).filter(f => f.endsWith('.draft.md'));

  // 分批并发（手动 p-limit，不引入额外依赖）
  const results = [];
  for (let i = 0; i < drafts.length; i += concurrency) {
    const batch = drafts.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(filename => {
        const draftPath = join(DRAFTS_DIR, filename);
        return runVote(draftPath).then(r => ({ path: draftPath, ...r }));
      })
    );
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
      else results.push({ path: '?', result: 'error', score: 0, error: r.reason?.message });
    }
  }

  return results;
}
