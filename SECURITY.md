# Security Policy

## Reporting a vulnerability

If you find a vulnerability — particularly anything that lets an AI bypass the L0 layer, write outside the sandbox, exfiltrate secrets, or escalate risk_level — please **do not file a public issue**.

Instead:

1. Open a [private security advisory on GitHub](https://github.com/CHANGEME/nova-kernel/security/advisories/new), or
2. Email the maintainers (TBD — replace before publishing)

We aim to respond within 7 days.

## Threat model

Nova is designed under the assumption that:

- **The kernel itself is trusted** (signed code, reviewed, tested).
- **AI-generated content is untrusted** — every write goes through `redact.mjs` to strip secrets and `l3-gate.mjs` to gate risk.
- **External tools (connectors) may be compromised** — discovery uses safe spawn (no `shell:true`).
- **Prompts may try to escalate** — `worker-guard.mjs` detects worker outputs that claim driver authority.

## Out of scope

- LLM hallucination quality issues (file as a regular bug, not security)
- Model bias / output content (upstream provider issue)
- Performance / DoS via expensive prompts (rate-limit at the proxy)
