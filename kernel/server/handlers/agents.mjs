/**
 * kernel/server/handlers/agents.mjs — Agent HTTP 路由
 *
 * GET  /agents/list           列出所有注册 agent
 * POST /agents/invoke         调用某个 agent: { name, args, timeout_ms? }
 */

import { send, sendError, readBody, assertInternalAuth } from '../utils.mjs';
import { listAgents, invokeAgent, getAgent } from '../../agents/invoke.mjs';
import { auditLog } from '../../audit/audit.js';
import { writeMemory } from '../../memory/memory-writer.mjs';

export async function handleAgentsList(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const list = listAgents();
    send(res, 200, { ok: true, count: list.length, agents: list });
  } catch (err) { sendError(res, 500, err.message); }
}

export async function handleAgentsInvoke(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(res, 400, 'body 必须是 JSON object');
    }
    const { name, args, timeout_ms } = body;
    if (typeof name !== 'string' || name.trim() === '') {
      return sendError(res, 400, 'name 必填且为非空 string');
    }
    const finalTimeout = (Number.isFinite(timeout_ms) && timeout_ms > 0) ? timeout_ms : undefined;

    const meta = getAgent(name.trim());
    if (!meta) return sendError(res, 404, `未知 agent: ${name}`);

    auditLog({
      event: 'agent.invoke',
      operator: 'agents.handler',
      target: name,
      detail: { module: meta.module, risk_level: meta.risk_level, calling_convention: meta.calling_convention },
    });

    const r = await invokeAgent(name.trim(), args ?? {}, { timeout_ms: finalTimeout });

    // ── 双向闭环 (2026-04-19): 失败 + 成功 都自动反哺 ──────────────────
    // 之前只记 auditLog (低密度查询不到), 现在每次 invoke 都写 feedback,
    // 让 skill-miner 6h cycle 同时学失败 pattern (recovery skill) +
    // 成功 pattern (best-practice skill).
    try {
      const ok = r.ok && (r.exit_code == null || r.exit_code === 0);
      const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');

      if (!ok) {
        // 失败: 高优先级, 全量记
        const errBrief = (r.error || r.stderr || r.stdout_raw || '').toString().slice(0, 280);
        writeMemory({
          type: 'feedback',
          name: `agent-failure-${name}-${ts}`,
          description: `agent ${name} 调用失败 (auto-captured)`,
          body: [
            `**agent**: ${name} (${meta.module}, ${meta.risk_level})`,
            `**calling_convention**: ${meta.calling_convention}`,
            `**args**: ${JSON.stringify(args).slice(0, 200)}`,
            `**exit_code**: ${r.exit_code ?? '-'}`,
            `**time_ms**: ${r.time_ms ?? '-'}`,
            `**error**: ${errBrief}`,
            ``,
            `Why: agent 失败应留痕, skill-miner 下个 6h 会聚类同类失败 → 沉淀 recovery skill.`,
            `How to apply: 同名 agent ≥2 次失败时, 检查 args/env/路径, 可能要升级 connector manifest.`,
          ].join('\n'),
          source: 'agent-failure-telemetry',
          confidence: 0.9,
          module: meta.module,
        });
      } else {
        // 成功: 抽样 (10% 记录, 避免 jsonl 膨胀; 用 task_id 末位的 hex digit 决定)
        const taskHash = (args?.method || JSON.stringify(args || {}).slice(0, 8));
        const sampleBit = parseInt((taskHash.charCodeAt(0) || 0).toString(16).slice(-1), 16);
        if (sampleBit < 2) {  // ~12.5% sampling
          const dataBrief = JSON.stringify(r.data ?? {}).slice(0, 200);
          writeMemory({
            type: 'feedback',
            name: `agent-success-${name}-${ts}`,
            description: `agent ${name} 调用成功 sample (auto-captured)`,
            body: [
              `**agent**: ${name} (${meta.module}, ${meta.risk_level})`,
              `**method**: ${args?.method || '-'}`,
              `**time_ms**: ${r.time_ms ?? '-'}`,
              `**data_preview**: ${dataBrief}`,
              ``,
              `Why: 成功 invocation 抽样存档, 让 skill-miner 学"什么时候这个 agent 真好用".`,
              `How to apply: 高频成功的 agent + method 组合 → 可固化成 task-recipe (e.g. 千牛订单查询 → jushuitan + query_orders_out_simple).`,
            ].join('\n'),
            source: 'agent-success-telemetry',
            confidence: 0.72,  // 略高于 0.7 active 门槛 (telemetry 必须可见)
            module: meta.module,
          });
        }
      }
    } catch { /* 写记忆失败不影响主链路 */ }

    send(res, r.ok ? 200 : 500, r);
  } catch (err) { sendError(res, 500, err.message); }
}
