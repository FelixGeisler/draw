import { Router } from "express";
import { db, setSetting } from "../db.js";
import { currentFetch, NOTIFY_URL_SETTING, notifyConfigured } from "../services/notifyService.js";

/**
 * Outbound-notification config (#235, ADR-67). The URL is PRIVATE — an ntfy
 * URL embeds the topic, and knowing the topic means posting to the user's
 * phone — so like the Claude API key it never rides GET /api/settings
 * (excluded there) and is managed here write-only: the GET exposes only a
 * presence flag.
 */
export const notifyRouter = Router();

function urlError(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return "url is required — a non-empty http(s) URL";
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "url must be a valid absolute URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "url must use http or https";
  }
  return null;
}

notifyRouter.get("/", (_req, res) => {
  res.json({ configured: notifyConfigured() });
});

notifyRouter.put("/url", (req, res) => {
  const url = (req.body ?? {}).url;
  const error = urlError(url);
  if (error) return res.status(400).json({ error });
  setSetting(NOTIFY_URL_SETTING, (url as string).trim());
  res.json({ configured: true });
});

notifyRouter.delete("/url", (_req, res) => {
  db.prepare("DELETE FROM settings WHERE key = ?").run(NOTIFY_URL_SETTING);
  res.json({ configured: false });
});

// The one AWAITED send: a diagnostic the user clicks, so unlike the game
// events it reports honestly whether the endpoint answered. Same 3s cap.
notifyRouter.post("/test", async (_req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(NOTIFY_URL_SETTING) as
    | { value: string }
    | undefined;
  if (!row?.value) return res.status(400).json({ error: "no notify_url configured" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = (await currentFetch()(row.value, {
      method: "POST",
      headers: { Title: "Draw test notification" },
      body: "🃏 Draw can reach this endpoint.",
      signal: controller.signal,
    })) as { ok?: boolean; status?: number };
    res.json({ ok: Boolean(response?.ok), status: response?.status ?? null });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
});

