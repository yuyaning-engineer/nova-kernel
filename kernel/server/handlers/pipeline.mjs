/**
 * Pipeline Handlers
 * kernel/server/handlers/pipeline.mjs
 *
 * 分工协作流水线 HTTP 端点：
 *   POST /pipeline/run            — 执行自定义 pipeline
 *   POST /pipeline/code-task      — 代码任务预设流水线（plan → implement → verify → driver review）
 *   POST /pipeline/debate         — 双模型辩论流水线（Driver 仲裁）
 *   POST /codex/run               — 受控 Codex 命令执行（返回 stdout/stderr/exit）
 */

import { runPipeline, codeTaskPipeline, debatePipeline, codexFixPipeline, codexReviewPipeline } from '../../pipeline/pipeline.mjs';
import { runCommand, runCodexExec, runCodexReview, runCodexFix, probeCodex } from '../../workers/codex-verify.mjs';
import { readBody, send, sendError, assertInternalAuth, resolveSource } from '../utils.mjs';

export async function handlePipelineRun(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!Array.isArray(body.stages)) return sendError(res, 400, 'stages 必须是数组');
    const result = await runPipeline({
      title:    body.title,
      stages:   body.stages,
      operator: body.operator || `source:${resolveSource(req)}`,
    });
    send(res, 200, result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

export async function handlePipelineCodeTask(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.requirement) return sendError(res, 400, 'requirement 必填');
    const stages = codeTaskPipeline({
      requirement:  body.requirement,
      cwd:          body.cwd,
      testCommand:  body.test_command,
      expectExit:   body.expect_exit,
    });
    const result = await runPipeline({
      title:    body.title || 'code-task',
      stages,
      operator: body.operator || `source:${resolveSource(req)}`,
    });
    send(res, 200, result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

export async function handlePipelineDebate(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.question) return sendError(res, 400, 'question 必填');
    const stages = debatePipeline({ question: body.question });
    const result = await runPipeline({
      title:    'debate',
      stages,
      operator: body.operator || `source:${resolveSource(req)}`,
    });
    send(res, 200, result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

export async function handleCodexRun(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (body.mode === 'exec') {
      // 自主 exec 模式（慎用，Codex 会自由跑）
      if (!body.cwd || !body.prompt) return sendError(res, 400, 'exec 模式需 cwd + prompt');
      const r = await runCodexExec({
        cwd:       body.cwd,
        prompt:    body.prompt,
        model:     body.model,
        timeoutMs: body.timeout_ms || 180_000,
      });
      return send(res, 200, { ok: r.ok, ...r });
    }
    // 默认：受控命令模式
    if (!body.cwd || !body.command) return sendError(res, 400, '需 cwd + command 数组');
    const r = await runCommand({
      cwd:        body.cwd,
      command:    body.command,
      expectExit: body.expect_exit ?? 0,
      timeoutMs:  body.timeout_ms || 60_000,
    });
    send(res, 200, { ok: r.passed, ...r });
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

export async function handleCodexProbe(req, res) {
  if (!assertInternalAuth(req, res)) return;
  const r = await probeCodex();
  send(res, 200, r);
}

export async function handlePipelineCodexFix(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.issue) return sendError(res, 400, 'issue 必填');
    if (!body.cwd) return sendError(res, 400, 'cwd 必填（Codex 需要工作目录）');
    const stages = codexFixPipeline({ issue: body.issue, cwd: body.cwd, testCommand: body.test_command });
    const result = await runPipeline({
      title: 'codex-fix',
      stages,
      operator: body.operator || `source:${resolveSource(req)}`,
    });
    send(res, 200, result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}

export async function handlePipelineCodexReview(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const body = await readBody(req);
    if (!body.cwd) return sendError(res, 400, 'cwd 必填');
    const stages = codexReviewPipeline({ cwd: body.cwd, focusInstruction: body.focus });
    const result = await runPipeline({
      title: 'codex-review',
      stages,
      operator: body.operator || `source:${resolveSource(req)}`,
    });
    send(res, 200, result);
  } catch (err) {
    sendError(res, 500, err.message);
  }
}
