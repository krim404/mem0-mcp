/**
 * Minimal REST client for a self-hosted mem0 server.
 * Targets the OSS server API (optional X-API-Key auth, /memories + /search), not the cloud
 * platform.
 *
 * Scoping: memories are namespaced by mem0's `run_id`. We auto-derive a PROJECT id from the git
 * remote repo name (portable across machines), else the git top-level / cwd folder name, so recall
 * stays project-relevant and the store does not turn into one cross-project pile. A reserved
 * `global` scope holds cross-project facts; `all` searches everything for the user.
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export type Scope = "project" | "global" | "all";
export const GLOBAL_SCOPE = "global";

const REQUEST_TIMEOUT_MS = 10_000;
// An add runs mem0's extract + reconcile pipeline (two LLM calls under infer:true), so it needs a
// longer budget than a plain vector read/write.
const ADD_TIMEOUT_MS = 45_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Per (scope, query) request we fetch `limit + this` rows, then merge/re-rank/trim to `limit` once,
// so a borderline hit that recency re-rank would promote is not lost at the per-request boundary.
const SEARCH_OVERFETCH = 5;

// Recency re-rank: a matching memory's score is scaled by how recently it was written, so a
// stale hit sinks below a comparable fresh one. Decay is a tie-breaker, not a guillotine -- the
// floor keeps a strong old convention findable, it just yields to an equally strong recent fact.
const DECAY_HALF_LIFE_DAYS = 90; // after this age the recency factor has dropped halfway to the floor
const DECAY_FLOOR = 0.6; // minimum recency factor: an ancient entry keeps 60% of its raw score
const MS_PER_DAY = 86_400_000;

function git(args: string[]): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stable, portable project id. Prefers the git remote's repo name (identical on every machine,
 * independent of the local clone folder name), then the git top-level dir name, then the cwd
 * folder name when it is not a repo. Slugified; empty -> "default".
 */
export function detectProject(): string {
  // 1. git remote repo name: strip trailing slashes and ".git", take the last path/host segment.
  //    Handles url (ssh://.../owner/repo.git, https://.../repo.git) and scp (git@host:owner/repo.git) forms.
  const remote = git(["config", "--get", "remote.origin.url"]) ?? git(["remote", "get-url", "origin"]);
  let name = remote
    ? remote.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop()
    : undefined;
  // 2. no remote -> git top-level folder name; not a repo -> cwd folder name.
  if (!name) name = basename(git(["rev-parse", "--show-toplevel"]) ?? process.cwd());
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "default";
}

export interface Mem0Config {
  baseUrl: string;       // e.g. http://localhost:8000
  apiKey?: string;       // sent as X-API-Key when set (server may run without auth)
  defaultUserId: string; // owner scope
  project: string;       // auto-detected project id (run_id)
  insecureTls?: boolean; // skip TLS verify for self-signed certs; prefer NODE_EXTRA_CA_CERTS
  infer?: boolean;       // let mem0 extract + reconcile facts on add (default true); false = store verbatim
  scopeKey?: string;     // explicit namespace override (e.g. a Matrix room id); from MEM0_SCOPE_KEY
  extraReadScopes?: string[]; // extra run_ids merged into SEARCH only (read-only); from MEM0_EXTRA_READ_SCOPES
}

export interface MemoryHit {
  id?: string;
  memory: string;
  score?: number;
  createdAt?: string; // ISO timestamp from the server, when present
  updatedAt?: string;
  event?: string;     // add-time reconciliation outcome: ADD | UPDATE | DELETE | NONE (infer mode)
}

/** Recency factor in [DECAY_FLOOR, 1] for an entry's age; missing timestamp => 1 (no penalty). */
function recencyFactor(iso?: string): number {
  const ts = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(ts)) return 1;
  const ageDays = Math.max(0, Date.now() - ts) / MS_PER_DAY;
  return DECAY_FLOOR + (1 - DECAY_FLOOR) * Math.exp((-Math.LN2 * ageDays) / DECAY_HALF_LIFE_DAYS);
}

/** Thin wrapper over the mem0 REST API. One responsibility: talk to mem0. */
export class Mem0Client {
  constructor(private readonly cfg: Mem0Config) {}

  /**
   * The run_id to use for a scope. An explicit `key` (per-call arg, else the configured
   * `scopeKey`) overrides everything and pins storage/recall to that namespace — this is
   * how a Matrix room id scopes memory. Otherwise: `all` -> undefined (everything),
   * `global` -> the reserved global scope, `project` -> the auto-detected project.
   */
  private runId(scope: Scope, key?: string): string | undefined {
    const k = key ?? this.cfg.scopeKey;
    if (k) return k;
    if (scope === "all") return undefined;
    if (scope === "global") return GLOBAL_SCOPE;
    return this.cfg.project;
  }

  /** Reject anything that is not a plain memory UUID before it reaches the API. */
  private static assertMemoryId(memoryId: string): void {
    if (!UUID_RE.test(memoryId)) throw new Error(`invalid memory_id (expected UUID): "${memoryId}"`);
  }

  private async request(path: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.apiKey) headers["X-API-Key"] = this.cfg.apiKey;
    const opts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      // Never follow redirects: a 307 on a trailing slash could silently reroute a
      // single-memory DELETE onto the server's scoped delete-all route.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (this.cfg.insecureTls) opts.tls = { rejectUnauthorized: false };
    const res = await fetch(`${this.cfg.baseUrl}${path}`, opts);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`mem0 ${init.method ?? "GET"} ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  private static toHits(data: unknown): MemoryHit[] {
    const rows = Array.isArray(data) ? data : ((data as { results?: unknown[] })?.results ?? []);
    return rows.map((r: any) => ({
      id: r.id,
      memory: r.memory ?? r.data ?? "",
      score: r.score,
      createdAt: r.created_at ?? undefined,
      updatedAt: r.updated_at ?? undefined,
      event: r.event ?? undefined,
    }));
  }

  /**
   * Store a message. By default mem0 extracts durable facts and reconciles them against existing
   * memories (ADD / UPDATE / DELETE / NONE), which dedupes and invalidates contradicted facts on
   * its own. Set infer=false (MEM0_INFER=0) to store the text verbatim without that pipeline.
   * Returns one hit per reconciliation event so the caller can see what changed.
   */
  async add(text: string, scope: Scope = "project", key?: string): Promise<MemoryHit[]> {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: text }],
      user_id: this.cfg.defaultUserId,
      infer: this.cfg.infer ?? true,
    };
    const run = this.runId(scope === "all" ? "project" : scope, key); // never add without a scope
    if (run) body.run_id = run;
    const data = await this.request("/memories", { method: "POST", body: JSON.stringify(body) }, ADD_TIMEOUT_MS);
    return Mem0Client.toHits(data);
  }

  private async searchScope(query: string, runId: string | undefined, limit: number): Promise<MemoryHit[]> {
    const body: Record<string, unknown> = { query, user_id: this.cfg.defaultUserId, limit };
    if (runId) body.run_id = runId;
    const data = await this.request("/search", { method: "POST", body: JSON.stringify(body) });
    return Mem0Client.toHits(data);
  }

  /**
   * The run scopes a search fans out over. An explicit `key` (per-call, else configured
   * `scopeKey`) pins the search to that single namespace. Otherwise: 'project' spans
   * project + global, others map 1:1.
   */
  private searchRunIds(scope: Scope, key?: string): (string | undefined)[] {
    const k = key ?? this.cfg.scopeKey;
    if (k) return [k];
    if (scope === "all") return [undefined];
    if (scope === "global") return [GLOBAL_SCOPE];
    return [this.cfg.project, GLOBAL_SCOPE];
  }

  /**
   * Semantic search. Default 'project' searches the current project AND the global scope, merged,
   * so cross-project knowledge always surfaces. 'global' = global only, 'all' = everything.
   *
   * `extraQueries` are alternate phrasings of the same intent (e.g. a HyDE-rewritten query); each
   * is searched alongside the primary query and the union is merged, so a match found by any
   * phrasing surfaces. Results are re-ranked by recency-weighted score (see recencyFactor).
   */
  async search(
    query: string,
    scope: Scope = "project",
    limit = 5,
    extraQueries: string[] = [],
    key?: string,
  ): Promise<MemoryHit[]> {
    const queries = [query, ...extraQueries];
    // Union the normal scope run_ids with any read-only extra knowledge scopes (e.g. a shared "k8s"
    // knowledge base). These are SEARCH-only: add/pin/list/delete never touch them.
    const runIds = Array.from(new Set([...this.searchRunIds(scope, key), ...(this.cfg.extraReadScopes ?? [])]));
    // Widen the per-request cap so a hit ranked just outside the final top-k in one (scope, query)
    // request can still win after the union is re-ranked: each of the N queries x M scopes fetches
    // more than `limit`, then we merge, recency-re-rank, and trim to `limit` once.
    const perRequest = limit + SEARCH_OVERFETCH;
    const batches = await Promise.all(
      runIds.flatMap((runId) => queries.map((q) => this.searchScope(q, runId, perRequest))),
    );

    // Dedupe across queries/scopes, keeping the highest raw score seen for each memory.
    const best = new Map<string, MemoryHit>();
    for (const hit of batches.flat()) {
      const dedupKey = hit.id ?? hit.memory;
      const prev = best.get(dedupKey);
      if (!prev || (hit.score ?? 0) > (prev.score ?? 0)) best.set(dedupKey, hit);
    }

    return [...best.values()]
      .sort((a, b) => {
        const adj = (h: MemoryHit) => (h.score ?? 0) * recencyFactor(h.updatedAt ?? h.createdAt);
        return adj(b) - adj(a);
      })
      .slice(0, limit);
  }

  /**
   * List memories for a scope. By default returns the server's page order (for inspection).
   * With `recent: true` it returns MOST RECENT FIRST — for time-based retrieval like "the
   * last N entries". For finding what best matches a topic, use `search`, not this.
   */
  async list(scope: Scope = "project", limit?: number, key?: string, recent = false): Promise<MemoryHit[]> {
    const params = new URLSearchParams({ user_id: this.cfg.defaultUserId });
    const run = this.runId(scope, key);
    if (run) params.set("run_id", run);
    // For recency mode fetch a generous page then sort+trim locally (server order is not chronological).
    if (limit !== undefined) params.set("top_k", String(recent ? Math.max(limit * 4, 50) : limit));
    const data = await this.request(`/memories?${params.toString()}`, { method: "GET" });
    const hits = Mem0Client.toHits(data);
    if (!recent) return hits;
    hits.sort((a, b) => Mem0Client.tsOf(b) - Mem0Client.tsOf(a));
    return limit !== undefined ? hits.slice(0, limit) : hits;
  }

  /** Epoch ms of a hit's most recent timestamp (0 when absent). */
  private static tsOf(h: MemoryHit): number {
    const t = Date.parse(h.updatedAt ?? h.createdAt ?? "");
    return Number.isNaN(t) ? 0 : t;
  }

  // ── Pinned facts (AGENTS.md-like: always loaded, verbatim, kept out of normal recall) ──────
  //
  // Pins live in dedicated namespaces so they never pollute semantic search/list and are never
  // decayed or reconciled: `pins:global` (cross-scope) and `pins:<key>` (local to a room/project).
  // They are stored verbatim (infer:false) so the exact text is preserved.

  /** The run_id holding pins for a scope. */
  private pinRun(scope: "global" | "local", key?: string): string {
    if (scope === "global") return "pins:global";
    const k = key ?? this.cfg.scopeKey ?? this.cfg.project;
    return `pins:${k}`;
  }

  /**
   * Add a pinned fact verbatim (never inferred/reconciled). Deduped: since pins are stored exactly
   * as written and loaded on every recall, an identical pin (same trimmed text) already in the run
   * is returned as-is instead of creating a second copy. Returns the stored (or existing) hits.
   */
  async addPin(text: string, scope: "global" | "local", key?: string): Promise<MemoryHit[]> {
    const runId = this.pinRun(scope, key);
    const wanted = text.trim();
    const params = new URLSearchParams({ user_id: this.cfg.defaultUserId, run_id: runId, top_k: "200" });
    const existing = Mem0Client.toHits(await this.request(`/memories?${params.toString()}`, { method: "GET" }));
    const dup = existing.find((h) => h.memory.trim() === wanted);
    if (dup) return [dup];

    const body = {
      messages: [{ role: "user", content: text }],
      user_id: this.cfg.defaultUserId,
      infer: false, // pins are kept exactly as written
      run_id: runId,
      metadata: { pinned: true },
    };
    // infer:false is a single verbatim write (no LLM), so the standard request timeout is enough.
    const data = await this.request("/memories", { method: "POST", body: JSON.stringify(body) });
    return Mem0Client.toHits(data);
  }

  /**
   * All pinned facts that apply right now: the global pins plus the local pins for `key`
   * (or the configured scopeKey / project). Returned in full — this is the always-load set.
   */
  async listPins(key?: string): Promise<{ global: MemoryHit[]; local: MemoryHit[] }> {
    const fetchRun = async (runId: string): Promise<MemoryHit[]> => {
      const params = new URLSearchParams({ user_id: this.cfg.defaultUserId, run_id: runId, top_k: "200" });
      const data = await this.request(`/memories?${params.toString()}`, { method: "GET" });
      return Mem0Client.toHits(data);
    };
    const [global, local] = await Promise.all([fetchRun("pins:global"), fetchRun(this.pinRun("local", key))]);
    return { global, local };
  }

  /** Rewrite the text of one memory by id. */
  async update(memoryId: string, text: string): Promise<void> {
    Mem0Client.assertMemoryId(memoryId);
    await this.request(`/memories/${memoryId}`, { method: "PUT", body: JSON.stringify({ text }) });
  }

  /** Delete one memory by id. */
  async remove(memoryId: string): Promise<void> {
    Mem0Client.assertMemoryId(memoryId);
    await this.request(`/memories/${memoryId}`, { method: "DELETE" });
  }

  /**
   * Wipe the ENTIRE store (irreversible). The server demands a reset token via X-Reset-Token;
   * only the human user knows it, so callers must obtain it from the user, never generate one.
   */
  async reset(resetToken: string): Promise<void> {
    if (!resetToken.trim()) throw new Error("reset requires the user's reset token");
    await this.request("/reset", { method: "POST", headers: { "X-Reset-Token": resetToken } });
  }
}
