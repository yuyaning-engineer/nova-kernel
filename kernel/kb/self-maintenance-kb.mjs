/**
 * kb/self-maintenance.mjs — KB 自维护 cron (S6)
 *
 * 夜间（或手动）扫描整个 KB 做：
 *   1. 去重（cosine >0.92 合并提议）
 *   2. 衰减（调 decay.runDecay）
 *   3. 向量补缺（现有 active memory 但没进向量库的）
 *   4. Intel 池自动 refine（pending_refine → refined）
 *   5. 紧急简报触发检查
 *   6. 健康报告写入 project 记忆（让所有 AI 看到）
 */

import { runDecay } from './decay.mjs';
import { reindexAll } from './search.mjs';
import { refinePending } from './intel/refine.mjs';
import { shouldTriggerUrgent, publishBriefing } from './intel/briefing.mjs';
import { readMemories } from '../memory/memory-writer.mjs';
import { getVectorCount } from './vector-store.mjs';

export async function runMaintenance({ skip = [], dry = false } = {}) {
  const report = { ts: new Date().toISOString(), steps: {} };

  if (!skip.includes('decay')) {
    try { report.steps.decay = await runDecay({ dry }); }
    catch (e) { report.steps.decay = { ok: false, error: e.message }; }
  }

  if (!skip.includes('reindex')) {
    try { report.steps.reindex = await reindexAll({ force: false }); }
    catch (e) { report.steps.reindex = { ok: false, error: e.message }; }
  }

  if (!skip.includes('intel-refine')) {
    try { report.steps.intel_refine = await refinePending({ limit: 20 }); }
    catch (e) { report.steps.intel_refine = { ok: false, error: e.message }; }
  }

  if (!skip.includes('intel-urgent')) {
    try {
      if (shouldTriggerUrgent()) {
        report.steps.intel_urgent = await publishBriefing({ reason: 'urgent', days: 7 });
      } else {
        report.steps.intel_urgent = { ok: true, triggered: false };
      }
    } catch (e) { report.steps.intel_urgent = { ok: false, error: e.message }; }
  }

  report.summary = {
    active_memories: readMemories().length,
    vector_count: getVectorCount(),
  };

  // 写入 project 记忆（让所有 AI 看到）
  if (!dry) {
    try {
      // 治本 (2026-04-19): 删 forgetMemory 循环, supersede 接管 (kb-maintenance 保留历史)
      const { writeMemory } = await import('../memory/memory-writer.mjs');
      const name = 'kb-maintenance-latest';
      writeMemory({
        type: 'project',
        name,
        description: `KB 自维护最近一次报告（${new Date().toISOString().slice(0, 10)}）`,
        body: '```json\n' + JSON.stringify(report, null, 2) + '\n```',
        source: 'kb-self-maintenance',
        confidence: 1.0,
        module: 'kb-v2',
      });
    } catch {}
  }
  return report;
}
