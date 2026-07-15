/**
 * Expiration tiers for memories.
 *
 * A memory may carry an `expiration_date` (YYYY-MM-DD). The mem0 server hides a memory once that
 * date has passed (unless show_expired=true) but never deletes it. We ask the server for expired
 * rows and apply our own graded lifecycle so temporary facts fade instead of vanishing at once:
 *   active  — not yet expired: normal treatment.
 *   recent  — 1..RECENT_MAX_DAYS past expiry: still shown, but sunk to the bottom of recall.
 *   hidden  — RECENT_MAX_DAYS..HIDDEN_MAX_DAYS past: filtered out of recall (kept in the store).
 *   dead    — beyond HIDDEN_MAX_DAYS past: garbage-collected (deleted) on the next read.
 */

export type ExpiryTier = "active" | "recent" | "hidden" | "dead";

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// Grace after expiry before a memory drops out of recall, and before it is deleted. Overridable so a
// deployment can tune how long temporary facts linger.
export const RECENT_MAX_DAYS = num("MEM0_EXPIRY_RECENT_DAYS", 30); // ~1 month: still shown (at bottom)
export const HIDDEN_MAX_DAYS = num("MEM0_EXPIRY_DELETE_DAYS", 180); // ~6 months: then GC-delete

const MS_PER_DAY = 86_400_000;

/** Parse a YYYY-MM-DD string to epoch-ms at UTC midnight, or null if absent/invalid. */
function parseDate(date?: string): number | null {
  if (!date) return null;
  const ts = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ts) ? null : ts;
}

/**
 * Whole days a memory is PAST its expiration date (negative/0 = not yet expired). null when the
 * memory has no expiration date (it never expires).
 */
export function daysPastExpiry(expirationDate?: string, now: Date = new Date()): number | null {
  const exp = parseDate(expirationDate);
  if (exp === null) return null;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((today - exp) / MS_PER_DAY);
}

/** Which lifecycle tier a memory is in, given its expiration date and the current time. */
export function classifyExpiry(expirationDate?: string, now: Date = new Date()): ExpiryTier {
  const past = daysPastExpiry(expirationDate, now);
  if (past === null || past <= 0) return "active"; // no date, or not yet strictly past (server hides at < today)
  if (past <= RECENT_MAX_DAYS) return "recent";
  if (past <= HIDDEN_MAX_DAYS) return "hidden";
  return "dead";
}

/** The YYYY-MM-DD date `expiresInDays` from now (day granularity), for a relative TTL on write. */
export function computeExpirationDate(expiresInDays: number, now: Date = new Date()): string {
  const t = now.getTime() + Math.round(expiresInDays) * MS_PER_DAY;
  return new Date(t).toISOString().slice(0, 10);
}
