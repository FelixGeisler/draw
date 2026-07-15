import { db } from "../db.js";
import { AiError, generateCardArt, isConfigured } from "./aiService.js";
import { sanitizeSvg } from "./svgSanitizer.js";

/**
 * Card art cache (#27, ADR-21): at most one generation per task. The check
 * order is a contract the route tests pin down:
 *   1. unknown task        → 404 (even in degraded mode)
 *   2. cached row          → serve, no API call ever again for this task
 *   3. no API key          → 503 ai_not_configured (client degrades silently)
 *   4. generate → sanitize → store → serve
 * Only SANITIZED markup is ever written to card_art; a generation whose
 * output does not survive sanitization is not cached, so the next view
 * retries instead of pinning a broken background forever.
 */
export async function getOrCreateCardArt(taskId: number): Promise<{ svg: string }> {
  const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
  if (!task) throw new AiError(404, "task not found");

  const cached = db.prepare("SELECT svg FROM card_art WHERE task_id = ?").get(taskId) as
    | { svg: string }
    | undefined;
  if (cached) return { svg: cached.svg };

  if (!isConfigured()) throw new AiError(503, "ai_not_configured");

  const raw = await generateCardArt(taskId);
  const svg = sanitizeSvg(raw);
  if (!svg) {
    throw new AiError(502, "Claude returned unusable SVG artwork — viewing the card again retries");
  }

  // Concurrent first views can both pass the cache miss while awaiting the
  // API; first writer wins so a task's artwork stays stable (at most once).
  db.prepare(
    "INSERT INTO card_art (task_id, svg, created_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING",
  ).run(taskId, svg, new Date().toISOString());
  const row = db.prepare("SELECT svg FROM card_art WHERE task_id = ?").get(taskId) as {
    svg: string;
  };
  return { svg: row.svg };
}
