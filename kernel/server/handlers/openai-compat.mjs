/**
 * OpenAI-compatible API Handlers
 * kernel/server/handlers/openai-compat.mjs
 *
 * 让 AnythingLLM / Cursor / 任何支持自定义 Base URL 的工具，能用 OpenAI 格式调 Nova。
 * Antigravity 模型前缀（antigravity-*）会自动路由到本机 :11435 ag-bridge。
 *
 * POST /v1/chat/completions
 * GET  /v1/models          (动态探测 ag-bridge 可用模型)
 */

import { executeWithAI } from '../../workers/ai-executor.mjs';
import { getLatestModel } from '../../config/model-discovery.mjs';
import { probeAntigravityBridge, probeOllama } from '../../workers/providers.mjs';
import { auditLog } from '../../audit/audit.js';
import { readBody, send, assertInternalAuth, resolveSource } from '../utils.mjs';

export async function handleOpenAICompat(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const source = resolveSource(req);
    const body = await readBody(req);
    const messages = body.messages || [];
    const lastMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastMsg) {
      return send(res, 400, { error: { message: 'No user message in messages array', type: 'invalid_request_error' } });
    }

    // 拼接 system + user 消息
    const systemMsgs = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const prompt = systemMsgs ? `${systemMsgs}\n\n${lastMsg.content}` : lastMsg.content;

    const requestedModel = body.model || 'gemini-flash';
    const isAntigravity = requestedModel.startsWith('antigravity-');
    const isOllama = requestedModel.startsWith('ollama-');
    const isProModel = requestedModel.includes('pro') || requestedModel.includes('sonnet') || requestedModel.includes('opus');

    const worker = isAntigravity ? 'anthropic' :
                   isOllama ? 'openai' :
                   (requestedModel.includes('claude') ? 'claude' : 'gemini');
    const taskType = isProModel ? 'analysis' : 'chat';

    const taskId = `openai-compat-${source}-${Date.now()}`;
    auditLog({
      event: 'openai.compat.request',
      operator: `source:${source}`,
      target: taskId,
      detail: { model: requestedModel, worker, prompt_len: prompt.length, antigravity: isAntigravity, ollama: isOllama },
    });

    const suggestedModel = (isAntigravity || isOllama)
      ? requestedModel
      : getLatestModel(isProModel ? (worker === 'claude' ? 'claude_sonnet' : 'gemini_pro') : 'gemini_flash');

    const result = await executeWithAI({
      task_id: taskId,
      prompt,
      worker,
      suggested_model: suggestedModel,
      task_type: taskType,
      complexity: isProModel ? 3 : 1,
      timeout_ms: 60000,
    });

    if (!result.ok) {
      return send(res, 500, { error: { message: result.error || 'AI execution failed', type: 'server_error' } });
    }

    send(res, 200, {
      id: `chatcmpl-nk-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model || requestedModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.output || '' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil((result.output || '').length / 4),
        total_tokens: Math.ceil((prompt.length + (result.output || '').length) / 4),
      },
    });
  } catch (err) {
    send(res, 500, { error: { message: err.message, type: 'server_error' } });
  }
}

export async function handleOpenAIModels(req, res) {
  if (!assertInternalAuth(req, res)) return;
  const now = Math.floor(Date.now() / 1000);
  const models = [
    { id: getLatestModel('gemini_flash'),   object: 'model', owned_by: 'google',    created: now },
    { id: getLatestModel('gemini_pro'),     object: 'model', owned_by: 'google',    created: now },
    { id: 'gemini-flash',                   object: 'model', owned_by: 'google',    created: now },
    { id: 'gemini-pro',                     object: 'model', owned_by: 'google',    created: now },
    { id: 'claude-sonnet',                  object: 'model', owned_by: 'anthropic', created: now },
  ];

  // 探测 ag-local-bridge 补充 Antigravity 订阅下的模型
  try {
    const agProbe = await probeAntigravityBridge(1500);
    if (agProbe.ok) {
      for (const m of agProbe.models) {
        models.push({ id: m, object: 'model', owned_by: 'antigravity', created: now });
      }
    }
  } catch {}

  try {
    const ollamaProbe = await probeOllama(1500);
    if (ollamaProbe.ok) {
      for (const m of ollamaProbe.models) {
        models.push({ id: `ollama-${m}`, object: 'model', owned_by: 'ollama', created: now });
      }
    }
  } catch {}

  send(res, 200, { object: 'list', data: models });
}
