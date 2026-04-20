# Contributing to Nova Kernel

Thank you for thinking about contributing — Nova exists because no single AI tool can solve the cross-tool memory/skill/agent silo problem alone. Every additional perspective compounds.

## Ground rules

1. **No personal data in commits.** Memory JSONLs, audit DB, council ticket files are all in `.gitignore` for a reason. Double-check before pushing.
2. **No hard-coded secrets.** Add to `.env.example` with empty value; document in README.
3. **L0 layer is sacred.** Changes to `kernel/constitutional.json`, `kernel/utils/l3-gate.mjs`, `kernel/audit/` require core-maintainer approval and a written rationale in the PR description.
4. **Append-only memory model.** Don't introduce code paths that physically delete jsonl rows. Use `supersede` / `forgetMemory` (which appends a `status: deleted` entry).

## How to contribute

### A new skill (knowledge / pattern)

Skills are codified knowledge — patterns the community agrees are worth remembering. They live in `evolution/skills/*.md` after going through council vote.

```bash
# 1. Write a proposal
cat > evolution/proposals/skill-<your-name>.md <<'EOF'
---
type: skill_proposal
name: your-skill-name
trigger_keyword: <when to apply>
confidence: 0.85
created_at: 2026-04-20
status: pending
---

# Skill: your-skill-name

## Trigger
When does this skill apply?

## Steps
1. ...
2. ...

## Source
Why we need this (1-3 lessons learned)
EOF

# 2. Submit for council vote (locally, or via PR)
curl -X POST http://127.0.0.1:3700/council/submit \
  -H "Authorization: Bearer $NOVA_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "task_id": "skill-promote-your-skill-name",
  "operator": "you@example.com",
  "prompt": "$(cat evolution/proposals/skill-your-skill-name.md)",
  "project": "skill-promotion"
}
JSON
)"

# 3. After local council approves and you approve, PR with the file in evolution/skills/
```

### A new agent

Agents are callable units of capability — Python script, Node module, REST endpoint, anything spawnable.

1. Add an entry to `kernel/agents/registry.json` (see `_example_python_agent` template).
2. Drop the entry's actual code under `agents/<your-name>/` (or wherever `cwd` points).
3. Test locally: `nova_agent_invoke <name> <args_json>`.
4. PR the registry entry + agent code.

### A new connector manifest

Connectors are external tools Nova can detect and probe (e.g. Python, Node, ffmpeg).

1. Add a manifest to `kernel/connectors/manifests/<tool>.json`. See existing files for the schema.
2. Discovery happens automatically every 60min; live-watch picks up the new manifest within seconds.

### Bug fixes

1. Reproduce locally with `npm test` if possible.
2. Include the relevant `nova_health` output and (sanitized) `logs/` excerpts in the PR.
3. If the bug is in the L0 layer or audit pipeline, please disclose privately first (see SECURITY).

### Documentation

Even fixing a typo helps. Documentation PRs are merged on sight.

## Code style

- ES modules (`*.mjs`) for new kernel files. CommonJS (`*.js`) only for legacy paths.
- No new deps without justification — Nova ships ~5 production deps and we want it to stay close to that.
- `node --check <file>` before pushing.
- If you touch the unified LLM layer (`kernel/utils/llm.mjs`) or the agent dispatcher (`kernel/agents/invoke.mjs`), run a Codex review pass — these are foundational.

## Testing

```bash
npm test              # unit
npm run eval          # eval suite (LLM-graded scenarios)
npm run ci            # both
```

## Commit messages

We don't enforce a strict format, but please:

- One logical change per commit
- First line ≤72 chars, imperative mood ("add X", not "added X")
- Body: what and *why* (the diff shows how)

## Security

If you find a vulnerability — especially anything that could let an AI bypass the L0 layer or write outside its sandbox — **do not file a public issue**. Email the maintainers (see SECURITY.md once published) or open a private security advisory on GitHub.

## License

By submitting a contribution you agree it will be licensed under Apache 2.0 (the same as the rest of the project).
