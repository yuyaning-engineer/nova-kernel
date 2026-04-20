import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.NOVA_KERNEL_ROOT || process.cwd();

let _intervals = [];
let _startupTimeouts = [];
const _running = { snapshot: false, gaps: false, digest: false, connectors: false };

async function _runArchitectureSnapshot() {
  if (_running.snapshot) {
    console.log('[self-maintenance] snapshot already running, skipping');
    return;
  }

  _running.snapshot = true;
  try {
    const { updateArchitectureSnapshot } = await import('./memory/architecture-snapshot.mjs');
    await updateArchitectureSnapshot();
    console.log('[self-maintenance] architecture snapshot refreshed');
  } catch (error) {
    console.warn('[self-maintenance] architecture snapshot failed:', error.message);
  } finally {
    _running.snapshot = false;
  }
}

async function _runGapScan() {
  if (_running.gaps) {
    console.log('[self-maintenance] gap scan already running, skipping');
    return;
  }

  _running.gaps = true;
  try {
    const { detectGaps } = await import('../evolution/gap-detector.js');
    const gaps = await detectGaps({ autoRepair: false });

    if (gaps && gaps.gaps_found > 0) {
      // 治本 (2026-04-19): 删 forgetMemory 循环, supersede 自动接管 (gap-report 保留历史可看演进)
      const { writeMemory } = await import('./memory/memory-writer.mjs');

      const body = [
        `## Gap Detector Report (${new Date().toISOString()})`,
        `Found ${gaps.gaps_found} gap(s).`,
        ...(gaps.gaps || []).slice(0, 10).map((gap, index) =>
          `${index + 1}. [${gap.category || 'unknown'}] ${gap.description || gap.pattern || JSON.stringify(gap).slice(0, 100)}`
        ),
      ].join('\n');

      writeMemory({
        type: 'project',
        name: 'nova-gap-report',
        description: 'Latest Gap Detector scan result',
        body,
        source: 'self-maintenance-auto',
        confidence: 0.9,
      });
      console.log(`[self-maintenance] gap scan recorded ${gaps.gaps_found} issue(s)`);
    } else {
      console.log('[self-maintenance] gap scan found no issues');
    }
  } catch (error) {
    console.warn('[self-maintenance] gap scan failed:', error.message);
  } finally {
    _running.gaps = false;
  }
}

async function _runDailyDigest() {
  if (_running.digest) {
    console.log('[self-maintenance] daily digest already running, skipping');
    return;
  }

  _running.digest = true;
  try {
    const logsDir = join(ROOT, 'logs');
    if (!existsSync(logsDir)) return;

    const { readdirSync } = await import('node:fs');
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stats = {
      tasks_total: 0,
      tasks_failed: 0,
      council_submitted: 0,
      council_vetoed: 0,
      pipeline_runs: 0,
      memory_writes: 0,
    };

    for (const file of readdirSync(logsDir).filter((name) => name.endsWith('.jsonl'))) {
      try {
        const content = readFileSync(join(logsDir, file), 'utf8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;

          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (!event.ts || new Date(event.ts).getTime() < cutoff) continue;
          if (event.event === 'task.dispatched' || event.event === 'task.completed') stats.tasks_total++;
          if (event.event === 'task.failed') stats.tasks_failed++;
          if (event.event === 'council.submitted') stats.council_submitted++;
          if (event.event === 'council.voted' && event.detail?.decision === 'auto_veto') stats.council_vetoed++;
          if (event.event === 'pipeline.complete') stats.pipeline_runs++;
          if (event.event === 'memory.write') stats.memory_writes++;
        }
      } catch {}
    }

    const body = [
      `## 24h System Health Digest (${new Date().toISOString()})`,
      '',
      `- Task dispatches: ${stats.tasks_total} (failed ${stats.tasks_failed})`,
      `- Council submissions: ${stats.council_submitted} (auto_veto ${stats.council_vetoed})`,
      `- Pipeline runs: ${stats.pipeline_runs}`,
      `- Memory writes: ${stats.memory_writes}`,
      '',
      `Health: ${stats.tasks_total === 0 ? 'IDLE' : (1 - stats.tasks_failed / stats.tasks_total) >= 0.9 ? 'GOOD' : 'WARN'}`,
    ].join('\n');

    // 治本 (2026-04-19): 删 forgetMemory 循环, supersede 自动接管 (daily-digest 保留 7 天历史)
    const { writeMemory } = await import('./memory/memory-writer.mjs');

    writeMemory({
      type: 'project',
      name: 'nova-daily-digest',
      description: 'Nova 24h health digest',
      body,
      source: 'self-maintenance-auto',
      confidence: 0.95,
    });
    console.log(`[self-maintenance] daily digest refreshed: ${stats.tasks_total} tasks, ${stats.memory_writes} memory writes`);
  } catch (error) {
    console.warn('[self-maintenance] daily digest failed:', error.message);
  } finally {
    _running.digest = false;
  }
}

async function _runConnectorDiscovery() {
  if (_running.connectors) {
    console.log('[self-maintenance] connector discovery already running, skipping');
    return;
  }

  _running.connectors = true;
  try {
    const { discoverAll } = await import('./connectors/discovery.mjs');
    const state = await discoverAll();
    console.log(`[self-maintenance] connector discovery refreshed: ${state.size} connectors`);
  } catch (error) {
    console.warn('[self-maintenance] connector discovery failed:', error.message);
  } finally {
    _running.connectors = false;
  }
}

export function startSelfMaintenance() {
  if (process.env.NOVA_SELF_MAINTENANCE === 'off') {
    console.log('[self-maintenance] disabled');
    return;
  }

  import('./connectors/discovery.mjs')
    .then(({ startWatcher }) => {
      startWatcher();
      _intervals.push(setInterval(_runConnectorDiscovery, 60 * 60 * 1000));
    })
    .catch((error) => console.warn('[self-maintenance] connector watcher failed:', error.message));

  _startupTimeouts.push(setTimeout(_runArchitectureSnapshot, 30_000));
  _intervals.push(setInterval(_runArchitectureSnapshot, 30 * 60 * 1000));

  _startupTimeouts.push(setTimeout(_runGapScan, 60_000));
  _intervals.push(setInterval(_runGapScan, 60 * 60 * 1000));

  _startupTimeouts.push(setTimeout(_runDailyDigest, 5 * 60 * 1000));
  _intervals.push(setInterval(_runDailyDigest, 24 * 60 * 60 * 1000));

  // P1-#4: kernel 文件改动自动冲烟测试
  import('./kernel-watch.mjs')
    .then(({ startKernelWatch }) => startKernelWatch())
    .catch(error => console.warn('[self-maintenance] kernel-watch failed:', error.message));

  // 2026-04-19: Skill miner 6h 自动跑 (从 feedback 蒸馏 skill proposal)
  _intervals.push(setInterval(async () => {
    try {
      const { mineSkills } = await import('./evolution/skill-miner.mjs');
      const r = await mineSkills({ dry: false });
      if (r.proposals_written > 0) console.log(`[self-maintenance] skill-miner: ${r.proposals_written} new skill proposals`);
    } catch (e) { console.warn('[self-maintenance] skill-miner failed:', e.message); }
  }, 6 * 60 * 60 * 1000));

  // 2026-04-19: Memory hygiene 12h 跑 dry-run (apply 必须人手触发避免误删)
  _intervals.push(setInterval(async () => {
    try {
      const { scanHygiene } = await import('./memory/hygiene.mjs');
      const r = await scanHygiene({});
      const s = r.summary;
      if (s.test_residue + s.missing_module > 0) {
        console.log(`[self-maintenance] memory-hygiene scan: ${s.test_residue} test residue / ${s.missing_module} missing module / ${s.tiny_body} tiny body`);
        const { writeMemory } = await import('./memory/memory-writer.mjs');
        writeMemory({
          type: 'project',
          name: 'memory-hygiene-scan-latest',
          description: `Memory hygiene 最近一次 scan (dry-run, ${new Date().toISOString().slice(0, 10)})`,
          body: '```json\n' + JSON.stringify(r.summary, null, 2) + '\n```\n\n人手触发清理: POST /memory/hygiene { apply: true }',
          source: 'self-maintenance-auto',
          confidence: 0.95,
          module: 'nova-kernel',
        });
      }
    } catch (e) { console.warn('[self-maintenance] memory-hygiene failed:', e.message); }
  }, 12 * 60 * 60 * 1000));

  // 2026-04-19: External scout 24h 跑 (慢节奏避免 npm 限流, LLM token)
  _intervals.push(setInterval(async () => {
    try {
      const { scoutExternal } = await import('./evolution/external-scout.mjs');
      const r = await scoutExternal({ skillLimit: 3 });
      if ((r.proposals_written || []).length > 0) {
        console.log(`[self-maintenance] external-scout: ${r.proposals_written.length} upgrade proposals (${r.proposals_written.join(', ')})`);
      }
    } catch (e) { console.warn('[self-maintenance] external-scout failed:', e.message); }
  }, 24 * 60 * 60 * 1000));

  console.log('[self-maintenance] started: snapshot 30m / gap 60m / digest 24h / connectors 60m / kernel-watch (live) / skill-miner 6h / memory-hygiene 12h / external-scout 24h');
}

export function stopSelfMaintenance() {
  for (const timer of _intervals) clearInterval(timer);
  for (const timer of _startupTimeouts) clearTimeout(timer);
  _intervals = [];
  _startupTimeouts = [];

  import('./connectors/discovery.mjs')
    .then(({ stopWatcher }) => stopWatcher())
    .catch(() => {});
}

export async function triggerMaintenance(which = 'all') {
  const results = {};

  if (which === 'all' || which === 'snapshot') {
    await _runArchitectureSnapshot();
    results.snapshot = 'done';
  }
  if (which === 'all' || which === 'gaps') {
    await _runGapScan();
    results.gaps = 'done';
  }
  if (which === 'all' || which === 'digest') {
    await _runDailyDigest();
    results.digest = 'done';
  }
  if (which === 'all' || which === 'connectors') {
    await _runConnectorDiscovery();
    results.connectors = 'done';
  }

  return results;
}
