import { Router } from "express";
import { deleteSetting, getSettingString, setSetting } from "../db.js";
import {
  checkForUpdate,
  currentFetch,
  updateStatus,
  UPDATE_TRIGGER_TOKEN_SETTING,
  UPDATE_TRIGGER_URL_SETTING,
} from "../services/updateService.js";

/**
 * OTA update surface (#247): tell (GET /), check (POST /check), apply
 * (POST /apply), and the write-only trigger config (PUT/DELETE /trigger) —
 * the routes/notify.ts shape. Mounted BELOW the password gate: the running
 * version is authed data (ADR-50, /api/health stays exactly {ok, time}),
 * and an open apply endpoint would let anyone on the LAN restart the app.
 *
 * Draw never touches docker.sock and never executes updates itself —
 * applying is ONE outbound POST to the user-configured trigger URL
 * (Watchtower's http-api-update is the blessed target); a human taps the
 * button, the container platform does the swap.
 */
export const updateRouter = Router();

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

// A cache read — never triggers an outbound call (the scheduler and the
// forced check are the only writers).
updateRouter.get("/", (_req, res) => {
  res.json(updateStatus());
});

// Force a re-check now. checkForUpdate() itself honors update_check_enabled
// ("off means off" — the user's own button included) and never rejects on
// network failure, so this always answers 200 with the (possibly degraded)
// status.
updateRouter.post("/check", async (_req, res) => {
  res.json(await checkForUpdate());
});

updateRouter.put("/trigger", (req, res) => {
  const body = (req.body ?? {}) as { url?: unknown; token?: unknown };
  const error = urlError(body.url);
  if (error) return res.status(400).json({ error });
  if (body.token !== undefined && typeof body.token !== "string") {
    return res.status(400).json({ error: "token must be a string when given" });
  }
  setSetting(UPDATE_TRIGGER_URL_SETTING, (body.url as string).trim());
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token) {
    setSetting(UPDATE_TRIGGER_TOKEN_SETTING, token);
  } else {
    // Replacing the trigger without a token must not keep a stale bearer.
    deleteSetting(UPDATE_TRIGGER_TOKEN_SETTING);
  }
  res.json({ configured: true });
});

updateRouter.delete("/trigger", (_req, res) => {
  deleteSetting(UPDATE_TRIGGER_URL_SETTING);
  deleteSetting(UPDATE_TRIGGER_TOKEN_SETTING);
  res.json({ configured: false });
});

// Apply = ONE fire-and-forget POST to the trigger, 202 to the client — the
// client then polls GET /api/update for the new version. Fire-and-forget
// because Watchtower's http-api-update may hold the connection until the
// swap (which kills this very process) completes; the bearer rides ONLY
// here, never the check request.
updateRouter.post("/apply", (_req, res) => {
  const url = getSettingString(UPDATE_TRIGGER_URL_SETTING);
  if (!url) {
    return res.status(409).json({
      error:
        "no update trigger configured — see the deployment guide (docs, Deployment View §7.5) for the Watchtower setup",
    });
  }
  const token = getSettingString(UPDATE_TRIGGER_TOKEN_SETTING);
  const controller = new AbortController();
  // Longer cap than the 3s check: the trigger may pull an image before
  // answering. Nothing awaits this — the 202 below returns immediately.
  const timer = setTimeout(() => controller.abort(), 60_000);
  void Promise.resolve(
    currentFetch()(url, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    }),
  )
    .catch((err: unknown) => {
      console.warn(
        `[update] trigger POST failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => clearTimeout(timer));
  res.status(202).json({ ok: true });
});
