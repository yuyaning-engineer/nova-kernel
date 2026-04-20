/**
 * kernel/evolution/skill-miner.mjs — 自动 Skill 沉淀器
 *
 * 设计目标:
 *   2394 active 记忆里有大量"做事方法"散在 feedback type 的 body (含 "How to apply" 段),
 *   现在 evolution/skills/ 只 3 个晋级 skill (0.1% 沉淀率).
 *
 * 流程:
 *   1. 增量取 feedback type 里 含 "How to apply" 的 body (上次 mining 之后写的)
 *   2. 高频动词聚类 (本地, 不调 LLM): 提取 trigger keyword → 同 trigger 的 body 归一组
 *   3. 同组 ≥3 条 → LLM 合并成结构化 {name, trigger, steps[], conf}
 *   4. conf ≥ 0.85 → 写 evolution/proposals/skill-{name}.md (走 Council 审, 不自动晋级)
 *
 * Token 安全:
 *   - 增量 (按 created_at > last_mined_at)
 *   - 单批 ≤10 条 feedback ≤4KB 喂 LLM
 *   - 失败 LLM (返空/超时) → skip 当批, 不阻塞主链路
 *
 * 触发: self-maintenance 6h cron 跑 + 手动 POST /evolution/mine-skills
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readMemories } from '../memory/memory-writer.mjs';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const PROPOSALS_DIR = join(ROOT, 'evolution', 'proposals');
const STATE_FILE = join(ROOT, 'kernel', 'evolution', 'skill-miner-state.json');
const MIN_GROUP_SIZE = 2;       // 2 个同主题即可提议 (小规模库现实, conf>=0.7 兜底质量)
const BATCH_SIZE = 10;          // 单批 LLM 喂 10 条 feedback
const MAX_BODY_PER = 400;       // 每条 body 截断长度

/**
 * 默认 LLM 调用器 — 走 utils/llm 统一层 (跨 caller 行为一致)
 * T2 结构化抽取 → antigravity-claude-sonnet-4-6 (Antigravity 免费, 推理强)
 */
async function _defaultCallLlm(prompt) {
  const { callLlmJson } = await import('../utils/llm.mjs');
  const r = await callLlmJson(prompt, {
    model: 'antigravity-claude-sonnet-4-6',
    task_type: 'structured-extract',
    worker: 'skill-miner',
    task_id: `skill-miner-${Date.now()}`,
    timeout_ms: 60_000,
  });
  if (!r.ok) return { error: r.error };
  return r.json;
}

function _loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { last_mined_at: null, proposals_written: [] }; }
}
function _saveState(s) {
  if (!existsSync(join(ROOT, 'kernel', 'evolution'))) {
    mkdirSync(join(ROOT, 'kernel', 'evolution'), { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

/**
 * 触发键提取: 优先用 entry.name 的 kebab-case 前缀 (人写, 主题干净)
 * fallback 才用 body regex.
 *
 * 算法 (2026-04-19 治本):
 *   1. name 前 2 段 (e.g. "connector-codex-cli-unknown" → "connector-codex")
 *   2. fallback: body 中文动词模式
 *   3. fallback: body 前 6 字
 */
function _extractTriggerKey(entry) {
  const name = entry?.name || '';
  // 1. name 优先: 取前两段 kebab-case
  if (name && name.includes('-')) {
    const parts = name.split('-').filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 2).join('-');
    return parts[0];
  }
  if (name && name.length >= 4) return name.slice(0, 24);

  // 2. body fallback (旧逻辑)
  const text = (entry?.body || '').slice(0, 200);
  const m1 = text.match(/(?:当|在|做|跑|调|写|改|测|发|读|改)\s*([^\s,.，。！？]{2,8})/);
  if (m1) return m1[1];
  const m2 = text.match(/[\u4e00-\u9fff]{2,4}(?=\s|的|时|前|后)/);
  if (m2) return m2[0];
  return text.replace(/[\s\u3000]+/g, '').slice(0, 6);
}

/**
 * 主流程
 */
export async function mineSkills({ dry = false, callLlm = _defaultCallLlm } = {}) {
  const state = _loadState();
  const all = readMemories({ type: 'feedback' });
  const since = state.last_mined_at ? new Date(state.last_mined_at).getTime() : 0;
  // 包含所有有 body 的 feedback (不强求 "How to apply" 字样)
  // 因为多数实际 feedback 是直接写规则, 不是"问题+应对"格式
  const fresh = all.filter(e => {
    if (!e.body || e.body.length < 50) return false; // 太短的略
    const t = new Date(e.created_at || 0).getTime();
    return t > since;
  });

  if (fresh.length === 0) {
    return { ok: true, mined: 0, reason: 'no fresh feedback since last mine', last: state.last_mined_at };
  }

  // 双层聚类:
  //   细粒度 (2-segment, e.g. "connector-codex"): MIN_GROUP_SIZE=2
  //   粗粒度 (1-segment, e.g. "connector"): MIN_GROUP_SIZE=4 (避免噪音)
  // 同一组 entry 会同时出现在两层 → LLM 会对应蒸馏出 sub-skill + super-skill.
  const fineGroups = new Map();
  const coarseGroups = new Map();
  for (const e of fresh) {
    const fine = _extractTriggerKey(e);
    if (!fineGroups.has(fine)) fineGroups.set(fine, []);
    fineGroups.get(fine).push(e);

    const coarse = (e.name || '').split('-').filter(Boolean)[0] || fine;
    if (coarse !== fine) {
      if (!coarseGroups.has(coarse)) coarseGroups.set(coarse, []);
      coarseGroups.get(coarse).push(e);
    }
  }
  const fineHits = [...fineGroups.entries()].filter(([_, v]) => v.length >= MIN_GROUP_SIZE);
  const coarseHits = [...coarseGroups.entries()].filter(([_, v]) => v.length >= 4);
  const candidateGroups = [...fineHits, ...coarseHits];

  const proposals = [];
  for (const [trigger, items] of candidateGroups) {
    const sample = items.slice(0, BATCH_SIZE).map(e => `- [${e.name}] ${e.body.slice(0, MAX_BODY_PER)}`).join('\n');
    const prompt = [
      `你是 Nova Skill 蒸馏器. 下面是 ${items.length} 条触发关键词为「${trigger}」的 feedback. 请合并成 1 个可复用 skill.`,
      ``,
      `输出严格 JSON: {"name":"kebab-case-name", "trigger":"自然语言触发条件", "steps":["步骤1","步骤2",...], "conf":0-1, "note":"补充"}`,
      ``,
      `feedback 样本:`,
      sample,
    ].join('\n');

    let llmResp = null;
    if (callLlm && typeof callLlm === 'function') {
      try {
        llmResp = await callLlm(prompt);
      } catch (e) { llmResp = { error: e.message }; }
    } else {
      // dry/无 LLM: 只生成简版"草稿提案" (不调云, 用于快速测试)
      llmResp = {
        name: `auto-${trigger.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 20)}`,
        trigger,
        steps: items.slice(0, 5).map(e => e.name),
        conf: 0.6,
        note: `dry-run 自动聚类, ${items.length} 条来源 feedback`,
      };
    }

    // 严校验: undefined/NaN/'abc' 都漏过 < 0.7 检查 (NaN < 0.7 是 false), 必须 Number.isFinite
    const conf = Number(llmResp?.conf);
    if (!llmResp || llmResp.error || typeof llmResp.name !== 'string' || !llmResp.name.trim()
        || !Number.isFinite(conf) || conf < 0.7) {
      continue;
    }
    llmResp.conf = conf;

    const proposalPath = join(PROPOSALS_DIR, `skill-${llmResp.name}.md`);
    // 幂等: 同 name proposal 已存在则跳过 (允许 re-mine 不重写)
    if (existsSync(proposalPath)) continue;
    const md = [
      `---`,
      `type: skill_proposal`,
      `name: ${llmResp.name}`,
      `trigger_keyword: ${trigger}`,
      `confidence: ${llmResp.conf}`,
      `source_feedback_count: ${items.length}`,
      `created_at: ${new Date().toISOString()}`,
      `status: pending`,
      `---`,
      ``,
      `# Skill: ${llmResp.name}`,
      ``,
      `## Trigger`,
      llmResp.trigger,
      ``,
      `## Steps`,
      ...(llmResp.steps || []).map((s, i) => `${i+1}. ${s}`),
      ``,
      `## Source feedback (${items.length})`,
      ...items.slice(0, 5).map(e => `- ${e.name} (${e.created_at?.slice(0,10)})`),
      ``,
      `## Note`,
      llmResp.note || '',
    ].join('\n');

    if (!dry) {
      if (!existsSync(PROPOSALS_DIR)) mkdirSync(PROPOSALS_DIR, { recursive: true });
      writeFileSync(proposalPath, md, 'utf8');
    }
    proposals.push({ name: llmResp.name, path: proposalPath, trigger, source_count: items.length, conf: llmResp.conf });
  }

  if (!dry) {
    state.last_mined_at = new Date().toISOString();
    state.proposals_written = (state.proposals_written || []).concat(proposals.map(p => p.name));
    _saveState(state);
  }

  return {
    ok: true,
    fresh_feedback: fresh.length,
    candidate_groups: candidateGroups.length,
    proposals_written: proposals.length,
    proposals,
    dry,
  };
}
