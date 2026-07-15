#!/usr/bin/env bun
/**
 * mem0 MCP bridge - a thin stdio MCP server exposing a self-hosted mem0 OSS server as memory
 * tools for any MCP client. No bundled store.
 *
 * Memories are auto-scoped to the current PROJECT (derived from the git top-level / cwd), so
 * recall stays project-relevant. Reserved `global` scope for cross-project facts; `all` for
 * searching everything.
 *
 * Env: MEM0_API_URL (default http://localhost:8000), MEM0_API_KEY (optional, sent as X-API-Key),
 * MEM0_DEFAULT_USER_ID (default "default"), MEM0_INSECURE_TLS=1 (skip TLS verify; prefer
 * NODE_EXTRA_CA_CERTS), MEM0_INFER=0 (store verbatim, skip mem0's extract+reconcile pipeline),
 * MEM0_QUERY_REWRITE=0 (disable HyDE-lite query rewrite), MEM0_REWRITE_BASE_URL /
 * MEM0_REWRITE_MODEL / MEM0_REWRITE_API_KEY (OpenAI-compatible chat endpoint for the rewriter;
 * rewrite stays off until base URL and model are set).
 *
 * Namespace scoping: MEM0_SCOPE_KEY pins every call to one namespace (e.g. a Matrix room id);
 * MEM0_LOCK_SCOPE=1 makes that key win over any per-call `key` (locked-down deployments, so a
 * caller can never reach another namespace); MEM0_EXTRA_READ_SCOPES (comma-separated) are extra
 * namespaces merged into recall only (read, never written).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Mem0Client, detectProject, type MemoryHit, type Scope } from "./mem0";
import { rewriteConfigFromEnv, rewriteQuery } from "./rewrite";
import { computeExpirationDate } from "./expiry";

const PROJECT = detectProject();

const client = new Mem0Client({
  baseUrl: process.env.MEM0_API_URL ?? "http://localhost:8000",
  apiKey: process.env.MEM0_API_KEY,
  defaultUserId: process.env.MEM0_DEFAULT_USER_ID ?? "default",
  project: PROJECT,
  insecureTls: process.env.MEM0_INSECURE_TLS === "1",
  infer: process.env.MEM0_INFER !== "0", // default on: let mem0 extract + reconcile facts
  scopeKey: process.env.MEM0_SCOPE_KEY || undefined, // pin all ops to one namespace (e.g. a Matrix room id)
  lockScope: process.env.MEM0_LOCK_SCOPE === "1", // force scopeKey over any per-call key (locked-down deployments)
  extraReadScopes: (process.env.MEM0_EXTRA_READ_SCOPES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean), // extra read-only namespaces merged into recall
});

const rewriteCfg = rewriteConfigFromEnv();

const STORE_SCOPE = {
  type: "string",
  enum: ["project", "global"],
  description: `'project' (default, '${PROJECT}') or 'global' (cross-project).`,
};
const READ_SCOPE = {
  type: "string",
  enum: ["project", "global", "all"],
  description: "Default 'project' (= project + global merged); 'all' = every project.",
};
const KEY_PROP = {
  type: "string",
  description:
    "Optional namespace key (e.g. a Matrix room id). When set, pins storage/recall to exactly that namespace, overriding `scope`. Leave unset for normal project/global scoping. When the server already has a scope configured (a room deployment), leave it unset too; only pass it to deliberately target a different namespace.",
};
const SOURCE_PROP = {
  type: "string",
  description:
    "Optional metadata filter. When set, return ONLY memories tagged with this source, e.g. 'summary' for machine-generated idle-conversation summaries. Leave unset to include everything.",
};

const TOOLS = [
  {
    name: "memory_add",
    description:
      "Store one durable, self-contained fact/decision in shared memory. mem0 extracts the fact and reconciles it against existing memories (dedupes, updates a contradicted entry); the result reports what changed. Decide permanence: leave permanent by default (why-decisions, identity, standing conventions); set expires_in_days for TEMPORARY facts (work just done, a bug that used to exist, current status) so they fade automatically.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The single self-contained fact to store. This IS the memory content itself, not a namespace/id. REQUIRED and must be non-empty.",
        },
        scope: STORE_SCOPE,
        key: KEY_PROP,
        expires_in_days: {
          type: "number",
          description:
            "Optional. Mark this fact TEMPORARY: it expires this many days from now, after which it sinks in recall, then drops out (~1 month), then is deleted (~6 months). Omit for permanent facts.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_search",
    description:
      "Semantic search over shared memory; call before non-trivial tasks. Question-style queries are handled (rewritten internally); results are recency-weighted. Each hit includes its age; treat old entries as hints to re-verify, not hard facts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: READ_SCOPE,
        limit: { type: "number", description: "Max results (default 5)." },
        key: KEY_PROP,
        source: SOURCE_PROP,
      },
      required: ["query"],
    },
  },
  {
    name: "memory_list",
    description: "List memories in a scope (server-capped page; use memory_search for semantic recall). Pass `source` to list only one kind (e.g. machine summaries).",
    inputSchema: {
      type: "object",
      properties: { scope: READ_SCOPE, limit: { type: "number" }, key: KEY_PROP, source: SOURCE_PROP },
      required: [],
    },
  },
  {
    name: "memory_recent",
    description:
      "Return the MOST RECENT memories first (time-based, e.g. 'the last 10 entries'). Distinct from memory_search (relevance) and memory_list (inspection). Good for recovering recent context when there is no specific query.",
    inputSchema: {
      type: "object",
      properties: { scope: READ_SCOPE, limit: { type: "number", description: "How many recent entries (default 10)." }, key: KEY_PROP, source: SOURCE_PROP },
      required: [],
    },
  },
  {
    name: "memory_pin",
    description:
      "Pin a HARD, always-relevant fact (AGENTS.md-like) that must be surfaced on EVERY load, not just when semantically relevant. Kept out of normal search/recall. Pass `text` to pin a NEW verbatim fact, OR `memory_id` to pin an EXISTING memory in place (promote it to always-load, keeping its text). scope 'global' = applies everywhere; 'local' = only this namespace (room/project).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The hard fact / instruction to always load (for a NEW pin). Omit when pinning an existing memory via memory_id." },
        memory_id: { type: "string", description: "UUID of an EXISTING memory to pin in place (mutually exclusive with text)." },
        scope: { type: "string", enum: ["global", "local"], description: "'local' (default, this room/project) or 'global' (everywhere). Only for a new pin." },
        key: KEY_PROP,
      },
      required: [],
    },
  },
  {
    name: "memory_pins",
    description:
      "Return ALL pinned hard facts that apply now: global pins + local pins for this namespace. Call this at the START of a task (like reading AGENTS.md) to load standing context/instructions. Distinct from search/list/recent.",
    inputSchema: { type: "object", properties: { key: KEY_PROP }, required: [] },
  },
  {
    name: "memory_unpin",
    description: "Unpin a fact by its UUID (as shown by memory_pins): demotes it back to an ordinary memory (the knowledge stays, it just no longer always-loads). Use memory_delete to remove it entirely.",
    inputSchema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] },
  },
  {
    name: "memory_update",
    description: "Rewrite one memory's text by UUID (fix stale/wrong facts).",
    inputSchema: {
      type: "object",
      properties: { memory_id: { type: "string" }, text: { type: "string" } },
      required: ["memory_id", "text"],
    },
  },
  {
    name: "memory_delete",
    description: "Delete one memory by UUID. No bulk delete.",
    inputSchema: { type: "object", properties: { memory_id: { type: "string" } }, required: ["memory_id"] },
  },
  {
    name: "memory_reset",
    description:
      "IRREVERSIBLY wipe ALL memories (every project and scope). Requires the user's secret reset token: ALWAYS ask the user for it first. Never guess, reuse, or invent a token.",
    inputSchema: {
      type: "object",
      properties: {
        reset_token: { type: "string", description: "Secret token known only to the user; ask them for it." },
      },
      required: ["reset_token"],
    },
  },
];

/**
 * Extract and validate the `text` argument for a write. mem0 stores the memory content from here,
 * so an empty/missing value is a caller mistake (the model put the fact elsewhere, e.g. in `key`).
 * Fail loudly instead of silently storing the string "undefined".
 */
function requireText(args: Record<string, unknown>): string {
  const t = String(args.text ?? "").trim();
  if (!t) throw new Error("nothing stored: `text` is required and must be non-empty; pass the fact itself as `text`.");
  return t;
}

/** Compact age of a memory ("<1h", "5h", "3d", "2mo") so staleness is visible at recall time. */
function formatAge(iso?: string): string {
  const ts = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(ts)) return "-";
  const hours = Math.max(0, Date.now() - ts) / 3_600_000;
  if (hours < 1) return "<1h";
  if (hours < 48) return `${Math.round(hours)}h`;
  if (hours < 24 * 60) return `${Math.round(hours / 24)}d`;
  return `${Math.round(hours / (24 * 30))}mo`;
}

/** Token-lean result rendering: one line per hit (id, score, age, text), no JSON scaffolding. */
function formatHits(hits: MemoryHit[]): string {
  if (hits.length === 0) return "no results";
  return hits
    .map((h) =>
      [
        h.id ?? "-",
        h.score !== undefined ? h.score.toFixed(2) : "-",
        formatAge(h.updatedAt ?? h.createdAt),
        h.memory,
      ].join("\t"),
    )
    .join("\n");
}

/**
 * Render add-time reconciliation events so the agent sees what mem0 did with the fact: ADD (new),
 * UPDATE (rewrote a contradicted/overlapping entry), DELETE (removed an obsolete one), NONE
 * (nothing durable extracted / duplicate). One line per event: "EVENT<TAB>text".
 */
function formatEvents(events: MemoryHit[]): string {
  const meaningful = events.filter((e) => (e.event ?? "").toUpperCase() !== "NONE");
  if (meaningful.length === 0) return "stored (no change: nothing new extracted or duplicate)";
  return meaningful.map((e) => `${(e.event ?? "ADD").toUpperCase()}\t${e.memory}`).join("\n");
}

const server = new Server({ name: "mem0-bridge-mcp", version: "0.5.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let text: string;
    switch (name) {
      case "memory_add": {
        const key = args.key ? String(args.key) : undefined;
        const days = Number(args.expires_in_days);
        const expiration = Number.isFinite(days) && days > 0 ? computeExpirationDate(days) : undefined;
        const events = await client.add(requireText(args), (args.scope as Scope) ?? "project", key, expiration);
        text = formatEvents(events);
        break;
      }
      case "memory_search": {
        const query = String(args.query);
        const key = args.key ? String(args.key) : undefined;
        const source = args.source ? String(args.source) : undefined;
        // HyDE-lite: search the raw question AND a declarative rewrite of it (best-effort).
        const rewritten = await rewriteQuery(query, rewriteCfg);
        const extra = rewritten ? [rewritten] : [];
        text = formatHits(
          await client.search(query, (args.scope as Scope) ?? "project", (args.limit as number) ?? 5, extra, key, source),
        );
        break;
      }
      case "memory_list": {
        const key = args.key ? String(args.key) : undefined;
        const source = args.source ? String(args.source) : undefined;
        text = formatHits(await client.list((args.scope as Scope) ?? "project", args.limit as number | undefined, key, false, source));
        break;
      }
      case "memory_recent": {
        const key = args.key ? String(args.key) : undefined;
        const source = args.source ? String(args.source) : undefined;
        text = formatHits(await client.list((args.scope as Scope) ?? "project", (args.limit as number) ?? 10, key, true, source));
        break;
      }
      case "memory_pin": {
        if (args.memory_id) {
          // Promote an EXISTING memory to a pin in place (retroactively pin known knowledge).
          const id = String(args.memory_id);
          await client.pinExisting(id);
          text = `pinned existing memory ${id}`;
          break;
        }
        const key = args.key ? String(args.key) : undefined;
        const scope = (args.scope as "global" | "local") ?? "local";
        const fact = requireText(args);
        const hits = await client.addPin(fact, scope, key);
        text = `pinned (${scope}): ${hits.map((h) => h.memory).filter(Boolean).join(" | ") || fact}`;
        break;
      }
      case "memory_pins": {
        const key = args.key ? String(args.key) : undefined;
        const { global, local } = await client.listPins(key);
        const fmt = (hits: MemoryHit[], tag: string) =>
          hits.map((h) => `[${tag}] ${h.id ?? "-"}\t${h.memory}`).join("\n");
        const parts = [fmt(global, "global"), fmt(local, "local")].filter(Boolean);
        text = parts.length ? parts.join("\n") : "no pinned facts";
        break;
      }
      case "memory_unpin":
        await client.unpinExisting(String(args.memory_id));
        text = `unpinned (demoted to a normal memory) ${args.memory_id}`;
        break;
      case "memory_update":
        await client.update(String(args.memory_id), requireText(args));
        text = `updated ${args.memory_id}`;
        break;
      case "memory_delete":
        await client.remove(String(args.memory_id));
        text = `deleted ${args.memory_id}`;
        break;
      case "memory_reset":
        await client.reset(String(args.reset_token ?? ""));
        text = "memory store reset (all scopes wiped)";
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: `memory error: ${(err as Error).message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error(`mem0-bridge MCP running on stdio (project scope: ${PROJECT})`);
