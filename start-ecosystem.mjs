/**
 * Nova Ecosystem Process Manager
 * Starts and monitors all services in the Nova ecosystem.
 *
 * Usage: node start-ecosystem.mjs [--all | --kernel | --bridge | --sandbox]
 *
 * Services:
 *   kernel   — Nova Kernel HTTP server (:3700)
 *   bridge   — Feishu WebSocket bridge
 *   sandbox  — NovaSandbox world simulation (:3000)
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

const KERNEL_ROOT  = process.env.NOVA_KERNEL_ROOT  || 'D:/nova-kernel';
const SANDBOX_ROOT = process.env.NOVASANDBOX_ROOT   || 'D:/novasandbox';

// ---------------------------------------------------------------------------
// Service definitions
// ---------------------------------------------------------------------------

const SERVICES = {
  kernel: {
    name:         'Nova Kernel',
    cmd:          process.execPath,               // node
    args:         ['--env-file=.env', 'kernel/server.js'],
    cwd:          KERNEL_ROOT,
    port:         3700,
    healthUrl:    'http://127.0.0.1:3700/health',
    readyPattern: /running on/i,
    restartDelay: 3000,
    maxRestarts:  10,
  },
  bridge: {
    name:         'Feishu Bridge',
    cmd:          process.env.PYTHON_PATH || 'D:/conda/python.exe',
    args:         ['-u', 'kernel/notify/feishu_bridge.py'],
    cwd:          KERNEL_ROOT,
    readyPattern: /WebSocket.*启动|等待消息/,
    restartDelay: 5000,
    maxRestarts:  10,
    dependsOn:    'kernel',                       // bridge needs kernel alive
  },
  sandbox: {
    name:         'NovaSandbox',
    cmd:          process.execPath,
    args:         ['--env-file=.env', 'src/server.mjs'],
    cwd:          SANDBOX_ROOT,
    port:         3000,
    readyPattern: /listening|running|started/i,
    restartDelay: 3000,
    maxRestarts:  5,
  },
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Simple timestamp for log lines. */
function ts() {
  return new Date().toTimeString().slice(0, 8);
}

/** Parse a .env file into key-value pairs (ignores comments and blank lines). */
function parseEnvFile(filePath) {
  const env = {};
  try {
    const text = readFileSync(filePath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  } catch { /* file may not exist — that's okay */ }
  return env;
}

/** HTTP GET health check — resolves true/false. */
function httpHealthCheck(url, timeoutMs = 3000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const req = httpRequest(url, res => {
      clearTimeout(timer);
      resolve(res.statusCode >= 200 && res.statusCode < 400);
      res.resume();                               // drain response
    });
    req.on('error', () => { clearTimeout(timer); resolve(false); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

class ProcessManager {
  constructor() {
    /** @type {Map<string, { process: import('child_process').ChildProcess|null, restartCount: number, status: string, startedAt: number|null }>} */
    this.processes    = new Map();
    this.shuttingDown = false;
  }

  // ----- public API --------------------------------------------------------

  async startAll(services = null) {
    const toStart  = services || Object.keys(SERVICES);
    const noDeps   = toStart.filter(s => !SERVICES[s].dependsOn);
    const withDeps = toStart.filter(s => SERVICES[s].dependsOn);

    // Independent services in parallel
    await Promise.all(noDeps.map(s => this.startService(s)));

    // Dependent services sequentially
    for (const s of withDeps) {
      await this.startService(s);
    }
  }

  async startService(name) {
    const svc = SERVICES[name];
    if (!svc) { console.error(`[ecosystem] Unknown service: ${name}`); return; }

    // Wait for dependency to become 'running'
    if (svc.dependsOn) {
      const depState = this.processes.get(svc.dependsOn);
      if (!depState || depState.status !== 'running') {
        console.log(`${ts()} [${svc.name}] Waiting for dependency "${svc.dependsOn}"...`);
        await new Promise(resolve => {
          const iv = setInterval(() => {
            const ds = this.processes.get(svc.dependsOn);
            if ((ds && ds.status === 'running') || this.shuttingDown) {
              clearInterval(iv);
              resolve();
            }
          }, 1000);
        });
        if (this.shuttingDown) return;
        // Small grace period for the dependency to finish initializing
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const state = { process: null, restartCount: 0, status: 'starting', startedAt: null };
    this.processes.set(name, state);
    this._spawn(name, svc, state);

    // Wait until first 'running' signal (stdout pattern or grace timeout)
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (state.status === 'running' || state.status === 'stopped' || this.shuttingDown) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }

  shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log(`\n${ts()} [ecosystem] Shutting down all services...`);

    for (const [name, state] of this.processes) {
      if (state.process && !state.process.killed) {
        console.log(`${ts()} [ecosystem] Stopping ${name} (pid ${state.process.pid})...`);
        state.process.kill('SIGTERM');
        // Force kill after 5 s
        setTimeout(() => {
          try { if (state.process && !state.process.killed) state.process.kill('SIGKILL'); } catch {}
        }, 5000);
      }
    }

    // Exit after all processes have had time to stop
    setTimeout(() => process.exit(0), 6000);
  }

  status() {
    const report = {};
    for (const [name, state] of this.processes) {
      report[name] = {
        status:   state.status,
        pid:      state.process?.pid ?? null,
        restarts: state.restartCount,
        uptime:   state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) + 's' : 'n/a',
      };
    }
    return report;
  }

  // ----- internal ----------------------------------------------------------

  _spawn(name, svc, state) {
    if (this.shuttingDown) return;

    console.log(`${ts()} [${svc.name}] Starting (attempt #${state.restartCount + 1})...`);

    // Build env: inherit process.env, overlay .env from service cwd
    const fileEnv = parseEnvFile(join(svc.cwd, '.env'));
    const env = { ...process.env, ...fileEnv };

    const child = spawn(svc.cmd, svc.args, {
      cwd:   svc.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Windows, spawning python may need a shell; node is fine without
      ...(svc.cmd.endsWith('.exe') || svc.cmd.includes('python') ? { shell: false } : {}),
    });

    state.process   = child;
    state.startedAt = Date.now();

    // stdout — detect readiness & relay logs
    child.stdout?.on('data', data => {
      const text = data.toString();
      for (const line of text.trim().split('\n')) {
        console.log(`${ts()} [${svc.name}] ${line}`);
      }
      if (state.status === 'starting' && svc.readyPattern?.test(text)) {
        state.status = 'running';
        console.log(`${ts()} [${svc.name}] -> READY`);
      }
    });

    // stderr — relay (Python prints normal output to stderr too)
    child.stderr?.on('data', data => {
      for (const line of data.toString().trim().split('\n')) {
        console.error(`${ts()} [${svc.name}:err] ${line}`);
      }
    });

    // Process exit — auto-restart unless shutting down
    child.on('exit', (code, signal) => {
      state.status = 'stopped';
      console.log(`${ts()} [${svc.name}] Exited (code=${code}, signal=${signal})`);

      if (this.shuttingDown) return;

      if (state.restartCount < svc.maxRestarts) {
        state.restartCount++;
        console.log(`${ts()} [${svc.name}] Restarting in ${svc.restartDelay}ms (restart #${state.restartCount})...`);
        setTimeout(() => this._spawn(name, svc, state), svc.restartDelay);
      } else {
        console.error(`${ts()} [${svc.name}] Max restarts (${svc.maxRestarts}) reached. Giving up.`);
      }
    });

    child.on('error', err => {
      console.error(`${ts()} [${svc.name}] Spawn error: ${err.message}`);
      state.status = 'stopped';
    });

    // Grace-period fallback: mark running after 8 s even if readyPattern never matched
    setTimeout(() => {
      if (state.status === 'starting') {
        state.status = 'running';
        console.log(`${ts()} [${svc.name}] -> READY (grace timeout)`);
      }
    }, 8000);
  }
}

// ---------------------------------------------------------------------------
// Health-check monitor (periodic, runs for services with healthUrl)
// ---------------------------------------------------------------------------

async function runHealthChecks(pm) {
  for (const [name, svc] of Object.entries(SERVICES)) {
    if (!svc.healthUrl) continue;
    const state = pm.processes.get(name);
    if (!state || state.status !== 'running') continue;

    const ok = await httpHealthCheck(svc.healthUrl);
    if (!ok) {
      console.warn(`${ts()} [health] ${svc.name} health check FAILED (${svc.healthUrl})`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const pm   = new ProcessManager();

// Graceful shutdown
process.on('SIGINT',  () => pm.shutdown());
process.on('SIGTERM', () => pm.shutdown());

// Determine which services to start
let services = null;
if (args.includes('--kernel'))  services = ['kernel'];
if (args.includes('--bridge'))  services = ['kernel', 'bridge'];
if (args.includes('--sandbox')) services = ['sandbox'];
if (args.includes('--all'))     services = ['kernel', 'bridge', 'sandbox'];
// Default: kernel + bridge
if (!services) services = ['kernel', 'bridge'];

console.log(`\n${'='.repeat(54)}`);
console.log(`  Nova Ecosystem Process Manager`);
console.log(`  Services : ${services.join(', ')}`);
console.log(`  Time     : ${new Date().toISOString()}`);
console.log(`${'='.repeat(54)}\n`);

pm.startAll(services).catch(e => {
  console.error(`[ecosystem] Fatal: ${e.message}`);
  process.exit(1);
});

// Periodic status + health every 30 s
setInterval(() => {
  if (pm.shuttingDown) return;
  const s = pm.status();
  const summary = Object.entries(s)
    .map(([k, v]) => `${k}:${v.status}(pid=${v.pid},up=${v.uptime},r=${v.restarts})`)
    .join(' | ');
  console.log(`${ts()} [ecosystem] ${summary}`);
  runHealthChecks(pm);
}, 30_000);
