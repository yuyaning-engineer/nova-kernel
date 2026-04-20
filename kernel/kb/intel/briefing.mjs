/**
 * kb/intel/briefing.mjs — 定时+事件双触发简报 (S5)
 *
 * 我的仲裁（综合两位同事）：
 *   - 周一早报（cron）— 老板要确定性
 *   - 紧急加塞（≥15 条 pending 触发即时）
 *   - pull（用户主动调 /intel/brief 随时）
 */

import { listIntel, topEntities, getIntelCount } from './ingest.mjs';

const THRESHOLD_URGENT = parseInt(process.env.KB_INTEL_URGENT_N || '15', 10);

export async function generateBriefing({ days = 7, reason = 'manual' } = {}) {
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const items = listIntel({ limit: 500 }).filter(i => i.received_at >= since);
  const refined = items.filter(i => i.status === 'refined' || i.status === 'briefed');
  const entities = {
    kol: topEntities({ kind: 'kol', since, limit: 10 }),
    brand: topEntities({ kind: 'brand', since, limit: 10 }),
    category: topEntities({ kind: 'category', since, limit: 10 }),
    keyword: topEntities({ kind: 'keyword', since, limit: 15 }),
  };

  const bySender = {};
  for (const i of items) bySender[i.sender] = (bySender[i.sender] || 0) + 1;

  const highValue = refined
    .filter(i => i.tags?.decision_value === 'high')
    .slice(0, 10);

  const lines = [
    `# 📥 Intel 简报（${reason === 'weekly' ? '周报' : reason === 'urgent' ? '紧急加塞' : '手动 pull'}）`,
    `_时间窗：最近 ${days} 天 | 生成于 ${new Date().toISOString()}_`,
    '',
    `## 📊 数据概览`,
    `- 总入站：${items.length} 条（refined ${refined.length}，pending ${items.length - refined.length}）`,
    `- 发送人分布：${Object.entries(bySender).map(([k, v]) => `${k}×${v}`).join(', ')}`,
    '',
    `## 🏷️ 实体 Top`,
    `**KOL**：${entities.kol.map(e => `${e.value}(${e.mentions})`).join(', ') || '(无)'}`,
    `**品牌**：${entities.brand.map(e => `${e.value}(${e.mentions})`).join(', ') || '(无)'}`,
    `**品类**：${entities.category.map(e => `${e.value}(${e.mentions})`).join(', ') || '(无)'}`,
    `**关键词**：${entities.keyword.map(e => `${e.value}(${e.mentions})`).join(', ') || '(无)'}`,
    '',
  ];

  if (highValue.length) {
    lines.push(`## 🎯 高价值条目（decision_value=high，${highValue.length} 条）`);
    for (const h of highValue) {
      const r = typeof h.refined === 'string' ? JSON.parse(h.refined) : h.refined;
      lines.push(`- **${r?.summary || h.raw_text?.slice(0, 40)}** — ${r?.reason || ''} [${h.sender}, ${h.received_at?.slice(0, 10)}]`);
      if (h.urls?.length) lines.push(`  - ${h.urls[0]}`);
    }
    lines.push('');
  }

  // 标记已成简报的
  const body = lines.join('\n');
  return {
    ok: true,
    body,
    stats: { items: items.length, refined: refined.length, high_value: highValue.length },
    entities,
    reason,
  };
}

/**
 * 是否该触发紧急简报（>=N 条 pending 或 refined 未归档）
 */
export function shouldTriggerUrgent() {
  const n = getIntelCount({ status: 'refined' }) + getIntelCount({ status: 'pending_refine' });
  return n >= THRESHOLD_URGENT;
}

/**
 * 生成后把简报写进 project 记忆（让所有 AI 看到）
 */
export async function publishBriefing(opts = {}) {
  const b = await generateBriefing(opts);
  if (!b.ok) return b;
  const { writeMemory, readMemories, forgetMemory } = await import('../../memory/memory-writer.mjs');
  const name = `intel-briefing-${opts.reason || 'manual'}`;
  // 覆盖同 name
  const old = readMemories({ type: 'project' }).filter(e => e.name === name);
  for (const o of old) forgetMemory(o.id);
  const entry = writeMemory({
    type: 'project',
    name,
    description: `Intel 简报（${b.stats.items} 条，${b.stats.high_value} 高价值）`,
    body: b.body,
    source: 'intel-briefing',
    confidence: 1.0,
  });
  return { ok: true, entry_id: entry.id, stats: b.stats };
}
