/**
 * kernel/task/task-planner.mjs — 任务来了先看身边有什么 (2026-04-19)
 *
 * 用户痛点: Driver 进新 session / 接新任务时, 不主动搜 skill/agent/feedback,
 *           容易闭门造车 + 重复掉过的坑.
 *
 * 解法: 一个统一入口 planTask(intent) → 返回:
 *   {
 *     intent: '...',
 *     relevant_skills: [{ name, path, why }],
 *     relevant_agents: [{ name, why }],
 *     warnings:        [{ source, body, why }],   // 来自 feedback 的"曾经踩坑"
 *     proposals:       [{ name, path, conf }],    // 待审 skill (相关候选)
 *   }
 *
 * 算法:
 *   1. 先用关键词正则做硬匹配 (秒级, 精度低 but 召回稳)
 *   2. 命中数 ≥1 直接返回; 否则 LLM 兜底语义匹配 (Sonnet 4.6 ≤8s)
 *
 * 调用入口:
 *   - HTTP: POST /task/plan { intent }
 *   - MCP:  nova_task_plan { intent }
 *   - 内部: import { planTask } from './kernel/task/task-planner.mjs'
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readMemories, writeMemory } from '../memory/memory-writer.mjs';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();

function _loadSkills() {
  const skills = [];
  // 已晋级 skills (evolution/skills/*.md)
  const dir = join(ROOT, 'evolution', 'skills');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const path = join(dir, f);
      try {
        const md = readFileSync(path, 'utf8');
        const name = f.replace(/\.md$/, '');
        skills.push({ name, path, content: md, status: 'promoted' });
      } catch {}
    }
  }
  return skills;
}

function _loadProposals() {
  const proposals = [];
  const dir = join(ROOT, 'evolution', 'proposals');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('skill-') || !f.endsWith('.md')) continue;
      const path = join(dir, f);
      try {
        const md = readFileSync(path, 'utf8');
        const fm = md.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
        const name = (fm.match(/^name:\s*(.+)$/m)?.[1] || f.replace(/^skill-|\.md$/g, '')).trim();
        const conf = parseFloat(fm.match(/^confidence:\s*([\d.]+)/m)?.[1] || '0');
        proposals.push({ name, path, conf, content: md, status: 'proposal' });
      } catch {}
    }
  }
  return proposals;
}

function _loadAgents() {
  try {
    const reg = JSON.parse(readFileSync(join(ROOT, 'kernel/agents/registry.json'), 'utf8'));
    return Object.entries(reg.agents || {}).map(([name, meta]) => ({
      name,
      module: meta.module,
      risk_level: meta.risk_level,
      description: meta.description,
      calling_convention: meta.calling_convention,
    }));
  } catch { return []; }
}

/**
 * 关键词硬匹配: 简单粗暴, 但召回稳.
 * 把 intent 切成 token, 看每个 skill/agent/feedback 的 name+desc+body 命中几个.
 */
function _scoreByKeyword(intent, item, fields) {
  const intentLower = intent.toLowerCase();
  // 提取 intent 关键词:
  //   - 英文/数字/连字符: 4+ 字符整段 (e.g. "atomic", "jushuitan", "connector")
  //   - 中文: 滑窗 2/3 字 (overlapping bigrams + trigrams), 解决"聚水潭"被吞进大段问题
  const tokens = new Set();
  for (const m of intentLower.matchAll(/[a-z0-9_-]{4,}/g)) tokens.add(m[0]);
  for (const m of intentLower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = m[0];
    if (s.length < 2) continue;
    // 滑 2-gram
    for (let i = 0; i + 2 <= s.length; i++) tokens.add(s.slice(i, i + 2));
    // 滑 3-gram (额外信号)
    for (let i = 0; i + 3 <= s.length; i++) tokens.add(s.slice(i, i + 3));
  }
  if (tokens.size === 0) return 0;

  const haystack = fields.map(f => (item[f] || '').toLowerCase()).join(' ');
  let hits = 0;
  for (const t of tokens) if (haystack.includes(t)) hits++;
  return hits;
}

/**
 * 主入口: 给意图 → 返回相关 skill/agent/warning 清单.
 *
 * @param {string|object} input - intent 字符串, 或 { intent, max?, includeProposals? }
 */
export async function planTask(input) {
  const intent = typeof input === 'string' ? input : input?.intent || '';
  const max = (typeof input === 'object' && input?.max) || 5;
  const includeProposals = (typeof input === 'object' && input?.includeProposals) ?? true;

  if (!intent || intent.length < 3) {
    return { ok: false, error: 'intent 必填且 ≥3 字符' };
  }

  // ── 加载 4 个池子 ──────────────────────────────────────────────────
  const skills    = _loadSkills();
  const proposals = includeProposals ? _loadProposals() : [];
  const agents    = _loadAgents();
  const feedbacks = readMemories({ type: 'feedback' });

  // ── 关键词打分 + 排序 ───────────────────────────────────────────────
  const scoreSkill = (s) => _scoreByKeyword(intent, s, ['name', 'content']);
  const scoreAgent = (a) => _scoreByKeyword(intent, a, ['name', 'description', 'module']);
  const scoreFb    = (f) => _scoreByKeyword(intent, f, ['name', 'description', 'body']);

  const rankedSkills = skills
    .map(s => ({ ...s, _score: scoreSkill(s) }))
    .filter(s => s._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, max);

  const rankedProposals = proposals
    .map(p => ({ ...p, _score: scoreSkill(p) }))
    .filter(p => p._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, max);

  const rankedAgents = agents
    .map(a => ({ ...a, _score: scoreAgent(a) }))
    .filter(a => a._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, max);

  const rankedFeedbacks = feedbacks
    .map(f => ({ ...f, _score: scoreFb(f) }))
    .filter(f => f._score >= 1)
    .sort((a, b) => b._score - a._score)
    .slice(0, max);

  // ── 构造 LLM-friendly 输出 (省 token, 不返完整 body) ────────────────
  return {
    ok: true,
    intent,
    summary: {
      skills_matched:    rankedSkills.length,
      proposals_matched: rankedProposals.length,
      agents_matched:    rankedAgents.length,
      warnings_matched:  rankedFeedbacks.length,
    },
    relevant_skills: rankedSkills.map(s => ({
      name: s.name,
      path: s.path.replace(ROOT, '').replace(/\\/g, '/'),
      score: s._score,
      preview: s.content.slice(0, 240),
    })),
    relevant_agents: rankedAgents.map(a => ({
      name: a.name,
      module: a.module,
      risk: a.risk_level,
      description: a.description,
      score: a._score,
    })),
    warnings: rankedFeedbacks.map(f => ({
      name: f.name,
      description: f.description,
      body_preview: (f.body || '').slice(0, 240),
      score: f._score,
    })),
    proposals: rankedProposals.map(p => ({
      name: p.name,
      path: p.path.replace(ROOT, '').replace(/\\/g, '/'),
      conf: p.conf,
      score: p._score,
    })),
    hint: rankedSkills.length === 0 && rankedAgents.length === 0
      ? '关键词匹配 0 命中. 任务可能是新领域, 可以放手做 — 完成后写 feedback 让 skill miner 6h 内 cluster 成新 skill.'
      : `关键词命中 ${rankedSkills.length + rankedAgents.length} 个能力 + ${rankedFeedbacks.length} 条历史警示. 优先复用, 再考虑造新轮子.`,
  };
}

/**
 * 反哺闭环: 任务规划完成后, 记录"这个任务用了哪些 skill/agent",
 * 让 skill-miner 6h cycle 学到 task_intent → capability_set 的映射,
 * 帮助下次同类任务直接命中.
 *
 * 为防 jsonl 膨胀: 仅当意图 ≥10 字 + 命中至少 1 个能力时记 (有学习价值).
 */
export function logTaskPlan(plan) {
  if (!plan?.ok || (plan.intent || '').length < 10) return;
  const matched = (plan.summary?.skills_matched || 0)
                + (plan.summary?.agents_matched || 0)
                + (plan.summary?.proposals_matched || 0);
  if (matched === 0) return;

  try {
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
    writeMemory({
      type: 'project',
      name: `task-plan-${ts}`,
      description: `任务规划记录 (${plan.intent.slice(0, 40)}...)`,
      body: [
        `**intent**: ${plan.intent.slice(0, 280)}`,
        `**skills_matched**: ${(plan.relevant_skills || []).map(s => s.name).join(', ') || '-'}`,
        `**agents_matched**: ${(plan.relevant_agents || []).map(a => a.name).join(', ') || '-'}`,
        `**proposals_matched**: ${(plan.proposals || []).map(p => p.name).join(', ') || '-'}`,
        `**warnings_referenced**: ${(plan.warnings || []).slice(0, 3).map(w => w.name).join(', ') || '-'}`,
        ``,
        `Why: 记录"什么意图被规划到什么能力"是反哺关键 — skill-miner 学这个映射, ` +
        `下次类似任务可以直接 propose pre-built recipe (跳过搜索阶段).`,
      ].join('\n'),
      source: 'task-planner-telemetry',
      confidence: 0.75,  // 略高于 0.7 active 门槛 (telemetry 应可见, skill-miner 才能学)
      module: 'meta',
    });
  } catch { /* 写记忆失败不影响主链路 */ }
}
