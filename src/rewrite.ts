/**
 * HyDE-lite query rewrite for memory search.
 *
 * Stored memories are declarative facts ("images are pushed to registry X"); recall queries are
 * often questions ("where do we push images?"). Embedding a question and a statement of the same
 * fact land in slightly different regions of vector space (query/document asymmetry). HyDE closes
 * the gap on the QUERY side: an LLM rewrites the question into one short hypothetical answer, which
 * we search ALONGSIDE the raw query (answer-to-answer match), never instead of it.
 *
 * The rewriter calls any OpenAI-compatible chat endpoint, configured entirely via env. It is
 * disabled unless a base URL and model are provided, so the bridge works out of the box without an
 * LLM. It is also best-effort: any failure (timeout, unreachable, empty) returns undefined and the
 * caller falls back to the raw query. Search must never block on the rewriter.
 */

const REWRITE_TIMEOUT_MS = 3_000;
const SYSTEM_PROMPT =
  "Rewrite the user's question as ONE short declarative statement that would answer it. " +
  "Keep every named entity, path, hostname, version and identifier exactly. " +
  "Do not answer from your own knowledge, do not add facts, do not explain. " +
  "Output only the single statement, nothing else.";

export interface RewriteConfig {
  enabled: boolean;
  baseUrl?: string; // OpenAI-compatible base, e.g. https://api.openai.com/v1
  model?: string;
  apiKey?: string; // optional Bearer
  insecureTls?: boolean;
}

/**
 * Build the rewrite config from env. Rewrite is enabled only when it is not switched off AND both a
 * base URL and a model are configured, so a fresh install (no LLM env) simply skips the rewrite.
 *   MEM0_REWRITE_BASE_URL  OpenAI-compatible chat base URL
 *   MEM0_REWRITE_MODEL     chat model id
 *   MEM0_REWRITE_API_KEY   optional Bearer token
 *   MEM0_QUERY_REWRITE=0   explicit kill switch
 *   MEM0_INSECURE_TLS=1    skip TLS verify (self-signed endpoints)
 */
export function rewriteConfigFromEnv(): RewriteConfig {
  const baseUrl = process.env.MEM0_REWRITE_BASE_URL || undefined;
  const model = process.env.MEM0_REWRITE_MODEL || undefined;
  return {
    enabled: process.env.MEM0_QUERY_REWRITE !== "0" && Boolean(baseUrl) && Boolean(model),
    baseUrl,
    model,
    apiKey: process.env.MEM0_REWRITE_API_KEY,
    insecureTls: process.env.MEM0_INSECURE_TLS === "1",
  };
}

/**
 * Return a declarative rewrite of `query`, or undefined to signal "use the raw query". Never
 * throws: a failed or unconfigured rewrite is a soft downgrade to plain semantic search.
 */
export async function rewriteQuery(query: string, cfg: RewriteConfig): Promise<string | undefined> {
  if (!cfg.enabled || !cfg.baseUrl || !cfg.model || !query.trim()) return undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const opts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    }),
    signal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
  };
  if (cfg.insecureTls) opts.tls = { rejectUnauthorized: false };

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, opts);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const out = data.choices?.[0]?.message?.content?.trim();
    // Ignore an empty or echoed-back rewrite: it adds no new phrasing, only cost.
    if (!out || out === query.trim()) return undefined;
    return out;
  } catch {
    return undefined; // timeout, network, TLS, parse -> fall back to raw query
  }
}
