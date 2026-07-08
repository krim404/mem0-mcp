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
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Mem0Client, detectProject, type MemoryHit, type Scope } from "./mem0";
import { rewriteConfigFromEnv, rewriteQuery } from "./rewrite";

const PROJECT = detectProject();

const client = new Mem0Client({
  baseUrl: process.env.MEM0_API_URL ?? "http://localhost:8000",
  apiKey: process.env.MEM0_API_KEY,
  defaultUserId: process.env.MEM0_DEFAULT_USER_ID ?? "default",
  project: PROJECT,
  insecureTls: process.env.MEM0_INSECURE_TLS === "1",
  infer: process.env.MEM0_INFER !== "0", // default on: let mem0 extract + reconcile facts
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

const TOOLS = [
  {
    name: "memory_add",
    description:
      "Store one durable, self-contained fact/decision in shared memory. mem0 extracts the fact and reconciles it against existing memories (dedupes, updates a contradicted entry); the result reports what changed.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The fact to remember." }, scope: STORE_SCOPE },
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
      },
      required: ["query"],
    },
  },
  {
    name: "memory_list",
    description: "List memories in a scope (server-capped page; use memory_search for recall).",
    inputSchema: {
      type: "object",
      properties: { scope: READ_SCOPE, limit: { type: "number" } },
      required: [],
    },
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

const server = new Server({ name: "mem0-bridge", version: "0.5.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    let text: string;
    switch (name) {
      case "memory_add": {
        const events = await client.add(String(args.text), (args.scope as Scope) ?? "project");
        text = formatEvents(events);
        break;
      }
      case "memory_search": {
        const query = String(args.query);
        // HyDE-lite: search the raw question AND a declarative rewrite of it (best-effort).
        const rewritten = await rewriteQuery(query, rewriteCfg);
        const extra = rewritten ? [rewritten] : [];
        text = formatHits(
          await client.search(query, (args.scope as Scope) ?? "project", (args.limit as number) ?? 5, extra),
        );
        break;
      }
      case "memory_list":
        text = formatHits(await client.list((args.scope as Scope) ?? "project", args.limit as number | undefined));
        break;
      case "memory_update":
        await client.update(String(args.memory_id), String(args.text));
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
