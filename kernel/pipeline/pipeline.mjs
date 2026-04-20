/**
 * Nova Kernel — 分工协作流水线
 * kernel/pipeline/pipeline.mjs
 *
 * 【综合 Gemini Pro + Claude Opus 建议】
 * 不再"三方对同一问题表决"，而是按任务生命周期分工：
 *   Plan (Driver 规划) → Design (模型出方案) → Implement (模型生成) → Verify (Codex 执行) → Review (Driver 终审)
 *
 * 但不僵化五阶段。支持按任务类型自定义阶段序列：
 *   - 简单内容生成 : [Driver → Gemini → Driver 快审]
 *   - 代码任务     : [Driver → Opus 规划 → Gemini 实现 → Codex 验证 → Driver 深审]
 *   - 架构决策     : [Driver → Opus 深思 → Gemini 补充视角 → Driver 仲裁]
 *
 * 默认串行执行（避 429）。如果 stage 声明了 `depends_on: string[]`，则走拓扑批次调度：
 *   - 同一批（所有依赖都已完成）的 stage 用 Promise.all 并发
 *   - 批与批之间仍保留 STAGE_INTERVAL_MS 的节流
 *   - 任一 stage 都未声明 depends_on 时，退化为原顺序（向后兼容）
 *
 * Prompt 膨胀防护（Opus 指出的隐性风险）：
 *   - 每阶段 prompt 预估 token 数，超过 60k 字符（~15k tokens）警告
 *   - 超过 100k 字符强制截断前序产出到摘要
 */

import { executeWithAI } from '../workers/ai-executor.mjs';
import { runCommand, runCodexExec, runCodexReview, runCodexFix } from '../workers/codex-verify.mjs';
import { auditLog } from '../audit/audit.js';

const PROMPT_WARN_CHARS  = 60_000;   // ≈15k tokens
const PROMPT_HARD_CHARS  = 100_000;  // 硬上限，超过截断前序产出
const STAGE_INTERVAL_MS  = 2000;     // 两阶段间隔（避免 ag-bridge 429）

// 预设模型（语义化名字 → Antigravity 真模型）
const MODEL_ALIASES = {
  'gemini-pro-high':  { provider: 'google',    model: 'antigravity-gemini-3.1-pro-high' },
  'claude-opus':      { provider: 'anthropic', model: 'antigravity-claude-opus-4-6-thinking' },
  'claude-sonnet':    { provider: 'anthropic', model: 'antigravity-claude-sonnet-4-6' },
  'gemini-flash':     { provider: 'google',    model: 'antigravity-gemini-3-flash' },
};

function _resolveModel(alias) {
  return MODEL_ALIASES[alias] || { provider: 'google', model: 'antigravity-gemini-3.1-pro-high' };
}

/**
 * 执行一个 LLM 阶段
 */
async function _runLlmStage(stage, context) {
  const { model: alias, prompt: promptTpl, task_type = 'chat', timeout_ms = 60_000 } = stage;
  const { provider, model } = _resolveModel(alias);

  // 把前序产出拼入 prompt（按 stage.inputs 指定）
  // 【v2 改进】明示"这是另一个 AI 的产出"让 worker 正确定位，避免误认为是用户输入
  let builtPrompt = promptTpl;
  if (stage.inputs && Array.isArray(stage.inputs) && stage.inputs.length > 0) {
    const stageToModel = {
      'plan':      'Claude Opus Thinking',
      'design':    'Claude Opus Thinking',
      'implement': 'Claude Sonnet 4.6',
      'opinion_opus':   'Claude Opus Thinking',
      'opinion_gemini': 'Gemini 3.1 Pro High',
      'verify':    'Codex CLI',
    };
    const carried = stage.inputs.map(key => {
      const v = context.outputs[key];
      if (v === undefined) return '';
      const author = stageToModel[key] || `上一阶段 ${key}`;
      const content = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      return `┌─── 前序产出：${key}（来自 ${author}）────\n${content}\n└──────────────────────────────────`;
    }).filter(Boolean).join('\n\n');
    if (carried) {
      builtPrompt = [
        '【流水线上下文 — 由 Driver Claude 组装】',
        carried,
        '',
        '【你的任务】',
        builtPrompt,
      ].join('\n');
    }
  }

  // Prompt 膨胀防护
  if (builtPrompt.length > PROMPT_HARD_CHARS) {
    // 截断前序：保留首 30% + 尾 30%，中间标 [...truncated...]
    const keep = Math.floor(PROMPT_HARD_CHARS * 0.3);
    builtPrompt = builtPrompt.slice(0, keep) + '\n\n[...中段已截断防止 prompt 爆炸...]\n\n' + builtPrompt.slice(-keep);
    console.warn(`[pipeline] stage ${stage.name} prompt 截断（原 ${builtPrompt.length} 字符 > ${PROMPT_HARD_CHARS}）`);
  } else if (builtPrompt.length > PROMPT_WARN_CHARS) {
    console.warn(`[pipeline] stage ${stage.name} prompt 偏大（${builtPrompt.length} 字符）`);
  }

  const result = await executeWithAI({
    task_id:         `pipeline-${context.pipeline_id}-${stage.name}`,
    prompt:          builtPrompt,
    worker:          provider,
    suggested_model: model,
    task_type,
    complexity:      3,
    timeout_ms,
    mode:            'worker',
  });
  return {
    ok:        result.ok,
    output:    result.output,
    error:     result.error,
    model:     result.model || model,
    time_ms:   result.time_ms,
    prompt_chars: builtPrompt.length,
  };
}

/**
 * 执行一个 Codex 验证阶段
 */
async function _runCodexStage(stage, context) {
  const { cwd, command, expectExit = 0, timeoutMs = 60_000 } = stage;
  if (!cwd) return { ok: false, error: 'codex stage: cwd 必填' };
  if (!command) return { ok: false, error: 'codex stage: command 必填' };
  const r = await runCommand({ cwd, command, expectExit, timeoutMs });
  return {
    ok:        r.passed,
    output:    `exit=${r.exit_code} elapsed=${r.elapsed_ms}ms\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    passed:    r.passed,
    exit_code: r.exit_code,
    stdout:    r.stdout,
    stderr:    r.stderr,
  };
}

/**
 * 执行单个 stage（不含审计、trace 拼接——调用方负责）
 * 返回 { result, stage_ms }
 */
async function _executeStage(stage, context) {
  const t0 = Date.now();
  let result;
  try {
    if (stage.kind === 'llm') {
      result = await _runLlmStage(stage, context);
    } else if (stage.kind === 'codex') {
      result = await _runCodexStage(stage, context);
    } else if (stage.kind === 'codex-review') {
      const r = await runCodexReview({
        cwd: stage.cwd,
        focusInstruction: stage.focusInstruction || '',
        timeoutMs: stage.timeoutMs || 180_000,
      });
      result = { ok: r.ok, output: r.stdout + (r.stderr ? ('\n[stderr]\n' + r.stderr) : ''), exit_code: r.exit_code };
    } else if (stage.kind === 'codex-fix') {
      // 把 plan 阶段的规划拼到 Codex issue 里
      let enhancedIssue = stage.issue || '';
      if (stage.inputs && stage.inputs.length > 0) {
        const plan = stage.inputs.map(k => context.outputs[k]).filter(Boolean).join('\n\n');
        if (plan) enhancedIssue = `${enhancedIssue}\n\n【前置规划（Claude Opus 出）】\n${plan}`;
      }
      const r = await runCodexFix({
        cwd: stage.cwd,
        issue: enhancedIssue,
        testCommand: stage.testCommand,
        model: stage.model,
        timeoutMs: stage.timeoutMs || 300_000,
      });
      result = { ok: r.ok, output: r.stdout + (r.stderr ? ('\n[stderr]\n' + r.stderr) : ''), exit_code: r.exit_code };
    } else if (stage.kind === 'driver') {
      // Driver 自审阶段：不跑 LLM，把当前 context.outputs 返回让外层（驾驶员 Claude）处理
      result = { ok: true, output: '[driver review — Driver 处理]', driver_stage: true };
    } else {
      result = { ok: false, error: `unknown stage kind: ${stage.kind}` };
    }
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  return { result, stage_ms: Date.now() - t0 };
}

/**
 * 按 depends_on 做拓扑批次调度，返回 Array<Stage[]>（每批内部可并发）。
 *
 * 行为：
 *   - 任一 stage 都没声明非空 depends_on 时，退化成 stages.map(s => [s])（向后兼容，原顺序）
 *   - 否则按拓扑排序分批；同一批是"所有依赖都已完成"的剩余 stages
 *   - 批内顺序保持 stages 数组中的原始顺序（trace 可读性）
 *   - 依赖不存在 / 成环时抛错
 */
function _buildWaves(stages) {
  const hasAnyDepends = stages.some(s => Array.isArray(s.depends_on) && s.depends_on.length > 0);
  if (!hasAnyDepends) {
    return stages.map(s => [s]);
  }

  const stageNames = new Set(stages.map(s => s.name));
  for (const s of stages) {
    const deps = s.depends_on || [];
    for (const d of deps) {
      if (!stageNames.has(d)) {
        throw new Error(`pipeline: stage "${s.name}" 依赖不存在的 stage "${d}"`);
      }
      if (d === s.name) {
        throw new Error(`pipeline: stage "${s.name}" 不能依赖自己`);
      }
    }
  }

  const completed = new Set();
  const pending = new Set(stages.map(s => s.name));
  const waves = [];

  while (pending.size > 0) {
    const ready = stages.filter(s =>
      pending.has(s.name) && (s.depends_on || []).every(d => completed.has(d))
    );
    if (ready.length === 0) {
      throw new Error(`pipeline: 检测到依赖环或死锁，剩余 stages: ${[...pending].join(', ')}`);
    }
    waves.push(ready);
    for (const s of ready) {
      completed.add(s.name);
      pending.delete(s.name);
    }
  }
  return waves;
}

/**
 * 运行一个 pipeline
 *
 * @param {object} opts
 * @param {string} opts.title                  流水线说明
 * @param {Array<Stage>} opts.stages
 *   Stage = {
 *     name: 'plan' | 'design' | ...,
 *     kind: 'llm' | 'codex' | 'driver',  (driver 型由调用方在外层处理，这里只跑 llm/codex)
 *     model?: 'gemini-pro-high'|'claude-opus'|...,  (llm only)
 *     prompt?: string,  (llm only)
 *     inputs?: string[],  (前序阶段 name 列表，用于拼接 prompt)
 *     depends_on?: string[],  (调度依赖：所有列出的 stage 完成后本 stage 才调度；同批无依赖的 stages 并发执行)
 *     cwd?, command?, expectExit?, timeoutMs?  (codex only)
 *     task_type?: string,  (llm only)
 *   }
 * @param {string} [opts.operator]
 * @returns {Promise<{ok, pipeline_id, stages: {...}, final_output, elapsed_ms}>}
 */
export async function runPipeline({ title = '', stages, operator = 'driver' }) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error('pipeline: stages 必须是非空数组');
  }

  const pipeline_id = `pipe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const context = { pipeline_id, outputs: {}, started_at: Date.now() };
  const trace = [];

  const waves = _buildWaves(stages);
  const parallel = waves.some(w => w.length > 1);

  auditLog({
    event: 'pipeline.start',
    operator,
    target: pipeline_id,
    detail: {
      title,
      stage_count: stages.length,
      wave_count: waves.length,
      parallel,
      stages: stages.map(s => ({ name: s.name, kind: s.kind, model: s.model, depends_on: s.depends_on })),
    },
  });

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx];

    // 并发执行本批所有 stage；_executeStage 不抛（内部已 try/catch）
    const waveResults = await Promise.all(wave.map(stage => _executeStage(stage, context)));

    // 按原顺序写 trace + outputs
    let firstFailure = null;
    for (let i = 0; i < wave.length; i++) {
      const stage = wave[i];
      const { result, stage_ms } = waveResults[i];
      trace.push({ name: stage.name, kind: stage.kind, ok: result.ok, stage_ms, model: result.model, error: result.error });
      if (result.output !== undefined) context.outputs[stage.name] = result.output;
      if (!result.ok && !stage.continue_on_fail && !firstFailure) {
        firstFailure = { stage, result };
      }
    }

    if (firstFailure) {
      auditLog({
        event: 'pipeline.failed',
        operator,
        target: pipeline_id,
        detail: { failed_stage: firstFailure.stage.name, reason: firstFailure.result.error?.slice(0, 300) },
      });
      return {
        ok: false,
        pipeline_id,
        failed_at: firstFailure.stage.name,
        trace,
        outputs: context.outputs,
        error: firstFailure.result.error,
        elapsed_ms: Date.now() - context.started_at,
      };
    }

    // 批间节流（避开 ag-bridge 429）：若本批或下批有 llm，等一下
    if (waveIdx < waves.length - 1) {
      const currentHasLlm = wave.some(s => s.kind === 'llm');
      const nextHasLlm = waves[waveIdx + 1].some(s => s.kind === 'llm');
      if (currentHasLlm || nextHasLlm) {
        await new Promise(r => setTimeout(r, STAGE_INTERVAL_MS));
      }
    }
  }

  const lastName = stages[stages.length - 1].name;
  auditLog({
    event: 'pipeline.complete',
    operator,
    target: pipeline_id,
    detail: { title, stage_count: stages.length, wave_count: waves.length, parallel, elapsed_ms: Date.now() - context.started_at },
  });

  return {
    ok: true,
    pipeline_id,
    trace,
    outputs: context.outputs,
    final_output: context.outputs[lastName],
    elapsed_ms: Date.now() - context.started_at,
  };
}

// ─── 预设 Pipeline 模板 ────────────────────────────────────────────────────

/**
 * 代码任务标准流水线（用户反馈：Gemini 不适合代码，改用 Claude 全程）：
 *   1. plan      : Claude Opus Thinking  — 深度规划（步骤/风险/关键文件）
 *   2. implement : Claude Sonnet 4.6      — 代码生成（实测 Claude 代码能力 > Gemini）
 *   3. verify    : Codex CLI (受控)       — 跑测试/检查
 *   4. review    : Driver (我)            — 终审
 */
export function codeTaskPipeline({ requirement, cwd, testCommand, expectExit }) {
  return [
    {
      name: 'plan',
      kind: 'llm',
      model: 'claude-opus',
      task_type: 'review',
      prompt: `请为以下需求设计实现方案：列出 3-5 个关键步骤、潜在风险、需改的文件路径。不要写代码，只出规划。\n\n需求：${requirement}`,
    },
    {
      name: 'implement',
      kind: 'llm',
      model: 'claude-sonnet',        // ← 从 gemini-pro-high 改成 Claude Sonnet（代码更强）
      task_type: 'codegen',
      inputs: ['plan'],
      prompt: `根据 plan 阶段的规划，实现完整代码。直接输出代码块（带语言标签 + 文件名注释），必要时附简短说明。原需求：${requirement}`,
    },
    ...(testCommand ? [{
      name: 'verify',
      kind: 'codex',
      cwd,
      command: testCommand,
      expectExit: expectExit ?? 0,
      timeoutMs: 120_000,
    }] : []),
    {
      name: 'review',
      kind: 'driver',
      // driver 阶段由外层调用者（驾驶员 Claude）接管
    },
  ];
}

/**
 * Codex 修 bug 流水线：Opus 规划 + Codex 自主修 + Driver 审 diff
 *   1. plan     : Claude Opus Thinking  — 分析问题 + 给 Codex 写明确指令
 *   2. fix      : Codex (runCodexFix)    — 自主读代码、修、跑测试
 *   3. review   : Driver                  — 审 diff 决定 apply/revert
 */
export function codexFixPipeline({ issue, cwd, testCommand }) {
  return [
    {
      name: 'plan',
      kind: 'llm',
      model: 'claude-opus',
      task_type: 'review',
      prompt: `有以下 bug 需要 Codex CLI 自主修复。请你先分析这个 bug：(1) 可能的根因 2-3 条 (2) 应该先读哪些文件 (3) 给 Codex 的简洁指令（<=200 字符）。只出分析，不要自己写代码。\n\nBug：${issue}`,
    },
    {
      name: 'fix',
      kind: 'codex-fix',
      cwd,
      issue,
      testCommand,
      inputs: ['plan'],  // pipeline 会把 plan 拼进 Codex 的 prompt
      timeoutMs: 300_000,
    },
    {
      name: 'review',
      kind: 'driver',
    },
  ];
}

/**
 * Codex Review 流水线（Codex 先审，Opus 再复审）
 */
export function codexReviewPipeline({ cwd, focusInstruction }) {
  return [
    {
      name: 'codex-review',
      kind: 'codex-review',
      cwd,
      focusInstruction,
      timeoutMs: 180_000,
    },
    {
      name: 'opus-meta',
      kind: 'llm',
      model: 'claude-opus',
      task_type: 'review',
      inputs: ['codex-review'],
      prompt: '上面是 Codex 的初审。请用一句话总结"最严重的问题"；再用一句话指出"Codex 可能漏掉的大角度"。',
    },
  ];
}

/**
 * 双模型辩论流水线（两个意见并发出，Driver 仲裁）
 *
 * opinion_opus + opinion_gemini 均无 depends_on，所以在 wave 0 并发执行；
 * arbitration 等两家意见都回来再走。总耗时 ≈ max(opus, gemini) 而不是 sum。
 */
export function debatePipeline({ question }) {
  return [
    {
      name: 'opinion_opus',
      kind: 'llm',
      model: 'claude-opus',
      task_type: 'review',
      prompt: `请简明回答这个问题，直接给结论 + 3 个理由：\n${question}`,
    },
    {
      name: 'opinion_gemini',
      kind: 'llm',
      model: 'gemini-pro-high',
      task_type: 'analysis',
      inputs: [],
      prompt: `请独立回答（不要看别人的答案）：\n${question}`,
    },
    {
      name: 'arbitration',
      kind: 'driver',
      depends_on: ['opinion_opus', 'opinion_gemini'],
    },
  ];
}
