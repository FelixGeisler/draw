import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshApp } from "../helpers.js";
import {
  notifyChallengeCompleted,
  setFetchForTests,
  type NotifyEvent,
} from "../../src/services/notifyService.js";
import { challengeForDay } from "../../src/services/challengeService.js";

/**
 * Outbound notifications (#235, ADR-67). Every test runs against the
 * injectable fetch — no socket is ever opened. The load-bearing assertions:
 * ZERO calls while notify_url is unset, the URL never leaks through
 * GET /api/settings, and a dead endpoint changes nothing but a log line.
 */

interface Sent {
  url: string;
  title: string | undefined;
  body: string;
}

let app: express.Express;
let sent: Sent[];
let failNext: boolean;

beforeEach(async () => {
  app = await freshApp();
  sent = [];
  failNext = false;
  setFetchForTests((url, init) => {
    if (failNext) return Promise.reject(new Error("connect ECONNREFUSED"));
    sent.push({
      url,
      title: (init.headers as Record<string, string> | undefined)?.Title,
      body: String(init.body),
    });
    return Promise.resolve({ ok: true, status: 200 });
  });
});

afterEach(() => {
  setFetchForTests(null);
});

async function completeFreshTask(title: string): Promise<void> {
  const categories = (await request(app).get("/api/categories")).body as { id: number }[];
  const task = (
    await request(app)
      .post("/api/tasks")
      .send({ title, categoryId: categories[0].id, effortMinutes: 10 })
  ).body as { id: number };
  const res = await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" });
  expect(res.status).toBe(200);
}

describe("notify config surface", () => {
  it("starts unconfigured; PUT validates; DELETE turns it back off", async () => {
    expect((await request(app).get("/api/notify")).body).toEqual({ configured: false });
    expect((await request(app).put("/api/notify/url").send({ url: "not a url" })).status).toBe(400);
    expect((await request(app).put("/api/notify/url").send({ url: "ftp://x" })).status).toBe(400);
    expect((await request(app).put("/api/notify/url").send({ url: "https://ntfy.sh/my-topic" })).body).toEqual({
      configured: true,
    });
    expect((await request(app).delete("/api/notify/url")).body).toEqual({ configured: false });
  });

  it("never leaks the URL through GET /api/settings", async () => {
    await request(app).put("/api/notify/url").send({ url: "https://ntfy.sh/secret-topic" });
    const settings = (await request(app).get("/api/settings")).body as Record<string, string>;
    expect(JSON.stringify(settings)).not.toContain("secret-topic");
    expect(settings.notify_url).toBeUndefined();
  });
});

describe("event delivery", () => {
  // The DATA_DIR database lives per test FILE, so earlier tests' PUTs leak
  // into later ones — every test here starts from an explicit off state.
  beforeEach(async () => {
    await request(app).delete("/api/notify/url");
    sent = [];
  });

  it("makes ZERO calls while notify_url is unset", async () => {
    await completeFreshTask("silent one"); // unlocks first_completion
    expect(sent).toEqual([]);
  });

  it("posts one batched unlock notification for a completion's achievements", async () => {
    // The zero-calls test above already burned first_completion in this
    // file's shared DB — re-arm it (the daily-challenge suite's precedent:
    // delete the row and take over the event).
    const { testDb } = await import("../helpers.js");
    (await testDb()).prepare("DELETE FROM achievements WHERE key = 'first_completion'").run();
    await request(app).put("/api/notify/url").send({ url: "https://ntfy.sh/t" });
    await completeFreshTask("loud one"); // first_completion unlocks (again)
    const unlock = sent.find((e) => e.title?.includes("chievement"));
    expect(unlock).toBeDefined();
    expect(unlock!.url).toBe("https://ntfy.sh/t");
    expect(unlock!.body).toContain("Off the mark");
  });

  it("announces an achieved goal by its title", async () => {
    await request(app).put("/api/notify/url").send({ url: "https://ntfy.sh/t" });
    const goal = (await request(app).post("/api/goals").send({ title: "Ship the thing" })).body as {
      id: number;
    };
    await request(app).patch(`/api/goals/${goal.id}`).send({ status: "achieved" });
    const ping = sent.find((e) => e.title === "Goal achieved");
    expect(ping).toBeDefined();
    expect(ping!.body).toContain("Ship the thing");
  });

  it("uses the exact cumulative XP and Gold challenge notification", async () => {
    await request(app).put("/api/notify/url").send({ url: "https://ntfy.sh/t" });
    const day = "2026-08-22";
    const challenge = challengeForDay(day);
    notifyChallengeCompleted({ day, key: challenge.key, label: challenge.label });
    const ping = sent.find((e) => e.title === "Daily challenge complete");
    expect(ping).toBeDefined();
    expect(ping!.body).toMatch(/^✅ .+ — \+50 XP · \+20 Gold$/);
  });

  it("a dead endpoint is swallowed — the request path is unaffected", async () => {
    await request(app).put("/api/notify/url").send({ url: "https://ntfy.sh/t" });
    failNext = true;
    await completeFreshTask("resilient one"); // completes 200 despite the reject
    // Drain the fire-and-forget chain so the rejection is handled in-test.
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe("the test button", () => {
  it("400s with no URL, then reports the endpoint's answer", async () => {
    await request(app).delete("/api/notify/url");
    expect((await request(app).post("/api/notify/test")).status).toBe(400);
    await request(app).put("/api/notify/url").send({ url: "https://ntfy.sh/t" });
    const ok = (await request(app).post("/api/notify/test")).body as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(sent.some((e) => e.title === "Draw test notification")).toBe(true);
    failNext = true;
    const bad = (await request(app).post("/api/notify/test")).body as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("ECONNREFUSED");
  });
});

// Type-level guard that the event shape stays what the wrappers produce.
const _shape: NotifyEvent = { title: "t", body: "b", tags: "tada" };
void _shape;
