/**
 * kernel/agents/invoke.mjs — Agent 统一调用层
 *
 * 任何 AI 通过 nova_agent_invoke 调注册表里的 Python agent.
 * 不再让 Driver 现场写, 不再让每个 adapter 重新 spawn.
 *
 * Calling conventions:
 *   - "method_payload": python entry.py <method> <json_payload>  (推荐: jushuitan / dingtalk)
 *   - "raw_args":       python entry.py <args[0]> <args[1]> ...   (现成 agent: vision / qianniu)
 *
 * 输出契约: agent stdout 应是单行 JSON {ok, data?, error?}.
 *           非 JSON 输出会被包成 {ok:false, raw_stdout, exit_code}.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();
const REGISTRY_PATH = join(ROOT, 'kernel', 'agents', 'registry.json');
const PYTHON_BIN = process.env.JST_PYTHON_BIN || 'python';

let _registryCache = null;
let _registryMtime = 0;

function _loadRegistry() {
  try {
    const st = require('node:fs').statSync(REGISTRY_PATH);
    if (_registryCache && st.mtimeMs === _registryMtime) return _registryCache;
    const raw = readFileSync(REGISTRY_PATH, 'utf8');
    _registryCache = JSON.parse(raw);
    _registryMtime = st.mtimeMs;
    return _registryCache;
  } catch (e) {
    return { agents: {} };
  }
}

// 简化版避免 require: 用 ESM-compatible reload
import { statSync } from 'node:fs';
function _loadRegistrySync() {
  try {
    const st = statSync(REGISTRY_PATH);
    if (_registryCache && st.mtimeMs === _registryMtime) return _registryCache;
    const raw = readFileSync(REGISTRY_PATH, 'utf8');
    _registryCache = JSON.parse(raw);
    _registryMtime = st.mtimeMs;
    return _registryCache;
  } catch {
    return { agents: {} };
  }
}

export function listAgents() {
  const reg = _loadRegistrySync();
  return Object.entries(reg.agents || {}).map(([name, meta]) => ({
    name,
    displayName: meta.displayName,
    module: meta.module,
    risk_level: meta.risk_level,
    description: meta.description,
    calling_convention: meta.calling_convention,
    timeout_ms: meta.timeout_ms,
  }));
}

export function getAgent(name) {
  const reg = _loadRegistrySync();
  return reg.agents?.[name] || null;
}

/**
 * Run agent. Returns { ok, exit_code, data?, error?, time_ms, stdout_raw }.
 */
export async function invokeAgent(name, args = {}, { timeout_ms } = {}) {
  const meta = getAgent(name);
  if (!meta) return { ok: false, error: `agent ${name} 未注册` };

  // Internal JS module agent — dynamic import + invoke exported function (no spawn)
  if (meta.interpreter === 'internal') {
    const t0 = Date.now();
    let timer;
    try {
      const modulePath = join(ROOT, meta.module_path);
      if (!existsSync(modulePath)) return { ok: false, error: `module not found: ${modulePath}` };
      const mod = await import(`file://${modulePath.replace(/\\/g, '/')}`);
      const fn = mod[meta.export_method];
      if (typeof fn !== 'function') return { ok: false, error: `export ${meta.export_method} not a function` };
      const finalTimeout = (Number.isFinite(timeout_ms) && timeout_ms > 0) ? timeout_ms : (meta.timeout_ms || 60000);
      const safePayload = (args && typeof args === 'object' && !Array.isArray(args))
        ? (args.payload ?? args)
        : {};
      const result = await Promise.race([
        Promise.resolve(fn(safePayload)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`internal agent timeout ${finalTimeout}ms`)), finalTimeout); }),
      ]);
      return { ok: true, agent: name, time_ms: Date.now() - t0, ...(typeof result === 'object' && result !== null ? result : { data: result }) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), agent: name, time_ms: Date.now() - t0 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const cwd = resolve(join(ROOT, meta.cwd));
  const entryPath = join(cwd, meta.entry);
  if (!existsSync(entryPath)) return { ok: false, error: `entry 不存在: ${entryPath}` };

  // 构造 spawn 参数 (含输入安全校验)
  const safeArgs = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  let spawnArgs;
  if (meta.calling_convention === 'method_payload') {
    if (typeof safeArgs.method !== 'string' || safeArgs.method.trim() === '') {
      return { ok: false, error: 'method_payload 必传非空 string method' };
    }
    const payload = JSON.stringify(safeArgs.payload ?? {});
    spawnArgs = [meta.entry, safeArgs.method, payload];
  } else if (meta.calling_convention === 'raw_args') {
    if (!Array.isArray(safeArgs.args)) {
      return { ok: false, error: 'raw_args 必传 args: [...]' };
    }
    spawnArgs = [meta.entry, ...safeArgs.args.map(v => String(v))];
  } else {
    return { ok: false, error: `未知 calling_convention: ${meta.calling_convention}` };
  }

  const interp = meta.interpreter === 'python' ? PYTHON_BIN : meta.interpreter;
  const finalTimeout = timeout_ms || meta.timeout_ms || 60000;

  return new Promise(resolve => {
    const t0 = Date.now();
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const proc = spawn(interp, spawnArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: `agent timeout ${finalTimeout}ms`, agent: name, time_ms: Date.now() - t0 });
    }, finalTimeout);

    proc.on('close', code => {
      clearTimeout(timer);
      const time_ms = Date.now() - t0;
      // 尝试解析 stdout 最后一行为 JSON
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      try {
        const parsed = JSON.parse(last);
        return resolve({ ok: parsed.ok !== false, ...parsed, agent: name, exit_code: code, time_ms, stderr: stderr.slice(0, 500) });
      } catch {
        return resolve({
          ok: code === 0,
          agent: name,
          exit_code: code,
          time_ms,
          stdout_raw: stdout.slice(0, 2000),
          stderr: stderr.slice(0, 500),
        });
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn error: ${err.message}`, agent: name, time_ms: Date.now() - t0 });
    });
  });
}
