---
name: shared-memory
description: Use when starting any non-trivial task (recall prior context first) or after making a decision, learning a durable fact, or hitting a gotcha (store it). Triggers the shared mem0 memory MCP tools memory_search and memory_add.
---

# shared-memory

## Overview
A shared memory lives in a mem0 MCP (`memory_search` / `memory_add`), auto-scoped to the current
project so recall stays relevant. Core principle: **recall before you re-derive, remember what
will matter next time.** Memory is optional; if it is unavailable, proceed and never block.

## When to use
- **Before** a non-trivial task: `memory_search` the topic to reuse prior decisions, conventions,
  and gotchas instead of re-discovering them.
- **After** a decision, a durable fact, or a gotcha: `memory_add` it, short and specific.
- Not for transient chatter, secrets, or unpublished sensitive data.

## Quick reference
| Action | Tool | Default scope |
|---|---|---|
| Recall | `memory_search(query)` | current project **+ global**, merged |
| Recall global only | `memory_search(query, scope="global")` | global |
| Recall everything | `memory_search(query, scope="all")` | all projects |
| Store project fact | `memory_add(text)` | current project |
| Store cross-project fact | `memory_add(text, scope="global")` | global |
| Inspect a scope | `memory_list(scope?, limit?)` | current project |
| Fix a stale/wrong fact | `memory_update(memory_id, text)` | by UUID |
| Remove a fact | `memory_delete(memory_id)` | by UUID |
| Wipe the whole store | `memory_reset(reset_token)` | ALL projects, irreversible |

`memory_reset` erases everything across all projects. It only works with the user's secret
reset token: always ask the user for the token first and confirm they really want the wipe.
Never guess or reuse a token, and never call reset on your own initiative.

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

## Common mistakes
- Skipping the pre-task recall, then re-deriving something already decided.
- Storing a bare value with no subject (`registry.example.com`) — meaningless and unfindable later.
- Storing session-transient state ("X not implemented yet") instead of the final fact.
- Trusting an old hit blindly instead of re-verifying it against the code.
- Changing a fact during the run without updating the memory entries that state it.
- Storing long transcripts. Store one distilled fact per entry.
- Putting a cross-cutting convention in a project scope. Use `scope="global"`.
- Storing secrets or credentials. Never.
