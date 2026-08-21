import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshApp } from "../helpers.js";
import { deleteSetting, setSetting } from "../../src/db.js";
import {
  DEFAULT_UPDATE_CHECK_URL,
  FORCED_CHECK_MIN_INTERVAL_MS,
  UPDATE_CHECK_ENABLED_SETTING,
  UPDATE_LAST_NOTIFIED_SETTING,
  UPDATE_TRIGGER_TOKEN_SETTING,
  UPDATE_TRIGGER_URL_SETTING,
  checkForUpdate,
  resetUpdateStateForTests,
  setFetchForTests,
  type UpdateStatus,
} from "../../src/services/updateService.js";
import { setFetchForTests as setNotifyFetchForTests } from "../../src/services/notifyService.js";

/**
 * OTA update: check, tell, apply (#247).
 *
 * Every outbound call runs against injected fetches — no socket is ever
 * opened. TWO separate slots on purpose: updateService owns its own
 * fetchImpl (checks + trigger POSTs), notifyService owns the ntfy door —
 * sharing one slot would make notify.test.ts and this file interfere.
 *
 * Load-bearing invariants, per the issue's acceptance criteria:
 * - /api/health stays exactly {ok, time}; version/update state need auth.
 * - Check disabled -> ZERO outbound calls (the #235 rule), including the
 *   forced POST /api/update/check (deliberate pin: the toggle gates EVERY
 *   call, the user's own button included — "off means off").
 * - Exactly one ntfy notification per new version, surviving restarts
 *   (dedupe lives in the update_last_notified_version settings row).
 * - Forced checks are throttled server-side: within
 *   FORCED_CHECK_MIN_INTERVAL_MS the cache is served, no outbound GET —
 *   a hammered button cannot burn GitHub's unauthenticated rate budget.
 * - A failed (or junk-answering) re-check RETAINS the last successful
 *   sighting — one blip must not un-light the banner until tomorrow.
 * - Apply: 409 unconfigured; configured -> exactly ONE POST, bearer only
 *   when a token is set, and the bearer NEVER rides the check request.
 *   A trigger that ANSWERS non-2xx is remembered as lastApplyError (cleared
 *   on the next attempt); rejections stay warn-only — an aborted socket is
 *   what a successful swap of this very container looks like.
 * - Trigger URL/token are write-only: presence flag on read, excluded from
 *   GET /api/settings (remember: routes/settings.ts's NOT IN (?,...) list
 *   is hand-counted — add BOTH placeholders and bound args).
 */

interface OutboundCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

interface NotifySent {
  url: string;
  title: string | undefined;
  body: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Pins the version source of truth: server/package.json (NOT the root
// package.json, NOT db.ts CURRENT_VERSION which is the SQLite schema ladder).
const SERVER_PKG_VERSION = (
  JSON.parse(fs.readFileSync(path.resolve(here, "../../package.json"), "utf-8")) as {
    version: string;
  }
).version;
const ORIGINAL_BUILD_CHANNEL = process.env.DRAW_BUILD_CHANNEL;
const ORIGINAL_BUILD_SHA = process.env.DRAW_BUILD_SHA;
const FULL_BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";

let app: express.Express;
let calls: OutboundCall[];
let notifySent: NotifySent[];
let releaseTag: string;
let checkFails: boolean;

beforeEach(async () => {
  delete process.env.DRAW_BUILD_CHANNEL;
  delete process.env.DRAW_BUILD_SHA;
  app = await freshApp();
  calls = [];
  notifySent = [];
  releaseTag = "v0.0.1"; // older than any running version — no update by default
  checkFails = false;

  setFetchForTests((url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    if (checkFails) return Promise.reject(new Error("getaddrinfo ENOTFOUND api.github.com"));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          tag_name: releaseTag,
          html_url: `https://github.com/FelixGeisler/draw/releases/tag/${releaseTag}`,
        }),
    });
  });
  setNotifyFetchForTests((url, init) => {
    notifySent.push({
      url,
      title: (init.headers as Record<string, string> | undefined)?.Title,
      body: String(init.body),
    });
    return Promise.resolve({ ok: true, status: 200 });
  });

  // The DATA_DIR database lives per test FILE — earlier tests' writes leak
  // into later ones, so every test starts from a known-clean update state.
  await request(app).delete("/api/notify/url");
  deleteSetting(UPDATE_CHECK_ENABLED_SETTING);
  deleteSetting(UPDATE_TRIGGER_URL_SETTING);
  deleteSetting(UPDATE_TRIGGER_TOKEN_SETTING);
  deleteSetting(UPDATE_LAST_NOTIFIED_SETTING);
  resetUpdateStateForTests(); // drop the in-memory cache, as a restart would
});

afterEach(() => {
  setFetchForTests(null);
  setNotifyFetchForTests(null);
  if (ORIGINAL_BUILD_CHANNEL === undefined) delete process.env.DRAW_BUILD_CHANNEL;
  else process.env.DRAW_BUILD_CHANNEL = ORIGINAL_BUILD_CHANNEL;
  if (ORIGINAL_BUILD_SHA === undefined) delete process.env.DRAW_BUILD_SHA;
  else process.env.DRAW_BUILD_SHA = ORIGINAL_BUILD_SHA;
});

const drain = () => new Promise((resolve) => setImmediate(resolve));
const getStatus = async (): Promise<UpdateStatus> =>
  (await request(app).get("/api/update")).body as UpdateStatus;

describe("the tell surface", () => {
  it("keeps /api/health exactly {ok, time} — the version is authed data (ADR-50)", async () => {
    // Regression pin, green before AND after #247: health is the only
    // pre-auth endpoint, and it must not grow a version field.
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(["ok", "time"]);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it("GET /api/update reports the running version and the full status shape", async () => {
    const res = await request(app).get("/api/update");
    expect(res.status).toBe(200);
    const status = res.body as UpdateStatus;
    expect(status.current).toBe(SERVER_PKG_VERSION);
    expect(Object.keys(status).sort()).toEqual([
      "applyConfigured",
      "buildChannel",
      "buildIdentity",
      "buildSha",
      "checkEnabled",
      "checkedAt",
      "current",
      "lastApplyError",
      "latest",
      "releaseUrl",
      "updateAvailable",
    ]);
    expect(status.buildChannel).toBe("local");
    expect(status.buildSha).toBeNull();
    expect(status.buildIdentity).toBe(`local:version-${SERVER_PKG_VERSION}`);
    expect(status.checkEnabled).toBe(true); // default ON
    expect(status.applyConfigured).toBe(false);
    expect(status.updateAvailable).toBe(false);
    expect(status.checkedAt).toBeNull(); // cache is in-memory; fresh boot has none
    // The GET is a cache read — it must never trigger an outbound call.
    expect(calls).toEqual([]);
  });

  it("authenticated GET reports every supported channel and invalid/missing SHAs", async () => {
    const { createApp } = await import("../../src/app.js");
    const gated = createApp({ password: "identity-spec-secret" });
    const cases = [
      {
        channel: "stable",
        sha: FULL_BUILD_SHA,
        expectedChannel: "stable",
        expectedSha: FULL_BUILD_SHA,
      },
      {
        channel: "edge",
        sha: FULL_BUILD_SHA.toUpperCase(),
        expectedChannel: "edge",
        expectedSha: FULL_BUILD_SHA,
      },
      { channel: "local", sha: "not-a-sha", expectedChannel: "local", expectedSha: null },
      {
        channel: "preview",
        sha: FULL_BUILD_SHA,
        expectedChannel: "local",
        expectedSha: FULL_BUILD_SHA,
      },
      { channel: " stable ", sha: " ", expectedChannel: "stable", expectedSha: null },
      { channel: "EDGE", sha: undefined, expectedChannel: "local", expectedSha: null },
    ] as const;

    for (const entry of cases) {
      process.env.DRAW_BUILD_CHANNEL = entry.channel;
      if (entry.sha === undefined) delete process.env.DRAW_BUILD_SHA;
      else process.env.DRAW_BUILD_SHA = entry.sha;
      const response = await request(gated)
        .get("/api/update")
        .set("x-draw-password", "identity-spec-secret");
      expect(response.status).toBe(200);
      const status = response.body as UpdateStatus;
      expect(status.buildChannel).toBe(entry.expectedChannel);
      expect(status.buildSha).toBe(entry.expectedSha);
      expect(status.buildIdentity).toBe(
        entry.expectedSha
          ? `${entry.expectedChannel}:${entry.expectedSha}`
          : `${entry.expectedChannel}:version-${SERVER_PKG_VERSION}`,
      );
      expect(status.current).toBe(SERVER_PKG_VERSION);
      expect(status.latest).toBeNull();
      expect(status.updateAvailable).toBe(false);
    }
  });

  it("requires auth when DRAW_PASSWORD is set — the health/version split", async () => {
    const { createApp } = await import("../../src/app.js");
    const gated = createApp({ password: "update-spec-secret" });
    expect((await request(gated).get("/api/update")).status).toBe(401);
    expect((await request(gated).post("/api/update/apply")).status).toBe(401);
    const authed = await request(gated)
      .get("/api/update")
      .set("x-draw-password", "update-spec-secret");
    expect(authed.status).toBe(200);
    expect((authed.body as UpdateStatus).current).toBe(SERVER_PKG_VERSION);
  });
});

describe("the check", () => {
  it("disabled means ZERO outbound calls — even the forced check (#235 rule)", async () => {
    setSetting(UPDATE_CHECK_ENABLED_SETTING, "0");
    // The same door every scheduler tick goes through:
    await checkForUpdate();
    // Deliberate pin: the toggle gates the user's own "Check now" too — off
    // means off. The forced check still answers, degraded, without a call.
    const res = await request(app).post("/api/update/check");
    expect(res.status).toBe(200);
    expect((res.body as UpdateStatus).checkEnabled).toBe(false);
    expect(calls).toEqual([]);
    expect(notifySent).toEqual([]);
  });

  it("the toggle rides PATCH /api/settings — it is not a secret", async () => {
    const patched = await request(app)
      .patch("/api/settings")
      .send({ [UPDATE_CHECK_ENABLED_SETTING]: "0" });
    expect(patched.status).toBe(200);
    expect((patched.body as Record<string, string>)[UPDATE_CHECK_ENABLED_SETTING]).toBe("0");
    expect((await getStatus()).checkEnabled).toBe(false);
  });

  it("an enabled check GETs the release endpoint once, parsing tag_name/html_url", async () => {
    releaseTag = "v99.0.0";
    await checkForUpdate();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(DEFAULT_UPDATE_CHECK_URL);
    expect(calls[0].headers.Accept).toBe("application/vnd.github+json");
    const status = await getStatus();
    expect(status.updateAvailable).toBe(true);
    expect(status.latest).toContain("99.0.0");
    expect(status.releaseUrl).toBe("https://github.com/FelixGeisler/draw/releases/tag/v99.0.0");
    expect(status.checkedAt).toBeTruthy();
  });

  it("POST /api/update/check forces a re-check and returns the fresh status", async () => {
    releaseTag = "v99.0.0";
    const res = await request(app).post("/api/update/check");
    expect(res.status).toBe(200);
    expect((res.body as UpdateStatus).updateAvailable).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("a failed check degrades: resolves without throwing, offers no update", async () => {
    checkFails = true;
    await expect(checkForUpdate()).resolves.toBeDefined();
    const status = await getStatus();
    expect(status.updateAvailable).toBe(false);
    expect(status.latest).toBeNull();
    await drain();
    expect(notifySent).toEqual([]); // a failure is never a "new version"
  });

  it("throttles the forced check: within the min interval the cache is served", async () => {
    releaseTag = "v99.0.0";
    expect((await request(app).post("/api/update/check")).status).toBe(200);
    expect(calls.length).toBe(1);
    // Hammering the button (or a curl loop) must not reach GitHub again —
    // the unauthenticated budget is 60 req/hr for the whole host.
    const second = await request(app).post("/api/update/check");
    expect(second.status).toBe(200);
    expect((second.body as UpdateStatus).updateAvailable).toBe(true); // the cache, not a refusal
    expect(calls.length).toBe(1);
    // Past the window the forced check goes outbound again. Only Date is
    // faked — supertest and the abort timer keep their real timers.
    vi.useFakeTimers({ now: Date.now() + FORCED_CHECK_MIN_INTERVAL_MS + 1_000, toFake: ["Date"] });
    try {
      expect((await request(app).post("/api/update/check")).status).toBe(200);
      expect(calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed re-check keeps the last successful sighting — one blip must not un-light the banner", async () => {
    releaseTag = "v99.0.0";
    await checkForUpdate();
    expect((await getStatus()).updateAvailable).toBe(true);
    checkFails = true;
    await expect(checkForUpdate()).resolves.toBeDefined();
    const status = await getStatus();
    expect(status.updateAvailable).toBe(true); // yesterday's sighting still stands
    expect(status.latest).toContain("99.0.0");
    expect(status.releaseUrl).toContain("v99.0.0");
    expect(status.checkedAt).toBeTruthy(); // the attempt itself IS recorded
  });

  it("a reachable feed answering junk counts as a failed check — sighting retained", async () => {
    releaseTag = "v99.0.0";
    await checkForUpdate();
    setFetchForTests(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ garbage: true }) }),
    );
    await expect(checkForUpdate()).resolves.toBeDefined();
    const status = await getStatus();
    expect(status.latest).toContain("99.0.0"); // junk is a failure, not "no update"
    expect(status.updateAvailable).toBe(true);
  });

  it("honors the UPDATE_CHECK_URL env override — tests and proxied networks", async () => {
    process.env.UPDATE_CHECK_URL = "https://releases.example.test/latest";
    try {
      await checkForUpdate();
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("https://releases.example.test/latest");
    } finally {
      delete process.env.UPDATE_CHECK_URL;
    }
  });
});

describe("one notification per new version", () => {
  it("first sighting notifies once — deduped across re-checks AND restarts", async () => {
    await request(app).put("/api/notify/url").send({ url: "https://ntfy.sh/update-topic" });
    releaseTag = "v99.0.0";
    await checkForUpdate();
    await drain();
    expect(notifySent.length).toBe(1);
    expect(notifySent[0].url).toBe("https://ntfy.sh/update-topic");
    expect(notifySent[0].title).toBeTruthy();
    // The body names BOTH versions and carries the release link.
    expect(notifySent[0].body).toContain("99.0.0");
    expect(notifySent[0].body).toContain(SERVER_PKG_VERSION);
    expect(notifySent[0].body).toContain(
      "https://github.com/FelixGeisler/draw/releases/tag/v99.0.0",
    );

    await checkForUpdate(); // same version re-checked: no second send
    resetUpdateStateForTests(); // simulated restart: in-memory cache gone…
    await checkForUpdate(); // …but update_last_notified_version persists
    await drain();
    expect(notifySent.length).toBe(1);

    releaseTag = "v100.0.0"; // a NEWER release is a fresh sighting
    await checkForUpdate();
    await drain();
    expect(notifySent.length).toBe(2);
    expect(notifySent[1].body).toContain("100.0.0");
  });

  it("no notify_url configured: the check still works, zero sends", async () => {
    releaseTag = "v99.0.0";
    await checkForUpdate();
    expect((await getStatus()).updateAvailable).toBe(true);
    await drain();
    expect(notifySent).toEqual([]);
  });
});

describe("apply — the trigger", () => {
  const TRIGGER_URL = "http://watchtower:8080/v1/update";
  const TOKEN = "wt-spec-bearer-secret";

  it("unconfigured apply is a 409 pointing at the deployment guide", async () => {
    const res = await request(app).post("/api/update/apply");
    expect(res.status).toBe(409);
    expect(String((res.body as { error?: string }).error)).toMatch(/deploy/i);
    expect(calls).toEqual([]); // refusing must not fire anything
  });

  it("PUT /api/update/trigger validates http(s) and answers presence-only", async () => {
    expect((await request(app).put("/api/update/trigger").send({ url: "not a url" })).status).toBe(
      400,
    );
    expect((await request(app).put("/api/update/trigger").send({ url: "ftp://x" })).status).toBe(
      400,
    );
    const saved = await request(app)
      .put("/api/update/trigger")
      .send({ url: TRIGGER_URL, token: TOKEN });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ configured: true });
    expect((await getStatus()).applyConfigured).toBe(true);
    const removed = await request(app).delete("/api/update/trigger");
    expect(removed.body).toEqual({ configured: false });
    expect((await getStatus()).applyConfigured).toBe(false);
  });

  it("trigger URL and token never read back — excluded from GET /api/settings", async () => {
    const saved = await request(app)
      .put("/api/update/trigger")
      .send({ url: TRIGGER_URL, token: TOKEN });
    expect(saved.status).toBe(200);
    const settings = (await request(app).get("/api/settings")).body as Record<string, string>;
    expect(JSON.stringify(settings)).not.toContain("watchtower:8080");
    expect(JSON.stringify(settings)).not.toContain(TOKEN);
    expect(settings[UPDATE_TRIGGER_URL_SETTING]).toBeUndefined();
    expect(settings[UPDATE_TRIGGER_TOKEN_SETTING]).toBeUndefined();
    // Nor through the status endpoint — applyConfigured is the only echo.
    const status = await getStatus();
    expect(JSON.stringify(status)).not.toContain("watchtower:8080");
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it("configured apply: 202, exactly ONE POST, bearer attached", async () => {
    await request(app).put("/api/update/trigger").send({ url: TRIGGER_URL, token: TOKEN });
    calls = [];
    const res = await request(app).post("/api/update/apply");
    expect(res.status).toBe(202);
    await drain();
    expect(calls.length).toBe(1); // one POST, nowhere else
    expect(calls[0].url).toBe(TRIGGER_URL);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("no token stored: the trigger POST carries no Authorization header", async () => {
    await request(app).put("/api/update/trigger").send({ url: TRIGGER_URL });
    calls = [];
    const res = await request(app).post("/api/update/apply");
    expect(res.status).toBe(202);
    await drain();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(TRIGGER_URL);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("a trigger that answers non-2xx becomes lastApplyError — cleared on the next attempt", async () => {
    await request(app).put("/api/update/trigger").send({ url: TRIGGER_URL, token: TOKEN });
    setFetchForTests(() => Promise.resolve({ ok: false, status: 401 }));
    // The fire-and-forget contract holds: still a 202, never a throw.
    expect((await request(app).post("/api/update/apply")).status).toBe(202);
    await drain();
    expect(String((await getStatus()).lastApplyError)).toContain("401");
    // A NEW attempt starts with a clean verdict — the polling client keys
    // on lastApplyError to stop waiting, so a stale one would kill a
    // perfectly good retry.
    setFetchForTests(() => Promise.resolve({ ok: true, status: 200 }));
    expect((await request(app).post("/api/update/apply")).status).toBe(202);
    await drain();
    expect((await getStatus()).lastApplyError).toBeNull();
  });

  it("a rejecting trigger POST stays warn-only — a dropped socket is what a successful swap looks like", async () => {
    await request(app).put("/api/update/trigger").send({ url: TRIGGER_URL });
    setFetchForTests(() => Promise.reject(new Error("socket hang up")));
    expect((await request(app).post("/api/update/apply")).status).toBe(202);
    await drain();
    expect((await getStatus()).lastApplyError).toBeNull();
  });

  it("a synchronously-throwing fetch cannot escape the fire-and-forget", async () => {
    await request(app).put("/api/update/trigger").send({ url: TRIGGER_URL });
    setFetchForTests(() => {
      throw new Error("sync boom");
    });
    expect((await request(app).post("/api/update/apply")).status).toBe(202);
    await drain();
    expect((await getStatus()).lastApplyError).toBeNull();
  });

  it("the bearer token NEVER rides the check request", async () => {
    // The token authorizes restarting the app; leaking it to the (default
    // GitHub, possibly proxied) check URL would hand that power away.
    await request(app).put("/api/update/trigger").send({ url: TRIGGER_URL, token: TOKEN });
    calls = [];
    releaseTag = "v99.0.0";
    await checkForUpdate();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(DEFAULT_UPDATE_CHECK_URL);
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(JSON.stringify(calls[0].headers)).not.toContain(TOKEN);
  });
});

// Type-level guard that the status shape stays what GET /api/update serves.
const _shape: UpdateStatus = {
  current: "1.0.0",
  buildChannel: "stable",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
  buildIdentity: "stable:0123456789abcdef0123456789abcdef01234567",
  latest: "1.1.0",
  updateAvailable: true,
  releaseUrl: "https://github.com/FelixGeisler/draw/releases/tag/v1.1.0",
  checkedAt: "2026-08-17T00:00:00.000Z",
  checkEnabled: true,
  applyConfigured: false,
  lastApplyError: null,
};
void _shape;
