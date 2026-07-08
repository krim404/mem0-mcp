#!/usr/bin/env bun
/**
 * Live integration smoke test against a mem0 server. Scoped to project "selftest".
 * Not a unit test. Env: MEM0_API_URL, MEM0_API_KEY, MEM0_DEFAULT_USER_ID, MEM0_INSECURE_TLS.
 */
import { Mem0Client } from "./mem0";
import { rewriteQuery } from "./rewrite";

const c = new Mem0Client({
  baseUrl: process.env.MEM0_API_URL ?? "http://localhost:8000",
  apiKey: process.env.MEM0_API_KEY,
  defaultUserId: process.env.MEM0_DEFAULT_USER_ID ?? "default",
  project: "selftest",
  insecureTls: process.env.MEM0_INSECURE_TLS === "1",
  infer: process.env.MEM0_INFER !== "0",
});

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Invalid ids must be rejected locally, before any HTTP request.
for (const bad of ["", "not-a-uuid", "../reset"]) {
  try {
    await c.remove(bad);
    fail(`remove("${bad}") did not throw`);
  } catch (e) {
    if (!(e as Error).message.includes("invalid memory_id")) fail(`remove("${bad}") wrong error: ${e}`);
  }
}
console.log("guard -> invalid memory_ids rejected without request");

try {
  await c.reset("   ");
  fail("reset without token did not throw");
} catch (e) {
  if (!(e as Error).message.includes("reset token")) fail(`reset guard wrong error: ${e}`);
}
console.log("guard -> reset without user token rejected without request");

// The query rewriter is best-effort and must never throw, even against an unreachable endpoint,
// so search can always fall back to the raw query.
const badRewrite = await rewriteQuery("does the bridge work?", {
  enabled: true,
  baseUrl: "http://127.0.0.1:1/openai/v1", // nothing listens here
  model: "unused",
});
if (badRewrite !== undefined) fail(`rewriteQuery against a dead endpoint returned ${JSON.stringify(badRewrite)}`);
console.log("rewrite-> unreachable llm endpoint degrades to raw query (no throw)");

// add returns one hit per reconciliation event (infer on) or the stored row (infer off).
const added = await c.add("harness selftest: the shared mem0 bridge stores facts for project scope");
console.log("add   ->", JSON.stringify(added));
if (!Array.isArray(added)) fail("add did not return an array of events");

// The added fact must be findable by a question-style query (semantic, no shared keywords).
const found = await c.search("how do agents remember things across sessions?");
console.log("search->", found.length, "hits");
if (found.length === 0) fail("search returned nothing right after add");
if (found.some((h) => h.id && !h.createdAt && !h.updatedAt))
  fail(`search hit carries no timestamp: ${JSON.stringify(found)}`);
console.log("age   -> search hits carry created_at/updated_at");

const before = await c.list();
console.log("list  ->", before.length, "entries in project scope");

// Round-trip update + delete on the entry we just created (prefer its id from the add events),
// so the store ends where it started.
const targetId = added.find((h) => h.id)?.id ?? before.find((h) => h.id)?.id;
if (!targetId) fail("no memory with id in selftest scope to update/delete");
await c.update(targetId, "harness selftest: updated text");
const afterUpdate = (await c.list()).find((h) => h.id === targetId);
if (!afterUpdate?.memory.includes("updated text")) fail(`update did not stick: ${JSON.stringify(afterUpdate)}`);
console.log("update-> text rewritten");

await c.remove(targetId);
const afterDelete = await c.list();
if (afterDelete.some((h) => h.id === targetId)) fail("deleted memory still listed");
console.log("delete-> entry removed, store consistent");
