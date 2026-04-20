# Nova Kernel Architecture

## TL;DR

Nova is a **single-process Node.js HTTP server** (`kernel/server.js`) that exposes:
- A **memory layer** (append-only JSONL) with automatic 4-way projection
- A **skill library** (Markdown files, council-vetted)
- An **agent registry** (JSON-declared, multi-runtime)
- A **constitutional risk gate** (L0-L3) on every mutation
- 8 self-maintenance crons that keep the system fresh
- 41 MCP tools so any AI client can drive it

## Layered view

```
┌─────────────────────────────────────────────────────────────────────┐
│                         AI Clients                                   │
│   Claude Code · Codex CLI · Cursor · Continue · Antigravity · curl  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  MCP (stdio) / HTTP (3700)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Routing layer                                    │
│   server.js (HTTP)  ·  bin/nova-mcp.mjs (MCP)                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────────────┐
        ▼                      ▼                              ▼
┌───────────────┐    ┌───────────────────┐         ┌──────────────────┐
│ Memory Layer  │    │ Capability Layer  │         │  Decision Layer  │
│               │    │                   │         │                  │
│ memory-writer │    │ task-planner      │         │  l3-gate         │
│ memory-sync   │    │ skill-miner       │         │  council         │
│ hygiene       │    │ external-scout    │         │  proposal-engine │
│ kb (vector)   │    │ agents/invoke     │         │  audit           │
└───────┬───────┘    └─────────┬─────────┘         └────────┬─────────┘
        │                      │                            │
        └──────────────────────┼────────────────────────────┘
                               ▼
                      ┌─────────────────┐
                      │ Worker Layer    │
                      │ ai-executor     │  ── routes by task_type ──▶  Provider
                      │ providers       │                              (Anthropic /
                      │ worker-guard    │                               Gemini /
                      └─────────────────┘                               OpenAI /
                                                                        Antigravity)
```

## The 6 closed loops in detail

### Loop 1: Task Identification

```
User intent ──▶ nova_task_plan(intent)
                       │
                       ├──▶ keyword bigram tokenize
                       ├──▶ scan evolution/skills/
                       ├──▶ scan agents/registry.json
                       ├──▶ scan feedback memories
                       └──▶ return { skills[], agents[], warnings[], proposals[] }
                                │
                                └──▶ logTaskPlan() writes task-plan-* memory
                                     (skill-miner picks this up later for
                                      intent → capability mapping)
```

### Loop 2: Execution Telemetry

Every `nova_agent_invoke` call passes through the agents handler:

```js
// kernel/server/handlers/agents.mjs
const r = await invokeAgent(name, args, ...);

if (failure) {
  writeMemory({ type: 'feedback', name: `agent-failure-${name}-${ts}`, ... });
  // confidence: 0.9, all failures captured
}
if (success && (sampleHash < 2)) {
  writeMemory({ type: 'feedback', name: `agent-success-${name}-${ts}`, ... });
  // confidence: 0.72, ~12.5% sampling to avoid jsonl bloat
}
```

### Loop 3: Skill Distillation (6h cron)

```
Recent feedback memories
       │
       │  cluster by name-prefix bigrams (2-segment fine + 1-segment coarse)
       │  groups with ≥2 members proceed
       ▼
LLM (Sonnet 4.6) called per group via callLlmJson:
  "Distill these N feedback into one skill_proposal {name, trigger, steps[], conf}"
       │
       │  conf < 0.7 → discard
       │  proposal file already exists → skip (idempotent)
       ▼
Write evolution/proposals/skill-<name>.md
```

### Loop 4: External Discovery (24h cron)

Two parallel paths:

**A. Mechanical (deterministic):**
```
For each connector with npm_package field in manifest:
   spawn(`npm view <pkg> version`)
   compare with locally-installed version (semver-aware, prerelease-aware)
   if outdated → write upgrade-connector-<id>.md proposal
```

**B. LLM (semantic):**
```
For each promoted skill:
   ask Sonnet "is this still 2026 best practice? freshness 0..1"
   if freshness < 0.6 → write upgrade-skill-<name>.md proposal
```

### Loop 5: Council Vote

```
proposal submitted ──▶ kernel/council/async-council.mjs::submitForAsyncVote
                              │
                              │  setImmediate(_runVoting) — non-blocking
                              ▼
                       3 voters serial (avoid 429):
                          · Opus 4.6 Thinking
                          · Gemini 3.1 Pro High
                          · Sonnet 4.6
                              │
                              │  Each: executeWithAI(45s timeout)
                              │  Aggregate: approveRatio
                              ▼
                       status = awaiting_human
                              │
                              │  user calls /council/resolve
                              ▼
                       status = approved | vetoed
                              │
                              ▼
                       (your code) move proposal → evolution/skills/
```

If voting hangs (e.g. all 429): call `/council/retry` to re-fire.

### Loop 6: 4-Way Projection

```
writeMemory() succeeds
       │
       │  _projectUserMd()       — rebuild ~/.claude/.../MEMORY.md
       │  _autoSyncToClaude() async:
       │     ├─ syncToClaude()        — per-entry .md in ~/.claude/projects/.../memory/
       │     ├─ syncToCodex()         — unified ~/.codex/AGENTS.md
       │     ├─ syncToWorkspace()     — unified ./AGENTS.md
       │     └─ syncToAntigravity()   — unified ./GEMINI.md
       │
       │  All 4 syncs:
       │     · skip entries with source: 'claude-code' (anti-echo)
       │     · tag projection files with managed_by: nova-memory-sync
       │     · clean up orphan .md files (deletion permanence)
       ▼
All AI tools see the new memory within ~10ms
```

## Constitutional risk model

```
                    Every mutation passes through l3-gate
                                    │
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                      ▼
            L0/L1                  L2                     L3
        confidence ≥ 0.85    confidence ≥ 0.7     anything outbound
              │                     │                      │
            execute             execute                  reject
                            + 24h veto window     + auto-create proposal
                                                  + return ticket_id
                                                          │
                                                          │  council vote
                                                          │  user approve
                                                          ▼
                                                       execute
```

## Memory model deep-dive

Each `kernel/memory/authoritative/<type>.jsonl` file is **append-only**. A row never gets modified or deleted in place. State transitions are new appended rows:

```jsonl
{"id":"abc123","name":"foo","status":"active","body":"v1","created_at":"..."}
{"id":"abc123","name":"foo","status":"superseded","body":"v1","created_at":"..."}
{"id":"def456","name":"foo","status":"active","body":"v2","created_at":"..."}
{"id":"def456","name":"foo","status":"deleted","body":"v2","created_at":"..."}
```

`readMemories()` does last-write-wins by `id` (where `id = hash(type, name, body)`). Filter by `status === 'active'` returns the canonical view.

This gives you:
- **Audit trail** — every state transition preserved
- **Simple replication** — just copy the file
- **Crash safety** — no partial-write windows; rename-based atomic writes for snapshots

For high-frequency snapshots (architecture-snapshot, machine-spec) the `upsertSnapshot()` primitive rewrites the file atomically with deduplication, keeping file size constant.

## Agent runtimes

`kernel/agents/registry.json` declares each agent with an `interpreter`:

| interpreter | dispatch | use case |
|-------------|----------|----------|
| `internal` | `import()` of the module + call `export_method` | First-class JS modules (e.g. `memory-hygiene`) |
| `python` | `spawn(PYTHON_BIN, [entry, ...])` | Python scripts |
| `node` | `spawn('node', [entry, ...])` | Node scripts that need their own process |
| (custom) | `spawn(interpreter, [entry, ...])` | Anything spawnable |

Calling conventions:
- `method_payload` — `entry <method> <json_payload>` (recommended for typed APIs)
- `raw_args` — `entry <args[0]> <args[1]> ...` (for legacy CLIs)

## Worker layer (LLM execution)

`kernel/workers/ai-executor.mjs` is the central LLM dispatcher:

```js
const r = await executeWithAI({
  task_id, prompt, worker, suggested_model, task_type, complexity, timeout_ms,
});
```

It does:
1. **Task type → route** via `kernel/workers/task-router.mjs` (e.g. `structured-extract` → `claude-sonnet-4-6`)
2. **Health check** — skip known-down providers via `worker-health.mjs`
3. **Primary attempt** then **fallback chain** (`fallback-chain.mjs`)
4. **Worker guard** — anti-pollution check (worker output shouldn't claim driver authority)
5. **Returns** `{ ok, output, model, latency_ms, ... }`

The `kernel/utils/llm.mjs` thin wrapper makes this even simpler:
```js
const r = await callLlmJson(prompt, { model, task_type, ... });
// → { ok, json, model, latency_ms }
```

This is the **cross-AI uniform layer** — caller code doesn't change when you swap providers.
