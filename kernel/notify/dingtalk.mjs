/**
 * Nova Kernel — 钉钉通知模块
 * kernel/notify/dingtalk.mjs
 *
 * 职责：
 *   1. 出站通知 — 向钉钉自定义群机器人 Webhook 发送消息（日报/告警/任务结果）
 *   2. 入站解析 — 占位实现（callback 回调需要 AES-128-CBC 解密 + 应用模式，留待 phase 2）
 *
 * 所需环境变量（在 .env 中配置）：
 *   DINGTALK_WEBHOOK_URL     自定义机器人 Webhook 地址（必填，出站；缺失则跳过不报错）
 *   DINGTALK_WEBHOOK_SECRET  Webhook 签名密钥（推荐配置，钉钉默认要求加签）
 *
 * 消息类型（出站）：
 *   text         — 纯文本（支持 @ 手机号 / @所有人）
 *   markdown     — 钉钉 Markdown 子集
 *   actionCard   — 单按钮交互卡片（用于 alert/briefing/task_result）
 *
 * 设计说明：
 *   - 钉钉签名机制 = HMAC-SHA256("{ts}\n{secret}", secret) → base64 → URL-encode
 *     注意：和飞书不同！钉钉 hmac 的 key 是 secret 本身，飞书 hmac 的 key 是 "ts\nsecret"
 *   - 签名参数追加到 URL query：&timestamp=...&sign=...
 *   - 应用模式（callback、解密、@me 触发）走 products/commerce-ops/dingtalk/client.py，
 *     本模块仅覆盖 webhook 主动发送场景。
 */

import { createHmac } from 'crypto';
import { request } from 'https';
import { redactSecrets } from '../utils/redact.mjs';

// ---------------------------------------------------------------------------
// 配置读取（模块加载时一次性读取）
// ---------------------------------------------------------------------------

const WEBHOOK_URL    = process.env.DINGTALK_WEBHOOK_URL    || '';
const WEBHOOK_SECRET = process.env.DINGTALK_WEBHOOK_SECRET || '';

// 卡片字数硬上限（钉钉单条消息 markdown 上限约 5000 字符，留余量）
const MAX_CARD_TEXT  = 4500;

// 未配置时的统一返回
const _SKIP = { ok: false, skipped: true, reason: 'webhook_not_configured' };

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** HTTPS POST JSON，无第三方依赖；与 feishu.mjs 同一模式 */
function _httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    };
    const req = request(options, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    // 与 feishu.mjs 同样的 _settled 模式：防止 destroy() 触发 error 事件二次 reject
    let _settled = false;
    function _settle(fn, val) { if (!_settled) { _settled = true; fn(val); } }
    req.on('error', err => _settle(reject, err));
    req.setTimeout(8000, () => { req.destroy(); _settle(reject, new Error('DingTalk request timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * 生成钉钉自定义机器人签名 query 字符串
 * 钉钉规范：
 *   stringToSign = `${timestamp}\n${secret}`
 *   sign         = urlEncode(base64(HmacSHA256(secret, stringToSign)))
 * 返回拼接到原 URL 末尾的 query（含起始 & 或 ?）；未配置 secret 时返回空串。
 */
function _signedQuery() {
  if (!WEBHOOK_SECRET) return '';
  const timestamp    = Date.now().toString();          // 毫秒
  const stringToSign = `${timestamp}\n${WEBHOOK_SECRET}`;
  const sign         = createHmac('sha256', WEBHOOK_SECRET)
    .update(stringToSign)
    .digest('base64');
  // URL-encode 是钉钉硬性要求（base64 含 + / =）
  const encoded = encodeURIComponent(sign);
  // WEBHOOK_URL 已经带 ?access_token=xxx，统一用 & 拼
  const sep = WEBHOOK_URL.includes('?') ? '&' : '?';
  return `${sep}timestamp=${timestamp}&sign=${encoded}`;
}

/** 统一发送：拼签名 → POST → 解析 errcode；错误日志走 redactSecrets */
async function _send(body) {
  if (!WEBHOOK_URL) return _SKIP;

  const url = WEBHOOK_URL + _signedQuery();
  try {
    const resp = await _httpsPost(url, body);
    const code = resp.body?.errcode;
    if (code !== undefined && code !== 0) {
      const msg = `DingTalk API 错误: ${resp.body.errmsg} (errcode=${code})`;
      // errmsg 可能回显 token / sign 片段，redact 一遍再抛
      throw new Error(redactSecrets(msg));
    }
    return { ok: true, status: resp.status, body: resp.body };
  } catch (err) {
    // 错误信息再 redact 一次（防 URL 中的 access_token 泄漏到调用栈）
    const safe = new Error(redactSecrets(err.message || String(err)));
    safe.stack = err.stack ? redactSecrets(err.stack) : safe.stack;
    throw safe;
  }
}

// ---------------------------------------------------------------------------
// 出站：基础消息类型
// ---------------------------------------------------------------------------

/**
 * 发送纯文本消息
 * @param {string}        text       消息正文
 * @param {string[]}      atMobiles  @ 的手机号数组
 * @param {boolean}       atAll      是否 @所有人
 */
export async function sendText(text, atMobiles = [], atAll = false) {
  const body = {
    msgtype: 'text',
    text:    { content: text },
    at:      { atMobiles, isAtAll: !!atAll },
  };
  return _send(body);
}

/**
 * 发送 Markdown 消息
 * @param {string} title     标题（机器人通知列表显示）
 * @param {string} markdown  钉钉 Markdown 内容（支持子集：标题/加粗/列表/链接/图片）
 */
export async function sendMarkdown(title, markdown) {
  const body = {
    msgtype:  'markdown',
    markdown: { title, text: markdown.slice(0, MAX_CARD_TEXT) },
  };
  return _send(body);
}

// ---------------------------------------------------------------------------
// 出站：交互卡片（统一封装为 ActionCard）
// ---------------------------------------------------------------------------

/**
 * 发送交互卡片
 * @param {'alert'|'briefing'|'task_result'} type
 * @param {object} payload
 */
export async function sendCard(type, payload) {
  let card;
  if (type === 'alert')         card = _buildAlertCard(payload);
  else if (type === 'briefing') card = _buildBriefingCard(payload);
  else                          card = _buildTaskResultCard(payload);

  const body = {
    msgtype:    'actionCard',
    actionCard: card,
  };
  return _send(body);
}

// ---------------------------------------------------------------------------
// 卡片模板构建（输出符合钉钉 actionCard 规范的对象）
// ---------------------------------------------------------------------------

function _buildAlertCard({ title, message, severity = 'HIGH', details = [] }) {
  const icon = severity === 'HIGH' ? '🔴' : severity === 'MEDIUM' ? '🟡' : '🟢';
  const tag  = `[${severity}]`;

  const lines = [
    `## ${icon} ${title || 'Nova 告警'}`,
    '',
    `**${tag}** ${message || '(无消息)'}`,
  ];

  if (details && details.length > 0) {
    lines.push('', '---', '', '**详情：**');
    for (const d of details) lines.push(`- ${d}`);
  }

  lines.push('', `> 自动生成 · ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);

  const text = lines.join('\n').slice(0, MAX_CARD_TEXT);

  const card = {
    title:          `Nova Kernel — ${title || '告警'}`,
    text,
    btnOrientation: '0',
  };
  // 配置了外部地址才显示按钮，否则钉钉会把按钮渲染成无效链接
  if (process.env.NOVA_KERNEL_EXTERNAL_URL) {
    card.singleTitle = '查看详情';
    card.singleURL   = `${process.env.NOVA_KERNEL_EXTERNAL_URL}/evolution/gaps`;
  }
  return card;
}

function _buildBriefingCard({ date, findings = [], actionsOk = 0 }) {
  const day = date || new Date().toISOString().slice(0, 10);

  const lines = [
    `## 📋 Nova 日报 · ${day}`,
    '',
    `> 扫描完成：发现 **${findings.length}** 项，已处理 **${actionsOk}** 项`,
    '',
    '---',
    '',
  ];

  if (findings.length === 0) {
    lines.push('✅ 系统健康，无待处理事项');
  } else {
    for (const f of findings) {
      const ic = f.severity === 'HIGH' ? '🔴' : f.severity === 'MEDIUM' ? '🟡' : '🟢';
      lines.push(`**${ic} ${f.type || 'finding'}** — ${f.message || ''}`, '');
    }
  }

  lines.push('', `> 自动生成 · ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);

  const text = lines.join('\n').slice(0, MAX_CARD_TEXT);

  const card = {
    title:          `Nova 日报 · ${day}`,
    text,
    btnOrientation: '0',
  };
  if (process.env.NOVA_KERNEL_EXTERNAL_URL) {
    card.singleTitle = '打开控制台';
    card.singleURL   = `${process.env.NOVA_KERNEL_EXTERNAL_URL}/dashboard`;
  }
  return card;
}

function _buildTaskResultCard({ task_id, project, status, summary, risk_level }) {
  const icon = status === 'ok' ? '✅' : '❌';
  const tag  = status === 'ok' ? '成功' : '失败';

  const lines = [
    `## ${icon} 任务结果 · ${project || '-'}`,
    '',
    `- **任务 ID**：\`${task_id || '-'}\``,
    `- **状态**：${tag}`,
    `- **风险等级**：${risk_level || '-'}`,
    '',
    '---',
    '',
    '**摘要**',
    '',
    summary || '(无摘要)',
  ];

  const text = lines.join('\n').slice(0, MAX_CARD_TEXT);

  const card = {
    title:          `任务结果 · ${project || ''} ${tag}`,
    text,
    btnOrientation: '0',
  };
  if (process.env.NOVA_KERNEL_EXTERNAL_URL && task_id) {
    card.singleTitle = '查看任务';
    card.singleURL   = `${process.env.NOVA_KERNEL_EXTERNAL_URL}/tasks/${encodeURIComponent(task_id)}`;
  }
  return card;
}

// ---------------------------------------------------------------------------
// 便捷封装：与 feishu.mjs 对齐
// ---------------------------------------------------------------------------

/**
 * 发送日报卡片（initiative engine 调用）
 * @param {{ findings, decisions, date }} report
 */
export async function sendBriefingCard(report) {
  const actionsOk = report.decisions?.filter(d => d.result?.ok && d.decided_action !== 'briefing_only').length || 0;
  return sendCard('briefing', {
    date:     report.date || new Date().toISOString().slice(0, 10),
    findings: report.findings || [],
    actionsOk,
  });
}

/**
 * 发送告警
 * @param {string}              title
 * @param {string}              message
 * @param {string[]}            details
 * @param {'HIGH'|'MEDIUM'|'LOW'} severity
 */
export async function sendAlert(title, message, details = [], severity = 'HIGH') {
  return sendCard('alert', { title, message, severity, details });
}

// ---------------------------------------------------------------------------
// 入站：占位实现
// ---------------------------------------------------------------------------
// 钉钉 webhook 模式不接收回调；应用模式的 callback 需要 AES-128-CBC 解密 + 加签校验，
// 已在 products/commerce-ops/dingtalk/client.py 处理，此处保留同名接口供路由层统一调用。

/**
 * 验证入站事件（占位）
 * @returns {{ ok: false, error: string }}
 */
export function verifyInboundEvent(_body, _headers) {
  return { ok: false, error: 'inbound not implemented for webhook mode' };
}

/** 提取消息文本（占位） */
export function extractMessageText(_event) {
  return null;
}

/** 提取发送者（占位） */
export function extractSender(_event) {
  return { userId: null, openId: null, chatId: null, chatType: null };
}
