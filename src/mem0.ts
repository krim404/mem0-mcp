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
import { classifyExpiry } from "./expiry";

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
  lockScope?: boolean;   // when scopeKey is set, force it for every call (ignore a per-call key); from MEM0_LOCK_SCOPE
  extraReadScopes?: string[]; // extra read-only namespaces merged into recall (never written); from MEM0_EXTRA_READ_SCOPES
}

export interface MemoryHit {
  id?: string;
  memory: string;
  score?: number;
  createdAt?: string; // ISO timestamp from the server, when present
  updatedAt?: string;
  event?: string;     // add-time reconciliation outcome: ADD | UPDATE | DELETE | NONE (infer mode)
  metadata?: Record<string, unknown>; // stored tags (e.g. { source: "summary" }); used for filtering
  expirationDate?: string; // YYYY-MM-DD after which the memory is expired (drives the expiry tiers)
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
   * The effective explicit namespace key for a call. With `lockScope` set (a locked-down
   * deployment, e.g. the public bot), the configured `scopeKey` always wins and a per-call
   * `key` is ignored, so a caller can never escape its own namespace. Otherwise a per-call
   * `key` overrides `scopeKey`, allowing a deliberate cross-namespace operation.
   */
  private resolvedKey(key?: string): string | undefined {
    if (this.cfg.lockScope && this.cfg.scopeKey) return this.cfg.scopeKey;
    return key ?? this.cfg.scopeKey;
  }

  /**
   * The single run_id a WRITE targets. The resolved key (see `resolvedKey`) pins storage to that
   * namespace; this is how a Matrix room id scopes memory. Otherwise: `all` -> undefined,
   * `global` -> the reserved global scope, `project` -> the auto-detected project. Writes never
   * fan out over extra read scopes.
   */
  private runId(scope: Scope, key?: string): string | undefined {
    const k = this.resolvedKey(key);
    if (k) return k;
    if (scope === "all") return undefined;
    if (scope === "global") return GLOBAL_SCOPE;
    return this.cfg.project;
  }

  /**
   * The run_ids a READ fans out over: the scope's base namespace(s) plus the configured
   * read-only `extraReadScopes` (knowledge namespaces the caller may read but never write).
   * `mergeGlobal` reproduces search's project+global merge; list/recent keep the single base.
   */
  private readRunIds(scope: Scope, key: string | undefined, mergeGlobal: boolean): (string | undefined)[] {
    const k = this.resolvedKey(key);
    let base: (string | undefined)[];
    if (k) base = [k];
    else if (scope === "all") base = [undefined];
    else if (scope === "global") base = [GLOBAL_SCOPE];
    else base = mergeGlobal ? [this.cfg.project, GLOBAL_SCOPE] : [this.cfg.project];
    return [...new Set([...base, ...(this.cfg.extraReadScopes ?? [])])];
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
      // A 403 from the public reverse proxy means the client is outside the VPN/LAN: mem0 is
      // internal-only and pi5/nginx-prim refuses external access. Surface that as a hint.
      const hint = res.status === 403 ? " (403: likely outside the VPN/LAN — mem0 is internal-only)" : "";
      throw new Error(`mem0 ${init.method ?? "GET"} ${path} -> ${res.status} ${res.statusText}${hint} ${body.slice(0, 200)}`);
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
      metadata: r.metadata ?? undefined,
      expirationDate: r.expiration_date ?? undefined,
    }));
  }

  /**
   * Store a message. By default mem0 extracts durable facts and reconciles them against existing
   * memories (ADD / UPDATE / DELETE / NONE), which dedupes and invalidates contradicted facts on
   * its own. Set infer=false (MEM0_INFER=0) to store the text verbatim without that pipeline.
   * Returns one hit per reconciliation event so the caller can see what changed.
   */
  async add(text: string, scope: Scope = "project", key?: string, expirationDate?: string): Promise<MemoryHit[]> {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: text }],
      user_id: this.cfg.defaultUserId,
      infer: this.cfg.infer ?? true,
    };
    const run = this.runId(scope === "all" ? "project" : scope, key); // never add without a scope
    if (run) body.run_id = run;
    if (expirationDate) body.expiration_date = expirationDate;
    const data = await this.request("/memories", { method: "POST", body: JSON.stringify(body) }, ADD_TIMEOUT_MS);
    return Mem0Client.toHits(data);
  }

  private async searchScope(query: string, runId: string | undefined, limit: number): Promise<MemoryHit[]> {
    // show_expired: fetch expired rows too, so we can apply our own graded expiry tiers (the server
    // would otherwise hide them outright, making "recently expired, shown at the bottom" impossible).
    const body: Record<string, unknown> = { query, user_id: this.cfg.defaultUserId, limit, show_expired: true };
    if (runId) body.run_id = runId;
    const data = await this.request("/search", { method: "POST", body: JSON.stringify(body) });
    return Mem0Client.toHits(data);
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
    source?: string,
  ): Promise<MemoryHit[]> {
    const queries = [query, ...extraQueries];
    const runIds = this.readRunIds(scope, key, true);
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

    const merged = Mem0Client.bySource([...best.values()], source)
      .filter((h) => !Mem0Client.isPinned(h)); // pins surface only via listPins, never in recall
    const adj = (h: MemoryHit) => (h.score ?? 0) * recencyFactor(h.updatedAt ?? h.createdAt);
    return this.tierAndTrim(merged, limit, (a, b) => adj(b) - adj(a));
  }

  /** Keep only hits tagged with the given metadata `source` (no filter when source is unset). */
  private static bySource(hits: MemoryHit[], source?: string): MemoryHit[] {
    if (!source) return hits;
    return hits.filter((h) => String(h.metadata?.source ?? "") === source);
  }

  /**
   * Apply the expiry lifecycle to a result set: drop `hidden`, GC `dead` (best-effort, off the hot
   * path), keep `active` above `recent` (freshly-expired sink to the bottom). `rank` sorts within
   * each group; omit it to preserve the incoming order (list inspection). Trims to `limit`.
   */
  private tierAndTrim(hits: MemoryHit[], limit?: number, rank?: (a: MemoryHit, b: MemoryHit) => number): MemoryHit[] {
    const active: MemoryHit[] = [];
    const recent: MemoryHit[] = [];
    const dead: string[] = [];
    for (const h of hits) {
      const tier = classifyExpiry(h.expirationDate);
      if (tier === "active") active.push(h);
      else if (tier === "recent") recent.push(h);
      else if (tier === "dead" && h.id) dead.push(h.id);
      // `hidden`: kept in the store but omitted from recall.
    }
    if (dead.length) void this.gcDead(dead);
    if (rank) {
      active.sort(rank);
      recent.sort(rank);
    }
    const out = [...active, ...recent];
    return limit !== undefined ? out.slice(0, limit) : out;
  }

  /** Garbage-collect memories long past expiry (delete). Best-effort: never blocks a read or throws. */
  private async gcDead(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.remove(id);
      } catch {
        /* best-effort GC: a failed delete is retried on the next read */
      }
    }
  }

  /**
   * List memories for a scope. By default returns the server's page order (for inspection).
   * With `recent: true` it returns MOST RECENT FIRST — for time-based retrieval like "the
   * last N entries". For finding what best matches a topic, use `search`, not this.
   */
  /** Fetch one namespace's memories in the server's page order. */
  private async listOne(runId: string | undefined, topK?: number): Promise<MemoryHit[]> {
    const params = new URLSearchParams({ user_id: this.cfg.defaultUserId, show_expired: "true" });
    if (runId) params.set("run_id", runId);
    if (topK !== undefined) params.set("top_k", String(topK));
    const data = await this.request(`/memories?${params.toString()}`, { method: "GET" });
    return Mem0Client.toHits(data);
  }

  async list(scope: Scope = "project", limit?: number, key?: string, recent = false, source?: string): Promise<MemoryHit[]> {
    const runIds = this.readRunIds(scope, key, false);
    // Fetch a generous page per namespace, then filter/sort/trim locally: server order is not
    // chronological, and the source/pin/expiry filters must not be starved by a small `limit`.
    const topK = limit !== undefined ? Math.max(limit * 4, 50) : undefined;
    const batches = await Promise.all(runIds.map((r) => this.listOne(r, topK)));

    // Merge the namespaces, deduping by id so a memory shared across overlapping scopes appears once.
    const seen = new Map<string, MemoryHit>();
    for (const h of batches.flat()) {
      const dedupKey = h.id ?? h.memory;
      if (!seen.has(dedupKey)) seen.set(dedupKey, h);
    }
    const merged = Mem0Client.bySource([...seen.values()], source).filter((h) => !Mem0Client.isPinned(h));
    // Recent mode ranks by recency; plain inspection keeps the server page order.
    const rank = recent ? (a: MemoryHit, b: MemoryHit) => Mem0Client.tsOf(b) - Mem0Client.tsOf(a) : undefined;
    return this.tierAndTrim(merged, limit, rank);
  }

  /** Epoch ms of a hit's most recent timestamp (0 when absent). */
  private static tsOf(h: MemoryHit): number {
    const t = Date.parse(h.updatedAt ?? h.createdAt ?? "");
    return Number.isNaN(t) ? 0 : t;
  }

  // ── Pinned facts (AGENTS.md-like: always loaded, kept out of normal recall) ──────
  //
  // A pin is an ordinary memory in its NORMAL namespace (the room/project scope, or global) tagged
  // `metadata.pinned=true` and stored verbatim (infer:false). Living in the normal namespace lets an
  // EXISTING memory be pinned in place by flipping the flag (no move/copy); the pinned tag keeps pins
  // out of semantic search/list (they surface only via listPins) and marks them as the always-load set.

  /** True for a pinned memory. */
  private static isPinned(h: MemoryHit): boolean {
    return h.metadata?.pinned === true;
  }

  /** The base run_id a pin lives in: the global scope, or the local room/project namespace. */
  private pinRun(scope: "global" | "local", key?: string): string {
    return scope === "global" ? GLOBAL_SCOPE : (this.resolvedKey(key) ?? this.cfg.project);
  }

  /**
   * Add a NEW pinned fact verbatim in its namespace (never inferred/reconciled), tagged pinned.
   * Deduped against an existing pin with the same trimmed text in that namespace.
   */
  async addPin(text: string, scope: "global" | "local", key?: string): Promise<MemoryHit[]> {
    const runId = this.pinRun(scope, key);
    const wanted = text.trim();
    const existing = (await this.listOne(runId, 200)).filter(Mem0Client.isPinned);
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

  /** Pin an EXISTING memory in place by id (flip metadata.pinned=true), keeping its text/namespace. */
  async pinExisting(memoryId: string): Promise<void> {
    await this.update(memoryId, undefined, { pinned: true });
  }

  /** Demote a pinned memory back to an ordinary one (metadata.pinned=false); the knowledge stays. */
  async unpinExisting(memoryId: string): Promise<void> {
    await this.update(memoryId, undefined, { pinned: false });
  }

  /**
   * All pinned facts that apply right now: the global pins plus the pins for `key` (or the configured
   * scopeKey / project) and any read-only knowledge scopes. Read from the NORMAL namespaces and
   * filtered to pinned. This is the always-load set.
   */
  async listPins(key?: string): Promise<{ global: MemoryHit[]; local: MemoryHit[] }> {
    const localRuns = [...new Set([this.pinRun("local", key), ...(this.cfg.extraReadScopes ?? [])])];
    const [globalHits, ...localBatches] = await Promise.all([
      this.listOne(GLOBAL_SCOPE, 200),
      ...localRuns.map((r) => this.listOne(r, 200)),
    ]);
    const global = globalHits.filter(Mem0Client.isPinned);
    const seen = new Map<string, MemoryHit>();
    for (const h of localBatches.flat().filter(Mem0Client.isPinned)) {
      const dk = h.id ?? h.memory;
      if (!seen.has(dk)) seen.set(dk, h);
    }
    return { global, local: [...seen.values()] };
  }

  /** Update a memory by id: rewrite text and/or replace metadata (only provided fields are sent). */
  async update(memoryId: string, text?: string, metadata?: Record<string, unknown>): Promise<void> {
    Mem0Client.assertMemoryId(memoryId);
    const body: Record<string, unknown> = {};
    if (text !== undefined) body.text = text;
    if (metadata !== undefined) body.metadata = metadata;
    await this.request(`/memories/${memoryId}`, { method: "PUT", body: JSON.stringify(body) });
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
