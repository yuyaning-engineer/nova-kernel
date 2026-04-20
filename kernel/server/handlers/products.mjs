/**
 * Product Handlers
 * kernel/server/handlers/products.mjs
 *
 * POST /products/:product/:method — 动态加载 products/<product>/adapter.mjs，
 * 实例化 Adapter 并调用 method。Adapter 内部走 _run() 通道：
 *   classifyRisk → blockL3 → execute → audit → reportOutcome
 */

import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { auditLog } from '../../audit/audit.js';
import { readBody, send, sendError, assertInternalAuth, resolveSource } from '../utils.mjs';

const KERNEL_ROOT = process.env.NOVA_KERNEL_ROOT || 'D:/nova-kernel';

export async function handleProductInvoke(req, res) {
  if (!assertInternalAuth(req, res)) return;
  try {
    const source = resolveSource(req);
    const path = req.url.split('?')[0];
    const parts = path.split('/').filter(Boolean); // ["products", ":product", ":method"]
    if (parts.length !== 3 || parts[0] !== 'products') {
      return sendError(res, 400, '路径格式：/products/<product>/<method>');
    }
    const [, product, method] = parts;

    // 严格校验：长度 + 字符集；避免路径穿越、原型污染、日志注入
    if (!/^[a-z][a-z0-9-]{0,63}$/i.test(product) || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(method)) {
      return sendError(res, 400, 'product/method 命名非法（字母开头、<=64 字符、仅限 [a-zA-Z0-9_-]）');
    }

    const adapterPath = join(KERNEL_ROOT, 'products', product, 'adapter.mjs');
    // 路径穿越兜底检查：adapter 必须仍然在 products/ 目录下
    const productsRoot = resolve(join(KERNEL_ROOT, 'products'));
    const resolvedAdapter = resolve(adapterPath);
    if (!resolvedAdapter.startsWith(productsRoot + sep) && resolvedAdapter !== productsRoot) {
      return sendError(res, 400, 'product 路径越界');
    }
    if (!existsSync(adapterPath)) {
      return sendError(res, 404, `产品 ${product} 未安装（${adapterPath} 不存在）`);
    }

    const body = await readBody(req);
    const payload = body.payload || {};
    const sessionId = body.session_id || `${source}-${Date.now().toString(36)}`;

    auditLog({
      event: 'product.invoke',
      operator: `source:${source}`,
      target: `${product}/${method}`,
      detail: { session: sessionId, payload_keys: Object.keys(payload) },
    });

    // 动态 ESM import（Windows 路径转 file:// URL）
    const adapterUrl = `file:///${adapterPath.replace(/\\/g, '/')}`;
    const mod = await import(adapterUrl);
    const AdapterClass = Object.values(mod).find(v => typeof v === 'function' && /Adapter$/.test(v.name));
    if (!AdapterClass) {
      return sendError(res, 500, `产品 ${product} 未导出 Adapter 类`);
    }

    const adapter = new AdapterClass({ sessionId });
    if (typeof adapter[method] !== 'function') {
      return sendError(res, 404, `方法 ${method} 在 ${product} Adapter 中不存在`);
    }

    const result = await adapter[method](payload);
    send(res, 200, { ok: true, product, method, ...result });
  } catch (err) {
    console.error('[handleProductInvoke] 错误:', err);
    sendError(res, 500, err.message);
  }
}
