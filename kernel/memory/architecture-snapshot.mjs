/**
 * Nova Kernel — 架构自动快照
 * kernel/memory/architecture-snapshot.mjs
 *
 * 【问题】Driver Claude 每次优化 Nova 代码（拆 handler / 加 pipeline / 改模型）
 *         后，Codex / Antigravity 不知道新状态 —— 因为它们不跑 Nova 代码，只读
 *         记忆文件 AGENTS.md / GEMINI.md。
 *
 * 【解决】启动时 + 定时扫描核心文件，生成一条固定 id 的 project 记忆
 *         `nova-architecture-current`，覆盖更新。四方同步机制自动推到
 *         AGENTS.md / GEMINI.md / Claude md，让所有 AI 永远看到"Nova 当前长什么样"。
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();

function _safeRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

function _countLines(p) {
  try { return readFileSync(p, 'utf8').split('\n').length; } catch { return 0; }
}

function _listFiles(dir, filter) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(filter).sort();
  } catch { return []; }
}

/**
 * 扫描 Nova 项目，生成架构快照
 */
export function buildArchitectureSnapshot() {
  const lines = [];

  // 1. 内核核心
  lines.push('## 内核核心文件');
  const coreFiles = [
    'kernel/server.js',
    'kernel/workers/ai-executor.mjs',
    'kernel/workers/providers.mjs',
    'kernel/workers/worker-guard.mjs',
    'kernel/workers/codex-verify.mjs',
    'kernel/router/intent-router.mjs',
    'kernel/council/async-council.mjs',
    'kernel/pipeline/pipeline.mjs',
    'kernel/memory/memory-writer.mjs',
    'kernel/memory/memory-sync.mjs',
    'kernel/utils/l3-gate.mjs',
  ];
  for (const f of coreFiles) {
    const full = join(ROOT, f);
    if (existsSync(full)) {
      lines.push(`- ${f}: ${_countLines(full)} 行`);
    }
  }

  // 2. HTTP Handlers（server/handlers/ 目录）
  lines.push('');
  lines.push('## HTTP Handler 模块');
  const handlers = _listFiles(join(ROOT, 'kernel/server/handlers'), f => f.endsWith('.mjs'));
  handlers.forEach(f => lines.push(`- handlers/${f}: ${_countLines(join(ROOT, 'kernel/server/handlers', f))} 行`));

  // 3. Pipeline 模板
  lines.push('');
  lines.push('## Pipeline 模板（pipeline.mjs 里 export 的函数）');
  const pipelineText = _safeRead(join(ROOT, 'kernel/pipeline/pipeline.mjs'));
  const templates = [...pipelineText.matchAll(/^export function (\w+)\(/gm)].map(m => m[1]);
  templates.forEach(t => lines.push(`- ${t}`));

  // 4. MCP 工具（nova-mcp.mjs 里的 name 字段）
  lines.push('');
  lines.push('## MCP 工具（Driver Claude / Codex / Antigravity 都能通过 MCP 调）');
  const mcpText = _safeRead(join(ROOT, 'bin/nova-mcp.mjs'));
  const tools = [...mcpText.matchAll(/name:\s*'(nova_\w+)'/g)].map(m => m[1]);
  tools.forEach(t => lines.push(`- ${t}`));

  // 5. 产品适配器
  lines.push('');
  lines.push('## 产品适配器');
  const products = _listFiles(join(ROOT, 'products'), () => true);
  for (const p of products) {
    const adapter = join(ROOT, 'products', p, 'adapter.mjs');
    if (existsSync(adapter)) {
      const content = _safeRead(adapter);
      const methods = [...content.matchAll(/async (\w+)\(payload\)/g)].map(m => m[1]).filter(n => n !== '_run' && n !== '_executeMethod');
      lines.push(`- ${p}: ${methods.length ? methods.join(', ') : '(骨架)'}`);
    }
  }

  // 6. 启用的模型
  lines.push('');
  lines.push('## 启用的模型（Antigravity ag-bridge :11435 路径）');
  lines.push('- antigravity-claude-opus-4-6-thinking (深度推理/架构)');
  lines.push('- antigravity-claude-sonnet-4-6 (代码实现)');
  lines.push('- antigravity-gemini-3.1-pro-high (分析/长文档)');
  lines.push('- antigravity-gemini-3-flash (快速分类)');

  // 7. 外部 AI 团队
  lines.push('');
  lines.push('## 团队分工（四方闭环）');
  lines.push('- Driver Claude (Claude Code) = 项目总负责 / 最终审核');
  lines.push('- Worker Claude Opus Thinking = 深度规划 / 冲突仲裁');
  lines.push('- Worker Claude Sonnet 4.6 = 代码实现');
  lines.push('- Worker Gemini 3.1 Pro High = 分析 / 长文档');
  lines.push('- Codex CLI (本机 OAuth) = 受控执行器 / 代码审查 / 修 bug');

  // 8. 时间戳
  lines.push('');
  lines.push(`## 快照时间：${new Date().toISOString()}`);

  return lines.join('\n');
}

/**
 * 把快照写入一条固定 id 的 project 记忆
 * （固定 name = 'nova-architecture-current' 确保覆盖更新而不是追加）
 */
export async function updateArchitectureSnapshot() {
  try {
    const body = buildArchitectureSnapshot();
    // 治本 (2026-04-19): 改用 upsertSnapshot — 抹除所有同 name 历史行,
    // 文件大小恒定(原 30min 一次累积上千 dead 行)。纯快照不需要历史追溯。
    const { upsertSnapshot } = await import('./memory-writer.mjs');
    return upsertSnapshot({
      type:        'project',
      name:        'nova-architecture-current',
      description: 'Nova 当前架构快照（自动生成，每次内核启动/doctor 触发更新）',
      body,
      source:      'arch-snapshot-auto',
      confidence:  1.0,
      module:      'nova-kernel',
    });
  } catch (e) {
    console.warn('[arch-snapshot] 生成失败:', e.message);
    return null;
  }
}
