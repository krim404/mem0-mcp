---
name: shared-memory
description: "Use when starting any non-trivial task (recall prior context first) or after making a decision, learning a durable fact, or hitting a gotcha (store it). This is the shared cross-agent memory: the mem0 MCP tools memory_search / memory_add (mcp__mem0__*). It applies in EVERY project regardless of repo wiring or a project CLAUDE.md. This is NOT the agent's built-in file-based memory: to recall or store here, never use the Write tool, never create or edit markdown under a .claude memory directory, and never touch MEMORY.md."
---

# shared-memory

## Overview
A shared memory lives in a mem0 MCP (`memory_search` / `memory_add`), auto-scoped to the current
project so recall stays relevant. Core principle: **recall before you re-derive, remember what
will matter next time.** Memory is optional; if it is unavailable, proceed and never block.

## This is the mem0 MCP, not the file-based memory
**Read this before you store or recall anything.** `memory_search` and `memory_add` are **MCP
tool calls** (`mcp__mem0__memory_search`, `mcp__mem0__memory_add`, and the other `mcp__mem0__*`
tools). You invoke them through the tool-call mechanism, exactly like any other tool.

The shared memory does **not** live in files. When this skill says recall or store, that means a
mem0 MCP tool call and nothing else:
- **Never** use the Write tool to record a memory.
- **Never** create or edit a markdown file under any `.claude/**/memory/` path.
- **Never** add or update an entry in `MEMORY.md`.
- **Never** read those files to "recall"; recall is a `memory_search` tool call.

The agent's built-in file-based memory (per-agent markdown files + a `MEMORY.md` index) is a
**separate, local-only feature**. It is not this skill, and other agents cannot see it. This skill
is the one shared store every agent reads and writes. If both seem to apply to "remembering," this
one governs the shared memory; route the fact here via the MCP tools.

**This skill applies in every project.** It does not need any repo wiring, mem0 config, or a
project `CLAUDE.md` to be in effect. The only precondition is that the `mem0` MCP tools are
reachable. A generic project with no memory docs is still a project where you use these tools. The
absence of mem0 wiring in a repo is **not** a reason to fall back to the file-based memory; it is
only a reason to skip memory entirely if the MCP tools genuinely error.

## When to use
- **At the START of a task**: call `memory_pins` to load standing hard facts / instructions
  (AGENTS.md-like context that must always apply), before anything else.
- **Before** a non-trivial task: `memory_search` the topic to reuse prior decisions, conventions,
  and gotchas instead of re-discovering them. With no specific query (recovering context),
  use `memory_recent` for the last N entries.
- **After essentially every insight** — save VERY often, not just at the end. `memory_add` both
  hard facts (root causes, fixes, configs, decisions) AND soft/personal ones (user preferences,
  tone, conventions — e.g. "the user dislikes being called Wurstbrot"). Don't worry about
  duplicates: the server dedups and reconciles on add. Keep each entry one self-contained fact.
- **Never** store transient/ephemeral states or moods (e.g. "I'm tired", "don't want to talk
  right now"), transient chatter, secrets, or unpublished sensitive data. Durable facts and
  lasting preferences only.
- Three retrieval modes, kept distinct: `memory_search` = relevance, `memory_recent` = newest,
  `memory_list` = raw inspection.

## Quick reference
| Action | Tool | Default scope |
|---|---|---|
| Recall | `memory_search(query)` | current project **+ global**, merged |
| Recall global only | `memory_search(query, scope="global")` | global |
| Recall everything | `memory_search(query, scope="all")` | all projects |
| Store project fact | `memory_add(text)` | current project |
| Store cross-project fact | `memory_add(text, scope="global")` | global |
| Store/recall in a named namespace | `memory_add(text, key="<id>")` / `memory_search(query, key="<id>")` | exactly `<id>` |
| Inspect a scope | `memory_list(scope?, limit?)` | current project |
| Recent entries (by time) | `memory_recent(limit?)` | most recent first |
| Load always-on hard facts | `memory_pins()` | global + local pins |
| Pin an always-on hard fact | `memory_pin(text, scope?)` | `local` (default) or `global` |
| Remove a pin | `memory_unpin(memory_id)` | by UUID |
| Fix a stale/wrong fact | `memory_update(memory_id, text)` | by UUID |
| Remove a fact | `memory_delete(memory_id)` | by UUID |
| Wipe the whole store | `memory_reset(reset_token)` | ALL projects, irreversible |

`memory_reset` erases everything across all projects. It only works with the user's secret
reset token: always ask the user for the token first and confirm they really want the wipe.
Never guess or reuse a token, and never call reset on your own initiative.

## Namespace key (per-context scoping)
Every read/write tool takes an optional `key`. When set, it pins the operation to exactly that
namespace and overrides `scope` — use it to keep contexts fully separate, e.g. one Matrix room's
notes from another's. Recall with the same `key` you stored with:
`memory_add(text, key="!room:server")`, `memory_search(query, key="!room:server")`. When your
context tells you which key to use (for example a room persona that names the key), always pass it.
The server can also be started with `MEM0_SCOPE_KEY` to force a single key for every call without
passing it explicitly. Leave `key` unset for normal project/global scoping.

## Pinned hard facts (always loaded)
Most memories surface only when semantically relevant to a search. A **pin** is different: it is a
hard, standing fact or instruction that must be loaded on EVERY task, like reading an `AGENTS.md`.
- **Load pins at the start of a task** with `memory_pins()` — it returns the global pins plus the
  local pins for the current namespace. Do this before `memory_search`, as the first step.
- **Pin** with `memory_pin(text)`: stored verbatim (never reworded or reconciled), kept out of
  normal search/list, never decayed. `scope="local"` (default) applies to this room/project;
  `scope="global"` applies everywhere. Pinning the same text twice is a no-op (deduped).
- Use a pin for a rule that must never be missed (a hard constraint, a persona instruction, a
  standing convention). Use a normal `memory_add` for an ordinary fact that only matters when the
  topic comes up. When in doubt, `memory_add` — pins are always-on context and cost tokens every load.
- Remove an obsolete pin with `memory_unpin(memory_id)` (the id shown by `memory_pins`).

## Writing memories that can be found again
Store **one self-contained declarative fact** per entry. The embedding model matches a future
question against the fact's meaning, so the fact must name its own subject and stand on its own
without the surrounding task context. You do **not** store the question: search rewrites
question-style queries internally, and the model handles the question/answer gap on its side.

- Name the subject; never store a bare value:
  - Good: `Production container images for this project are pushed to registry.example.com under the 'api' project`
  - Good: `The staging environment runs Postgres 16`
  - Bad: `registry.example.com` (no subject, no topic: unfindable and meaningless later)
- When the user says "remember this", store the settled fact, phrased so it makes sense to a
  session that never saw this conversation.

## What `memory_add` does with your fact
The server extracts the durable fact and **reconciles it against existing memories**: it dedupes a
repeat, rewrites an entry your fact contradicts, and drops one it makes obsolete. The result
reports what changed (`ADD` / `UPDATE` / `DELETE`, or "no change" when nothing new was extracted or
it was a duplicate). So you do not need to hunt down and hand-edit an older entry that your new fact
supersedes: add the correct current fact and let reconciliation retire the stale one. Read the
result to confirm it landed the way you expected.

## Store only final facts
Never store state that is expected to change within the session. If the task is to implement X,
do not store "X is not implemented yet" — by the end of the run that entry is wrong. Store the
**final** state once it is settled ("X implemented in src/foo.ts, approach: ...").
Rule of thumb: only add a memory when the fact would still be true if the session ended now
and the next session started tomorrow.

## Recall results are hints, not hard facts
Every search hit carries its **age** (`<1h`, `5h`, `3d`, `2mo`) and ranking is recency-weighted, so
a fresh fact outranks an equally-relevant stale one (an old but strongly matching entry still
surfaces). Memories can be outdated: the code, config, or decision may have changed since they were
written.
- Treat old entries as **hints to re-verify**, not as ground truth. The more change-prone the
  topic (versions, endpoints, implementation status), the more critical the re-check against
  the actual code/reality before relying on it.
- A fresh entry about a stable convention can be trusted; an old entry about a moving target
  must be re-evaluated first.

## Keeping memory correct
Reconciliation on add (above) handles most drift: re-adding the corrected fact retires what it
contradicts. `memory_update` / `memory_delete` stay for **targeted** fixes reconciliation will not
catch on its own:
- Recall surfaced a plainly wrong or obsolete entry that no new fact will supersede: `memory_search`
  for its id, then `memory_update(memory_id, corrected_text)`, or `memory_delete(memory_id)` when it
  is simply garbage. Keep the replacement text self-contained.
- **A fact changed during this run** (your task moved an endpoint or convention): add the new fact;
  if you can already see the stale entry, fix it directly rather than leaving a contradiction to be
  reconciled later.

Note: `memory_list` returns a server-capped page, not the full store; use `memory_search`
for recall. If a memory tool errors, continue the task without memory.

## Red flags: you are about to use the wrong memory
Stop if you catch yourself doing any of these; route to the mem0 MCP tools instead.
- Reaching for the **Write tool** to save a fact, or picking a `.md` file path for it.
- Editing `MEMORY.md` or a file under `.claude/**/memory/` to record something.
- Thinking "this project has no mem0 wiring, so the skill does not apply"; it applies whenever
  the `mem0` tools are reachable, wiring or not.
- Thinking "file memory is my default, I'll use mem0 only if told"; for the shared memory the
  mem0 MCP is the default and the only store; the file memory is a different thing.
- "Reading" old memory files to recall; recall is a `memory_search` tool call.

## Common mistakes
- Writing a markdown memory file (or a `MEMORY.md` line) instead of calling `memory_add`. That
  lands in the local file memory no other agent can see; call the `mcp__mem0__memory_add` tool.
- Skipping the pre-task recall, then re-deriving something already decided.
- Storing a bare value with no subject (`registry.example.com`) — meaningless and unfindable later.
- Storing session-transient state ("X not implemented yet") instead of the final fact.
- Trusting an old hit blindly instead of re-verifying it against the code.
- Changing a fact during the run without updating the memory entries that state it.
- Storing long transcripts. Store one distilled fact per entry.
- Putting a cross-cutting convention in a project scope. Use `scope="global"`.
- Storing secrets or credentials. Never.
