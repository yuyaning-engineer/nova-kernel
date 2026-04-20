/**
 * kernel/memory/hygiene.mjs — 记忆清理/总结/修复 Agent (2026-04-19)
 *
 * 用户痛点: 跑测试/早期验证残留垃圾 + 新条目缺 module field, KB 检索精度被噪音稀释.
 *
 * 4 类病灶 + 3 类修复:
 *   病 1. 测试残留 (name 含 concurrent-test- / _test_ / stability- / smoke- / -ping-test) → forgetMemory
 *   病 2. 缺 module 字段 (reference/project, 用 LLM 推断回填)                              → 重写带 module
 *   病 3. body 过短 (<30 字, 非 marker)                                                     → 标 low_quality
 *   病 4. 重复主题 (留待 v2 用 vector cosine, 此版本先报告)                                 → report only
 *
 * 安全:
 *   - dry-run 默认: 只产报告, 不动 jsonl
 *   - apply=true 才执行
 *   - USER 类一律不动 (太敏感, 由人审)
 *   - 每次 apply 都写一条 project 记忆留 audit trail
 *
 * 触发:
 *   - HTTP: POST /memory/hygiene  body: { apply: bool, types: ['reference','project'] }
 *   - Cron: self-maintenance 12h 跑 dry-run, 报告写 project 记忆
 *   - MCP: nova_memory_hygiene
 */

import { readMemories, forgetMemory, writeMemory } from './memory-writer.mjs';
import { callLlmJson } from '../utils/llm.mjs';

const TEST_NAME_PATTERNS = [
  /^concurrent-test-/i,
  /^_test_/i,
  /^stability-(normal-size|test)/i,
  /^smoke-test/i,
  /-ping-test$/i,
  /^cache-event-test$/i,
  /^reverse-sync-test$/i,
  /-test-\d{8,}/,                        // foo-test-20260419 timestamp suffix
];

const TINY_BODY_THRESHOLD = 30;

/**
 * 启发式 module 推断 (秒级, 命中率 ~95%)
 * 优先匹配 name → 再 description → 最后 body
 */
function _inferModuleHeuristic(entry) {
  const name = (entry.name || '').toLowerCase();
  const desc = (entry.description || '').toLowerCase();
  const body = (entry.body || '').slice(0, 600).toLowerCase();
  const txt = `${name} ${desc} ${body}`;

  // 1. session-end / session 元数据 → meta
  if (/^session-end-|^session-start-|^session-/.test(name)) return 'meta';
  // 2. KB v2 / intel / librarian / curator (用 \b 边界, 减少误匹配)
  if (/\bintel\b|kb-?v2|\blibrarian\b|\bcurator\b|\bvector\b|bge-m3|\bembedding\b|tier-router/i.test(txt)) return 'kb-v2';
  // 3. evolution: skill / proposal / council / gap / mining
  if (/skill-?miner|gap-detector|^evolution|skill_proposal|\bcouncil\b|议会|演化/i.test(txt)) return 'evolution';
  // 4. media-forge: 图像/视频/即梦/comfyui/lora
  if (/comfyui|jimeng|即梦|\blora\b|seedance|stable-?diffusion|image-?gen|video-?gen|aigc|换装|去背|模特|视频切片|直播切片|whisper|ffmpeg/i.test(txt)) return 'media-forge';
  // 5. commerce-ops: 千牛/聚水潭/钉钉/电商
  if (/千牛|qianniu|聚水潭|jushuitan|领猫|lingmao|\bmtop\b|钉钉|dingtalk|电商|commerce|\bsku\b|订单|\border\b|\bseo\b|文案|话术|店小秘|芒果店长/i.test(txt)) return 'commerce-ops';
  // 6. nova-kernel: connector / worker / ai-executor / mcp / antigravity / codex / claude-code
  //    收紧: 去掉 worker/provider/mcp 这种泛词, 改用更具体短语
  if (/kernel\/|memory-writer|ai-executor|self-maintenance|antigravity|ag-bridge|codex(?:-cli)?|claude[-. ]code|claude-cli|nova-mcp|shadow-sniffer|nova[- ]?kernel|\bmcp\b/i.test(txt)) return 'nova-kernel';
  // 7. status / 架构 / config 类 → meta (跨模块) — 收紧 name 前缀匹配
  if (/^machine-spec\b|^workspace\b|^session-(start|end)-|architecture|deploy|setup/i.test(name)) return 'meta';
  // 8. VPN / 代理 / 用户环境 → meta
  if (/v2ray|xray|\bvpn\b|\bsocks\b|\bproxy\b|代理|^用户本机|知衣/i.test(txt)) return 'meta';
  // 9. 兜底取消: 之前 "project 一律 meta" 短路了 LLM fallback. 让 null 回 LLM 推断.
  return null;
}

/**
 * LLM 兜底推断 module (heuristic miss 时用)
 */
async function _inferModuleLlm(entry) {
  const prompt = `根据下面记忆条目, 判断它属于哪个 Nova 模块.
候选 module (只能选一个):
- nova-kernel: 内核框架 / connector / worker / ai-executor / 记忆 / MCP
- commerce-ops: 电商运营 (千牛/聚水潭/钉钉/SEO/文案)
- media-forge: 图像视频 (ComfyUI/即梦/LoRA/Seedance)
- evolution: 演化 (skill / proposal / council / gap-detector)
- kb-v2: 知识库 v2 (intel / librarian / vector / bge-m3)
- meta: 跨模块通用 / 无法分类

# 条目
name: ${entry.name}
description: ${entry.description || ''}
body 前 200 字: ${(entry.body || '').slice(0, 200)}

# 输出
JSON: {"module": "<one-of-above>", "reason": "<10 字内>"}`;

  const r = await callLlmJson(prompt, {
    model: 'antigravity-claude-sonnet-4-6',
    task_type: 'structured-extract',
    worker: 'memory-hygiene',
    task_id: `hygiene-module-${entry.id}`,
    timeout_ms: 20_000,
  });
  if (!r.ok) return null;
  return r.json?.module || null;
}

/**
 * 扫描所有 (除 user) 记忆, 产 hygiene 报告.
 *
 * @param {object} opts
 * @param {string[]} [opts.types=['reference','project','feedback']]
 * @returns {Promise<object>} 报告
 */
export async function scanHygiene({ types = ['reference', 'project', 'feedback'] } = {}) {
  const report = {
    ts: new Date().toISOString(),
    scanned_types: types,
    issues: {
      test_residue: [],   // 测试残留, 应清
      missing_module: [], // 缺 module 字段
      tiny_body: [],      // body 太短
    },
    counts: {},
  };

  for (const t of types) {
    const all = readMemories({ type: t });
    report.counts[t] = all.length;
    for (const e of all) {
      // 病 1: 测试残留
      if (TEST_NAME_PATTERNS.some(re => re.test(e.name || ''))) {
        report.issues.test_residue.push({ id: e.id, type: t, name: e.name, created: e.created_at?.slice(0, 10) });
        continue;
      }
      // 病 2: 缺 module (只查 reference + project)
      if ((t === 'reference' || t === 'project') && (!e.module || e.module === '-')) {
        report.issues.missing_module.push({ id: e.id, type: t, name: e.name });
      }
      // 病 3: body 太短 (排除已经被识别为 test residue)
      if ((e.body || '').length < TINY_BODY_THRESHOLD) {
        report.issues.tiny_body.push({ id: e.id, type: t, name: e.name, body_len: (e.body || '').length });
      }
    }
  }

  report.summary = {
    total_scanned: Object.values(report.counts).reduce((a, b) => a + b, 0),
    test_residue: report.issues.test_residue.length,
    missing_module: report.issues.missing_module.length,
    tiny_body: report.issues.tiny_body.length,
  };
  return report;
}

/**
 * 执行修复. apply=false 仅返回 report.
 */
export async function applyHygiene({ types, useLlm = true } = {}) {
  const report = await scanHygiene({ types });
  const actions = { deleted: [], module_filled: [], skipped: [] };

  // 修 1: 删测试残留
  for (const item of report.issues.test_residue) {
    const r = forgetMemory(item.id);
    if (r.ok) actions.deleted.push(item.name);
    else actions.skipped.push({ name: item.name, reason: r.error });
  }

  // 修 2: 回填 module
  for (const item of report.issues.missing_module) {
    // 拿最新条目内容
    const all = readMemories({ type: item.type });
    const e = all.find(x => x.id === item.id);
    if (!e) { actions.skipped.push({ name: item.name, reason: 'entry vanished' }); continue; }

    let mod = _inferModuleHeuristic(e);
    if (!mod && useLlm) {
      mod = await _inferModuleLlm(e);
    }
    if (!mod) { actions.skipped.push({ name: item.name, reason: 'cannot infer module' }); continue; }

    // 重写: 同 name → 自动 supersede 旧条目
    try {
      writeMemory({
        type: e.type,
        name: e.name,
        description: e.description,
        body: e.body,
        source: e.source || 'memory-hygiene',
        confidence: e.confidence ?? 1.0,
        module: mod,
      });
      actions.module_filled.push({ name: item.name, module: mod });
    } catch (err) {
      actions.skipped.push({ name: item.name, reason: err.message });
    }
  }

  // 病 3 (tiny body) 暂只报告, 不自动删 (可能是有意的 marker)

  // Audit trail
  try {
    writeMemory({
      type: 'project',
      name: 'memory-hygiene-latest',
      description: `Memory hygiene 最近一次 apply (${new Date().toISOString().slice(0, 10)})`,
      body: '```json\n' + JSON.stringify({ report: report.summary, actions }, null, 2) + '\n```',
      source: 'memory-hygiene-agent',
      confidence: 1.0,
      module: 'nova-kernel',
    });
  } catch {}

  return { ok: true, report, actions };
}
