# mem0-mcp

Self-hosted agent memory: a thin **stdio MCP bridge** to a [mem0](https://github.com/mem0ai/mem0)
OSS server, plus the **`shared-memory` skill** that teaches agents how to use it.

Two parts:
- `src/` — the MCP bridge (`mem0-bridge-mcp`), a small TypeScript/Bun stdio server.
- `skills/shared-memory/` — the discipline skill (recall before re-deriving, store durable facts).

Spec-driven development (SDD), coded with Claude Fable.

## Backend

The bridge talks to any self-hosted mem0 OSS server (FastAPI + Postgres/pgvector), configured via
`MEM0_API_URL` / `MEM0_API_KEY`. Memories are namespaced by mem0's `run_id`: an auto-derived
**project** scope (git remote repo name, else git top-level / cwd) plus a reserved **global** scope
for cross-project facts. Default search merges project + global.

For the reconcile-on-add and question-rewrite features the server needs an LLM and an embedder
(any OpenAI-compatible endpoint). To keep fact extraction from rewriting technical facts into
third-person prose, set a `custom_instructions` prompt on the mem0 server (see mem0 docs).

## Tools
| Tool | Purpose |
|---|---|
| `memory_add(text, scope?)` | store one durable fact; mem0 extracts + reconciles it (dedupe / update / delete), result reports what changed |
| `memory_search(query, scope?, limit?)` | semantic recall (`project` = project + global merged, `global`, `all`) |
| `memory_list(scope?, limit?)` | list a scope (server caps the page; use search for recall) |
| `memory_update(memory_id, text)` | rewrite one memory by UUID |
| `memory_delete(memory_id)` | delete one memory by UUID; no bulk delete exposed |
| `memory_reset(reset_token)` | irreversibly wipe the whole store; token-gated (see below) |

Destructive safety: `memory_id` is validated as a UUID before any request, and redirects are never
followed (a trailing-slash 307 could otherwise reroute a DELETE onto the server's delete-all route).
`memory_reset` only works with a secret reset token sent as `X-Reset-Token`; the token is known to
the human user alone, so an agent must ask for it before every reset and can never wipe the store on
its own. Requests time out after 10s (adds after 45s, since `infer:true` runs two LLM calls).

Search/list hits render as one tab-separated line per memory: `id  score  age  text`. The age
(`<1h`, `5h`, `3d`, `2mo`, from `updated_at`/`created_at`) makes staleness visible at recall time.
Results are re-ranked by a recency-weighted score (half-life 90d, floor 0.6), so a fresh fact
outranks an equally-relevant stale one without hiding a strongly matching old entry.

**Question-style recall (HyDE-lite):** before searching, a question query is rewritten by an LLM
into one short declarative statement and searched alongside the raw query (answer-to-answer match).
Best-effort: if the LLM is disabled, unreachable, or slow, search silently falls back to the raw
query and never blocks.

## Config (env)
| var | default | notes |
|---|---|---|
| `MEM0_API_URL` | `http://localhost:8000` | mem0 OSS server base URL |
| `MEM0_API_KEY` | unset | sent as `X-API-Key` when set |
| `MEM0_DEFAULT_USER_ID` | `default` | mem0 `user_id` owner scope |
| `MEM0_INSECURE_TLS` | unset | `1` = skip TLS verify for self-signed certs; prefer `NODE_EXTRA_CA_CERTS` |
| `MEM0_INFER` | `1` | `0` = store text verbatim, skipping mem0's extract + reconcile pipeline |
| `MEM0_QUERY_REWRITE` | `1` | `0` = disable the HyDE-lite query rewrite |
| `MEM0_REWRITE_BASE_URL` | unset | OpenAI-compatible chat base URL for the rewriter; rewrite stays off until set |
| `MEM0_REWRITE_MODEL` | unset | chat model id for the rewriter; rewrite stays off until set |
| `MEM0_REWRITE_API_KEY` | unset | optional `Bearer` token for the chat endpoint |

## Install & run
Requires [Bun](https://bun.sh) (the optional `MEM0_INSECURE_TLS` uses Bun's fetch `tls` extension;
plain Node is not supported). Dependencies are declared in `package.json` / `bun.lock` (there is no
Python requirements.txt — this is a Bun project).

```bash
bun install            # installs @modelcontextprotocol/sdk and dev types
bun run src/index.ts   # stdio MCP server
```

## Register in Claude Code
```bash
claude mcp add mem0 \
  --env MEM0_API_URL=https://your-mem0-host \
  --env MEM0_API_KEY=your-key \
  -- bun run /path/to/mem0-mcp/src/index.ts
```

## Verify (hits the configured server)
```bash
MEM0_API_URL=… MEM0_API_KEY=… bun run src/selftest.ts        # live smoke test
MEM0_API_URL=… MEM0_API_KEY=… bun run src/retrieval-eval.ts  # hit@k for question-style queries
```

## The skill
`skills/shared-memory/SKILL.md` is symlinked into each agent's skill directory (Claude Code:
`~/.claude/skills/shared-memory`; Pi: `~/.pi/agent/skills/shared-memory`). It documents when to
recall, how to write self-contained facts, and that the server reconciles contradictions on add.
