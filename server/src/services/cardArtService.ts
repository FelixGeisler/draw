import { db } from "../db.js";
import { AiError, generateCardArt, isConfigured } from "./aiService.js";
import { sanitizeSvg } from "./svgSanitizer.js";

/**
 * Card art cache (#27, ADR-22): at most one generation per task. The check
 * order is a contract the route tests pin down:
 *   1. unknown task        → 404 (even in degraded mode)
 *   2. cached row          → serve, no API call ever again for this task
 *   3. no API key          → 503 ai_not_configured (client degrades silently)
 *   4. generate → sanitize → store → serve
 * Only SANITIZED markup is ever written to card_art; a generation whose
 * output does not survive sanitization is not cached, so the next view
 * retries instead of pinning a broken background forever.
 *
 * #113 adds the second entry point, regenerateCardArt — the ONLY path that
 * replaces an existing row — and tightens the concurrency rule: at most one
 * Claude generation in flight per task across BOTH entry points. Concurrent
 * requests coalesce onto the same promise instead of firing parallel calls.
 */

// Keyed by task id; the entry removes itself when the generation settles, so
// a failure never wedges a task (the next request simply starts a fresh one).
const inFlight = new Map<number, Promise<string>>();

// Both entry points check this twice: once up front (the pinned 404-first
// contract) and once more AFTER the generation await — the task can be
// deleted in a second tab while Claude paints, and writing the row then would
// trip the card_art→tasks FK and surface as a 500 instead of a 404.
// better-sqlite3 is synchronous, so nothing can delete the task between the
// re-check and the write that follows it.
function ensureTaskExists(taskId: number): void {
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
  if (!task) throw new AiError(404, "task not found");
}

function generateSanitized(taskId: number): Promise<string> {
  const existing = inFlight.get(taskId);
  if (existing) return existing;
  const p = (async () => {
    const raw = await generateCardArt(taskId);
    const svg = sanitizeSvg(raw);
    if (!svg) {
      throw new AiError(502, "Claude returned unusable SVG artwork — viewing the card again retries");
    }
    return svg;
  })().finally(() => inFlight.delete(taskId));
  inFlight.set(taskId, p);
  return p;
}

export async function getOrCreateCardArt(taskId: number): Promise<{ svg: string }> {
  ensureTaskExists(taskId);

  const cached = db.prepare("SELECT svg FROM card_art WHERE task_id = ?").get(taskId) as
    | { svg: string }
    | undefined;
  if (cached) return { svg: cached.svg };

  if (!isConfigured()) throw new AiError(503, "ai_not_configured");

  const svg = await generateSanitized(taskId);
  ensureTaskExists(taskId); // deleted mid-generation → 404, not an FK 500

  // Concurrent first views coalesce above; a view racing a REGENERATE can
  // still land here after the regenerate already wrote. First writer wins so
  // this path keeps its at-most-once semantics — it never replaces a row.
  db.prepare(
    "INSERT INTO card_art (task_id, svg, created_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING",
  ).run(taskId, svg, new Date().toISOString());
  const row = db.prepare("SELECT svg FROM card_art WHERE task_id = ?").get(taskId) as {
    svg: string;
  };
  return { svg: row.svg };
}

/**
 * Cache-only batch read (#114/#115): the trophy pile renders every completed
 * card's art in ONE round trip, and rendering the pile must NEVER trigger a
 * Claude generation — that is a Draw-page concern (getOrCreateCardArt above).
 * Plain SELECT, no isConfigured() check, no in-flight map: with or without an
 * API key this function only ever reads what earlier generations stored.
 * Unknown ids simply produce no row (the client falls back to the gradient);
 * duplicates are deduped so the IN list stays minimal.
 */
export function getCachedCardArt(taskIds: number[]): { taskId: number; svg: string }[] {
  const unique = [...new Set(taskIds)];
  if (unique.length === 0) return [];
  const placeholders = unique.map(() => "?").join(",");
  return db
    .prepare(`SELECT task_id AS taskId, svg FROM card_art WHERE task_id IN (${placeholders})`)
    .all(...unique) as { taskId: number; svg: string }[];
}

/**
 * Regenerate (#113): generate-then-replace. The existing row is touched only
 * AFTER a new generation fully survived sanitization — a failed generation or
 * sanitization throws before the write, so the old art always survives
 * (never delete-first). Same 404/503 contract as getOrCreateCardArt, minus
 * the cache short-circuit: replacing the cache is the whole point.
 */
export async function regenerateCardArt(taskId: number): Promise<{ svg: string }> {
  ensureTaskExists(taskId);

  if (!isConfigured()) throw new AiError(503, "ai_not_configured");

  const svg = await generateSanitized(taskId);
  ensureTaskExists(taskId); // deleted mid-generation → 404, not an FK 500

  db.prepare(
    "INSERT INTO card_art (task_id, svg, created_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(task_id) DO UPDATE SET svg = excluded.svg, created_at = excluded.created_at",
  ).run(taskId, svg, new Date().toISOString());
  return { svg };
}
