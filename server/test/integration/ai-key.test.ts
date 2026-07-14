import { afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

// Obviously fake keys — never real credentials.
const FAKE_DB_KEY = "sk-ant-test-db-key-000000000000";
const FAKE_ENV_KEY = "sk-ant-test-env-key-111111111111";

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

afterEach(async () => {
  // Hermetic: test/setup.ts already removed the real env key; each test
  // leaves no key behind for the next one.
  delete process.env.ANTHROPIC_API_KEY;
  await request(app).delete("/api/ai/key");
});

describe("API key management", () => {
  it("starts unconfigured (no env key, no DB key)", async () => {
    const status = (await request(app).get("/api/ai/status").expect(200)).body;
    expect(status).toMatchObject({ configured: false, keySource: null });
  });

  it("setting a key via the API flips status without a restart", async () => {
    await request(app).post("/api/ai/breakdown").send({ taskId: 1 }).expect(503);

    const set = (
      await request(app).put("/api/ai/key").send({ key: FAKE_DB_KEY }).expect(200)
    ).body;
    expect(set).toMatchObject({ configured: true, keySource: "database" });

    // Same process, no restart — status now reports configured.
    const status = (await request(app).get("/api/ai/status").expect(200)).body;
    expect(status.configured).toBe(true);
    expect(status.model).toMatch(/^claude-/);
  });

  it("rejects an empty or missing key", async () => {
    await request(app).put("/api/ai/key").send({}).expect(400);
    await request(app).put("/api/ai/key").send({ key: "   " }).expect(400);
    await request(app).put("/api/ai/key").send({ key: 42 }).expect(400);
  });

  it("never returns the key from any endpoint", async () => {
    await request(app).put("/api/ai/key").send({ key: FAKE_DB_KEY }).expect(200);

    const settings = (await request(app).get("/api/settings").expect(200)).body;
    expect(JSON.stringify(settings)).not.toContain(FAKE_DB_KEY);
    expect(settings).not.toHaveProperty("anthropic_api_key");

    const patched = (
      await request(app).patch("/api/settings").send({ max_draw_effort: 25 }).expect(200)
    ).body;
    expect(JSON.stringify(patched)).not.toContain(FAKE_DB_KEY);
    expect(patched).not.toHaveProperty("anthropic_api_key");

    const status = (await request(app).get("/api/ai/status").expect(200)).body;
    expect(JSON.stringify(status)).not.toContain(FAKE_DB_KEY);
  });

  it("PATCH /api/settings cannot write the key row", async () => {
    await request(app)
      .patch("/api/settings")
      .send({ anthropic_api_key: FAKE_DB_KEY })
      .expect(200);
    const status = (await request(app).get("/api/ai/status").expect(200)).body;
    expect(status.configured).toBe(false);
  });

  it("removing the key returns status to unconfigured", async () => {
    await request(app).put("/api/ai/key").send({ key: FAKE_DB_KEY }).expect(200);

    const removed = (await request(app).delete("/api/ai/key").expect(200)).body;
    expect(removed).toMatchObject({ configured: false, keySource: null });
    await request(app).post("/api/ai/estimate").send({ taskId: 1 }).expect(503);
  });

  it("falls back to the ANTHROPIC_API_KEY env var when no DB key is set", async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_ENV_KEY;
    const status = (await request(app).get("/api/ai/status").expect(200)).body;
    expect(status).toMatchObject({ configured: true, keySource: "environment" });
    expect(JSON.stringify(status)).not.toContain(FAKE_ENV_KEY);
  });

  it("DB key takes precedence over the env var; removal falls back to env", async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_ENV_KEY;
    await request(app).put("/api/ai/key").send({ key: FAKE_DB_KEY }).expect(200);

    let status = (await request(app).get("/api/ai/status").expect(200)).body;
    expect(status).toMatchObject({ configured: true, keySource: "database" });

    await request(app).delete("/api/ai/key").expect(200);
    status = (await request(app).get("/api/ai/status").expect(200)).body;
    expect(status).toMatchObject({ configured: true, keySource: "environment" });
  });
});
