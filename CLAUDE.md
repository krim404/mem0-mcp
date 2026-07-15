# mem0-mcp — agent notes

Standalone repo for a self-hosted agent-memory MCP bridge and its `shared-memory` skill.
Code, comments, and docs in English.

## What this is
- `src/index.ts` — stdio MCP server (`mem0-bridge-mcp`), exposes `memory_add/search/list/recent`, the pin trio `memory_pin/pins/unpin`, and `memory_update/delete/reset`.
- `src/mem0.ts` — REST client for the mem0 OSS server (scoping, recency re-rank, timeouts).
- `src/rewrite.ts` — HyDE-lite query rewrite via any OpenAI-compatible chat endpoint (best-effort).
- `src/selftest.ts` — live smoke test. `src/retrieval-eval.ts` — hit@k probe for question queries.
- `skills/shared-memory/SKILL.md` — the discipline skill, symlinked into agent skill dirs.

## Architecture
Bridge (Bun, local, stdio) → a self-hosted mem0 OSS server (FastAPI + pgvector), set via
`MEM0_API_URL` / `MEM0_API_KEY`. An OpenAI-compatible LLM + embedder back the server; the bridge's
rewriter uses `MEM0_REWRITE_BASE_URL` / `MEM0_REWRITE_MODEL`. Scoping via mem0 `run_id`: project
(git-derived) + global. Search merges both and re-ranks by recency-weighted score.

## Key behaviors
- **infer:true** (default, `MEM0_INFER=0` to disable): the server extracts the fact and reconciles
  it against existing memories (ADD/UPDATE/DELETE/NONE) — dedupe + auto-invalidation of contradicted
  facts. `add` returns one hit per event; adds use a 45s timeout (two LLM calls).
- **HyDE-lite** (`MEM0_QUERY_REWRITE=1`, needs `MEM0_REWRITE_BASE_URL`+`MEM0_REWRITE_MODEL`):
  question queries are rewritten to a declarative statement and searched alongside the raw query.
  Failure or missing config degrades to the raw query.
- **Recency re-rank**: `score * (0.6 + 0.4*exp(-ln2*ageDays/90))` in `mem0.ts`. Tie-breaker, not a
  guillotine.
- **Storage doctrine**: one self-contained declarative fact per entry, name the subject, never a
  bare value. Do NOT store the question (the model handles question/answer asymmetry at query time).
- **Expiry tiers** (`src/expiry.ts`): a memory may carry `expiration_date` (YYYY-MM-DD; `memory_add`
  takes a relative `expires_in_days` and computes it). The server hides expired rows unless
  `show_expired=true`; the bridge always asks with `show_expired=true` and applies its own lifecycle:
  active → recent (1..30d past: shown but sunk to the bottom) → hidden (…180d: filtered from recall)
  → dead (>180d: deleted). GC is lazy — `search`/`list` delete `dead` rows they encounter
  (best-effort, off the hot path). mem0 never deletes on its own. Pins never expire.

## Server-side note
For fact extraction to keep technical detail (paths, hostnames, versions) instead of rewriting into
third-person prose, set a `custom_instructions` prompt on the mem0 server. That is server-side
configuration, outside this repo. Deployment specifics for a given environment do not belong in the
committed tree; keep them in an untracked local file.

## Conventions
- TypeScript/Bun, no Python. Deps in `package.json` / `bun.lock`; `bun install` before running.
- Keep the tool surface lean (10 tools: add/search/list/recent, pin/pins/unpin, update/delete/reset); every tool schema costs context tokens, so add a tool only when a distinct retrieval/write mode justifies it.
- **The skill mirrors the tools.** Any change to the MCP tool surface or behavior (new/removed tool, new argument, changed semantics like pin/unpin) MUST be reflected in `skills/shared-memory/SKILL.md` in the SAME commit — the skill is what agents read to know how to call the tools, so a drift silently teaches wrong usage. Update its quick-reference table and the relevant prose section.
- Never store secrets in memory. `memory_reset` needs the user's token — never invent one.
- No em/en dashes in prose. Short one-sentence commit messages, no prefixes, no generated-by trailers.
