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
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
  if (!task) throw new AiError(404, "task not found");

  const cached = db.prepare("SELECT svg FROM card_art WHERE task_id = ?").get(taskId) as
    | { svg: string }
    | undefined;
  if (cached) return { svg: cached.svg };

  if (!isConfigured()) throw new AiError(503, "ai_not_configured");

  const svg = await generateSanitized(taskId);

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
 * Regenerate (#113): generate-then-replace. The existing row is touched only
 * AFTER a new generation fully survived sanitization — a failed generation or
 * sanitization throws before the write, so the old art always survives
 * (never delete-first). Same 404/503 contract as getOrCreateCardArt, minus
 * the cache short-circuit: replacing the cache is the whole point.
 */
export async function regenerateCardArt(taskId: number): Promise<{ svg: string }> {
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
  if (!task) throw new AiError(404, "task not found");

  if (!isConfigured()) throw new AiError(503, "ai_not_configured");

  const svg = await generateSanitized(taskId);

  db.prepare(
    "INSERT INTO card_art (task_id, svg, created_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(task_id) DO UPDATE SET svg = excluded.svg, created_at = excluded.created_at",
  ).run(taskId, svg, new Date().toISOString());
  return { svg };
}
