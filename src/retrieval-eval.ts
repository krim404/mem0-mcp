#!/usr/bin/env bun
/**
 * Retrieval quality eval for the memory bridge. Answers one question: do declarative facts get
 * found by question-style queries, and does the HyDE-lite rewrite help?
 *
 * Seeds a fixed set of realistic facts into a dedicated "retrieval-eval" scope, fires paraphrased
 * question queries (German + English) that share few keywords with the stored fact, and measures
 * hit@1 / hit@5 for two arms: raw query only, and raw + HyDE rewrite. A hit means the fact's canary
 * substring (a stable identifier the paraphrase does NOT contain) appears in a top-k result.
 *
 * Self-cleaning: every entry created is deleted in a finally block, even on failure. The seed facts
 * below are a generic fictional web app, so the probe is safe to run against any mem0 server.
 *
 * Run: bun src/retrieval-eval.ts   (same env as the bridge/selftest).
 */
import { Mem0Client, type Scope } from "./mem0";
import { rewriteConfigFromEnv, rewriteQuery } from "./rewrite";

const SCOPE: Scope = "project";
const TOP_K = 5;

const c = new Mem0Client({
  baseUrl: process.env.MEM0_API_URL ?? "http://localhost:8000",
  apiKey: process.env.MEM0_API_KEY,
  defaultUserId: process.env.MEM0_DEFAULT_USER_ID ?? "default",
  project: "retrieval-eval",
  insecureTls: process.env.MEM0_INSECURE_TLS === "1",
  infer: process.env.MEM0_INFER !== "0",
});

// Force the rewrite on for the eval regardless of the ambient MEM0_QUERY_REWRITE setting.
const rewriteCfg = { ...rewriteConfigFromEnv(), enabled: true };

/** A fact to store, its stable canary identifier, and the paraphrased question that should find it. */
interface Case {
  text: string;
  canary: string; // survives extraction, absent from the query -> proves semantic (not keyword) match
  query: string;
}

// Generic fictional web-app facts (no real infrastructure), so the probe runs anywhere.
const CASES: Case[] = [
  { text: "Production container images are pushed to registry.example.com under the 'api' project.",
    canary: "registry.example.com", query: "wohin lade ich fertig gebaute container-images hoch?" },
  { text: "The API service listens on port 8080 inside the container.",
    canary: "port 8080", query: "which port does the backend service expose internally?" },
  { text: "Database schema migrations run via 'make migrate' before every deployment.",
    canary: "make migrate", query: "wie werden schema-änderungen beim deploy eingespielt?" },
  { text: "Production secrets are read from Vault at the path secret/app/prod.",
    canary: "secret/app/prod", query: "where do the production credentials come from at runtime?" },
  { text: "The web frontend is bundled with Vite and served as static files by nginx.",
    canary: "Vite", query: "welcher bundler baut das web-frontend?" },
  { text: "Continuous integration runs on GitHub Actions defined in .github/workflows/ci.yml.",
    canary: ".github/workflows/ci.yml", query: "where is the CI pipeline configured?" },
  { text: "Feature flags live in the config table and are cached for 60 seconds.",
    canary: "60 seconds", query: "wie lange werden feature flags zwischengespeichert?" },
  { text: "The staging environment runs Postgres 16.",
    canary: "Postgres 16", query: "which database version does staging use?" },
  { text: "Background jobs are processed through a Redis-backed queue.",
    canary: "Redis", query: "was treibt die asynchrone job-verarbeitung an?" },
  { text: "The public API is rate limited to 100 requests per minute per token.",
    canary: "100 requests per minute", query: "what is the per-token throttle on the API?" },
  { text: "Application logs ship to the ELK stack via Filebeat.",
    canary: "Filebeat", query: "wie gelangen die anwendungs-logs ins zentrale logging?" },
  { text: "TLS certificates are issued by Let's Encrypt through cert-manager.",
    canary: "Let's Encrypt", query: "who issues the https certificates for the app?" },
  // Distractors: never queried, present to make retrieval discriminate among similar facts.
  { text: "The project mascot is a blue otter named Pip.", canary: "Pip", query: "" },
  { text: "Commit messages are one short sentence, no prefixes.", canary: "no prefixes", query: "" },
  { text: "The changelog is maintained in CHANGELOG.md.", canary: "CHANGELOG.md", query: "" },
];

async function hitAt(query: string, canary: string, extra: string[]): Promise<{ rank: number | null }> {
  const hits = await c.search(query, SCOPE, TOP_K, extra);
  const idx = hits.findIndex((h) => h.memory.includes(canary));
  return { rank: idx < 0 ? null : idx + 1 };
}

function pct(n: number, d: number): string {
  return d === 0 ? "-" : `${((100 * n) / d).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const infer = process.env.MEM0_INFER !== "0";
  console.log(`seeding ${CASES.length} facts into scope 'retrieval-eval' (infer=${infer})...`);
  for (const cs of CASES) await c.add(cs.text, SCOPE);

  const queries = CASES.filter((cs) => cs.query);
  let rawTop1 = 0, rawTop5 = 0, rwTop1 = 0, rwTop5 = 0, rewritten = 0;
  const rows: string[] = [];

  for (const cs of queries) {
    const raw = await hitAt(cs.query, cs.canary, []);
    const rw = await rewriteQuery(cs.query, rewriteCfg);
    if (rw) rewritten++;
    const withRw = await hitAt(cs.query, cs.canary, rw ? [rw] : []);

    if (raw.rank === 1) rawTop1++;
    if (raw.rank !== null) rawTop5++;
    if (withRw.rank === 1) rwTop1++;
    if (withRw.rank !== null) rwTop5++;

    rows.push(
      [
        cs.query.slice(0, 46).padEnd(46),
        `raw#${raw.rank ?? "-"}`.padEnd(7),
        `rw#${withRw.rank ?? "-"}`.padEnd(7),
        rw ? "" : "(no rewrite)",
      ].join(" "),
    );
  }

  console.log("\nquery".padEnd(47) + " raw     rewrite");
  console.log(rows.join("\n"));
  const n = queries.length;
  console.log(
    `\nraw    : hit@1 ${pct(rawTop1, n)} (${rawTop1}/${n})  hit@5 ${pct(rawTop5, n)} (${rawTop5}/${n})`,
  );
  console.log(
    `rewrite: hit@1 ${pct(rwTop1, n)} (${rwTop1}/${n})  hit@5 ${pct(rwTop5, n)} (${rwTop5}/${n})  [${rewritten}/${n} queries rewritten]`,
  );
}

try {
  await main();
} finally {
  // Delete everything in the eval scope, regardless of which ids the add events returned.
  const leftover = await c.list(SCOPE, 200).catch(() => []);
  let removed = 0;
  for (const h of leftover) {
    if (!h.id) continue;
    try {
      await c.remove(h.id);
      removed++;
    } catch {
      /* best-effort cleanup */
    }
  }
  console.log(`\ncleanup-> removed ${removed} eval entries`);
}
