import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

// Degraded mode (#31): without a key every assistant endpoint answers 503
// ai_not_configured — including apply, which never calls the SDK: the whole
// surface is hidden when AI is unconfigured, so a reachable apply would be a
// write path with no UI owning it. Shape 400s still come FIRST (#84), so
// malformed requests stay diagnosable without a key. setup.ts deleted
// ANTHROPIC_API_KEY; no key is ever set in this file.

let app: express.Express;

beforeAll(async () => {
  app = await freshApp();
});

const VALID_APPLY = {
  operations: [
    { kind: "create_task", draftId: "draft-1", task: { title: "t", categoryId: 1 } },
  ],
};

describe("assistant endpoints in degraded mode", () => {
  it("POST /api/ai/agent/message answers 503 ai_not_configured", async () => {
    const res = await request(app).post("/api/ai/agent/message").send({ message: "hello" }).expect(503);
    expect(res.body.error).toBe("ai_not_configured");
  });

  it("POST /api/ai/agent/estimate answers 503 ai_not_configured", async () => {
    const res = await request(app).post("/api/ai/agent/estimate").send({ message: "hello" }).expect(503);
    expect(res.body.error).toBe("ai_not_configured");
  });

  it("POST /api/ai/agent/apply answers 503 ai_not_configured and writes nothing", async () => {
    const before = (await request(app).get("/api/tasks?status=all").expect(200)).body.length;
    const res = await request(app).post("/api/ai/agent/apply").send(VALID_APPLY).expect(503);
    expect(res.body.error).toBe("ai_not_configured");
    const after = (await request(app).get("/api/tasks?status=all").expect(200)).body.length;
    expect(after).toBe(before);
  });
});

describe("request-shape 400s run before the key check (#84)", () => {
  it("message: missing/blank message", async () => {
    for (const body of [{}, { message: "  " }, { message: 5 }]) {
      const res = await request(app).post("/api/ai/agent/message").send(body).expect(400);
      expect(res.body.error).toMatch(/message is required/);
    }
  });

  it("message: malformed goalId, materialIds and sessionId", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ message: "m", goalId: "one" }, /goalId/],
      [{ message: "m", materialIds: [0] }, /materialIds/],
      [{ message: "m", materialIds: "1,2" }, /materialIds/],
      [{ message: "m", sessionId: 42 }, /sessionId/],
    ];
    for (const [body, re] of cases) {
      const res = await request(app).post("/api/ai/agent/message").send(body).expect(400);
      expect(res.body.error).toMatch(re);
    }
  });

  it("apply: malformed operations are rejected with a zod message", async () => {
    const res = await request(app)
      .post("/api/ai/agent/apply")
      .send({ operations: [{ kind: "create_task", draftId: "nope", task: { title: "t" } }] })
      .expect(400);
    expect(res.body.error).toMatch(/invalid operations/);
  });

  it("apply: empty operations array is rejected", async () => {
    await request(app).post("/api/ai/agent/apply").send({ operations: [] }).expect(400);
  });
});
