# Nova Kernel

> **The Constitutional AI Operating System.**
> One memory, one skill library, one agent registry — shared across **Claude Code · Codex · Gemini · Cursor · Antigravity**. Self-evolving, self-maintaining, self-explaining.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-7c3aed)](https://modelcontextprotocol.io/)
[![Status](https://img.shields.io/badge/status-alpha-orange)]()

---

## 🤔 Why Nova?

Today's AI tools — Claude Code, Codex CLI, Cursor, Continue, Antigravity, raw API — each live in their own silo. The same user, the same machine, the same project, **but every tool starts from zero each session**:

- Your preference taught to Claude doesn't carry to Codex
- The skill you wrote in Cursor isn't visible to Antigravity
- The bug Codex fixed yesterday gets hit again by Claude tomorrow
- Every assistant rebuilds knowledge nobody chose to lose

**Nova Kernel** is the missing layer: a **single source of truth** for memory + skills + agents, with automatic projection to all the AI tools you use. It's the OS your AIs share.

---

## ✨ What you get

```
                    ┌──────────────────────────────────┐
                    │           Your AI tools          │
                    │  Claude · Codex · Cursor · ...   │
                    └──────────────┬───────────────────┘
                                   │ all read the same
                                   ▼
                    ╔══════════════════════════════════╗
                    ║   Nova Kernel — single source    ║
                    ║   of truth (append-only jsonl)   ║
                    ╚══════════════════════════════════╝
                                   │
        ┌──────────┬───────────────┼──────────────────┬──────────────┐
        ▼          ▼               ▼                  ▼              ▼
    Memory     Skills          Agents          Pipelines        Connectors
   (4 types)  (proposed →    (registry +    (debate / code /   (8 external
              voted →        invoke)         codex)            tools)
              promoted)
```

### 6 closed loops that run automatically

| # | Loop | Trigger | What it does |
|---|------|---------|--------------|
| ① | **Task Identification** | Every new task | `nova_task_plan(intent)` — keyword bigram match → relevant skills/agents/warnings |
| ② | **Execution Telemetry** | Every agent call | Failure 100% / success 12.5% sampling → auto `feedback` memory |
| ③ | **Skill Distillation** | 6h cron | Cluster recent feedback → LLM proposes new skill → write to `proposals/` |
| ④ | **External Discovery** | 24h cron | npm version compare for connectors + LLM freshness check for skills → upgrade proposals |
| ⑤ | **Constitutional Council** | On proposal | 3 AI voters (Opus + Gemini Pro + Sonnet) vote → user final approval |
| ⑥ | **4-Way Projection** | <10ms after write | Sync to `~/.claude/`, `~/.codex/`, `./AGENTS.md`, `./GEMINI.md` |

### 8 self-maintenance crons

`arch-snapshot 30m` · `gap-detector 60m` · `daily-digest 24h` · `connectors 60m+live` · `kernel-watch live` · `skill-miner 6h` · `memory-hygiene 12h` · `external-scout 24h`

---

## 🚀 Quickstart

```bash
git clone https://github.com/<your-org>/nova-kernel.git
cd nova-kernel
npm install

# Configure
cp .env.example .env
# Edit .env: at minimum set GEMINI_API_KEY (free tier works)

# Run
node --env-file=.env start-ecosystem.mjs --kernel
# Server now listening on http://127.0.0.1:3700
```

### Try it

```bash
# Identify capabilities for a task
curl -X POST http://127.0.0.1:3700/task/plan \
  -H "Authorization: Bearer $NOVA_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"intent": "implement an atomic file write helper"}'
# → returns matching skills, agents, warnings

# Scan memory hygiene
curl -X POST http://127.0.0.1:3700/memory/hygiene \
  -H "Authorization: Bearer $NOVA_INTERNAL_TOKEN" \
  -d '{}'

# Check what's in the skill library
ls evolution/skills/
```

### MCP integration (Claude Code, Codex, etc.)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "nova": {
      "command": "node",
      "args": ["D:/path/to/nova-kernel/bin/nova-mcp.mjs"]
    }
  }
}
```

41 MCP tools become available: `nova_health`, `nova_task_plan`, `nova_memory_write`, `nova_council_submit`, `nova_scout_external`, ...

---

## 🏛 Architecture

### Constitutional risk layers

| Level | Scope | Behavior |
|-------|-------|----------|
| **L0** | `constitutional.json`, `audit.db`, `l3-gate.mjs` | Hard-locked. Any AI write → rejected. |
| **L1** | Internal generation (text, reports) | Auto-execute if confidence ≥ 0.85 |
| **L2** | Predictions, internal mutations | Execute + 24h human veto window |
| **L3** | External actions (publish, charge, message) | Mandatory council vote + user approval |

### Memory model

**Append-only JSONL** with status evolution: `active → superseded → deleted`. Reads use last-write-wins by ID. No row is ever physically destroyed (full audit trail). Snapshot-type memories use `upsertSnapshot` for constant file size.

Four memory types:
- `user` — identity, preferences, hardware
- `feedback` — corrections, lessons learned
- `project` — current work context
- `reference` — external resource pointers

### Skill lifecycle

```
feedback memories
       │ (skill-miner 6h, name-prefix bigram clustering)
       ▼
evolution/proposals/skill-*.md
       │ (council 3-vote → awaiting_human)
       ▼
user approve
       │
       ▼
evolution/skills/*.md  ←  4-way projection  →  All AI tools see it
```

### Cross-model abstraction

`kernel/utils/llm.mjs` provides one calling surface for every model:

```js
import { callLlmJson } from './kernel/utils/llm.mjs';

const result = await callLlmJson(prompt, {
  model: 'antigravity-claude-sonnet-4-6',  // or 'gemini-flash', 'gpt-4o', etc.
  task_type: 'structured-extract',
  timeout_ms: 60_000,
});
// → { ok, json, model, latency_ms }  — same shape regardless of provider
```

The `ai-executor` resolves model role → actual model ID via `model-discovery.mjs`. Switch providers without touching caller code.

---

## 📦 What's in the box

```
kernel/
  server.js               # HTTP API on :3700
  constitutional.json     # The framework spec (L0-L3)
  utils/
    l3-gate.mjs           # Risk classifier + write blocker
    llm.mjs               # Unified LLM call + JSON extraction
    redact.mjs            # Auto-strip secrets from logs
  memory/
    memory-writer.mjs     # Append-only writes + supersede + upsertSnapshot
    memory-sync.mjs       # 4-way projection + orphan cleanup
    hygiene.mjs           # Cleanup agent (test residue / module backfill)
    architecture-snapshot.mjs
  task/
    task-planner.mjs      # Identify needed skills/agents/warnings for intent
  evolution/
    skill-miner.mjs       # 6h: cluster feedback → skill proposals (LLM-distilled)
    external-scout.mjs    # 24h: npm version check + skill freshness LLM
    gap-detector.js       # 60m: structural anti-pattern detection
    proposal-engine.mjs   # Generic AI-proposes-change pipeline
  council/
    async-council.mjs     # 3-vote async council + retry mechanism
  agents/
    registry.json         # Agent declaration (internal/python/etc.)
    invoke.mjs            # Universal agent dispatcher
  workers/
    ai-executor.mjs       # Task-type → model routing
    providers.mjs         # Anthropic / Gemini / OpenAI / Antigravity bridge
    worker-guard.mjs      # Anti-pollution check (worker ≠ driver)
  connectors/
    discovery.mjs         # External tool detection (8 manifest-driven)
    manifests/*.json      # Declarative tool specs
  kb/                     # KB v2 — vector search + intel pool + curator tiers
  pipeline/
    pipeline.mjs          # debate / code / codex pipelines
  router/
    intent-router.mjs     # Natural language → action routing
  audit/
    audit.js              # SQLite tamper-evident log
  notify/                 # Pluggable notify (Lark / WeChat Work / DingTalk)

evolution/
  skills/                 # Promoted (council-approved) skills

bin/
  nova-mcp.mjs            # MCP server (41 tools exposed to AI clients)
```

---

## 🧠 Why "Constitutional"?

The system enforces **AI cannot rewrite its own rules**. `kernel/constitutional.json` and `kernel/utils/l3-gate.mjs` are **L0 hard-locked** — any AI write attempt is rejected at the kernel level. To change them, an AI must submit a `proposal` → 3-vote council → human final approval.

This isn't theater. The same gate that prevents AI from "deciding it doesn't need the gate anymore" is the foundation of trust. **Self-evolving, but not self-emancipating.**

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). TL;DR:

1. New skill? Write `evolution/proposals/skill-<name>.md` and submit via `nova_council_submit` — the council votes, then a maintainer approves.
2. New agent? Add to `kernel/agents/registry.json` and PR.
3. New connector? Add a manifest to `kernel/connectors/manifests/<tool>.json`.
4. Bug? Open an issue with the `nova_health` output and reproduction steps.

---

## 📚 Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full system design
- [`docs/MEMORY.md`](docs/MEMORY.md) — append-only model + 4-way projection
- [`docs/EVOLUTION.md`](docs/EVOLUTION.md) — skill lifecycle + council mechanics
- [`docs/MCP.md`](docs/MCP.md) — all 41 MCP tools reference

---

## 🛣 Roadmap

- [ ] Web UI for memory browsing + council voting (currently CLI-only)
- [ ] Kubernetes deployment chart
- [ ] Postgres backend (alternative to JSONL for >100k entries)
- [ ] More connector manifests (community-driven)
- [ ] Multi-user / team mode (currently single-user)

---

## 📄 License

Apache 2.0 — see [LICENSE](LICENSE).

---

> Built with Driver Claude (Sonnet 4.6) on a 2× RTX 5080 + 64GB Windows workstation.
> *Memory persists. Skills compound. Agents specialize. The AI gets better at being your AI.*
