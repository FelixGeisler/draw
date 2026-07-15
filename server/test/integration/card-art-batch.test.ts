import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// Cache-only batch art reads (#114/#115): GET /api/card-art?taskIds=1,2,3
// backs the trophy pile's mini-frames. The hard constraint under test:
// rendering the pile must NEVER trigger a Claude generation — the endpoint
// only reads what earlier generations cached, with or without an API key.
const mocks = vi.hoisted(() => ({ generateCardArt: vi.fn() }));

vi.mock("../../src/services/aiService.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateCardArt: mocks.generateCardArt,
}));

const ART = (accent: string) =>
  `<svg viewBox="0 0 300 420"><rect width="300" height="420" fill="#1b1e27"/>` +
  `<circle cx="150" cy="140" r="60" fill="${accent}"/></svg>`;

let app: express.Express;
let cachedId: number; // has a card_art row
let bareId: number; // never generated

beforeAll(async () => {
  app = await freshApp();
  const db = await testDb();

  const create = async (title: string) =>
    (
      await request(app)
        .post("/api/tasks")
        .send({ title, categoryId: 1, effortMinutes: 10 })
        .expect(201)
    ).body.id as number;
  cachedId = await create("Batch cached art");
  bareId = await create("Batch bare chore");

  // Seed the cache row directly — the batch endpoint must not care HOW art
  // came to exist, only that it reads rows without generating.
  db.prepare("INSERT INTO card_art (task_id, svg, created_at) VALUES (?, ?, ?)").run(
    cachedId,
    ART("#4f8cff"),
    new Date().toISOString(),
  );
});

describe("GET /api/card-art (cache-only batch, #114)", () => {
  it("returns cached rows only; unknown and never-generated ids are simply absent", async () => {
    const res = await request(app)
      .get(`/api/card-art?taskIds=${cachedId},${bareId},999999`)
      .expect(200);
    expect(res.body.arts).toEqual([{ taskId: cachedId, svg: ART("#4f8cff") }]);
  });

  it("dedupes repeated ids (recurring tasks share one task id across completions)", async () => {
    const res = await request(app)
      .get(`/api/card-art?taskIds=${cachedId},${cachedId},${cachedId}`)
      .expect(200);
    expect(res.body.arts).toHaveLength(1);
    expect(res.body.arts[0].taskId).toBe(cachedId);
  });

  it("never invokes generation — not even for cache misses, key or no key", async () => {
    // Degraded first (setup.ts guarantees no ambient key)...
    await request(app).get(`/api/card-art?taskIds=${bareId}`).expect(200);
    // ...then WITH a (dummy) key configured: still a pure read.
    await request(app).put("/api/ai/key").send({ key: "sk-ant-test-dummy" }).expect(200);
    const res = await request(app).get(`/api/card-art?taskIds=${bareId},${cachedId}`).expect(200);
    expect(res.body.arts).toHaveLength(1); // the miss stayed a miss
    expect(mocks.generateCardArt).not.toHaveBeenCalled();
  });

  it("400s on a missing or empty taskIds (the #84 convention)", async () => {
    for (const qs of ["", "?taskIds=", "?taskIds=%20"]) {
      const res = await request(app).get(`/api/card-art${qs}`).expect(400);
      expect(res.body.error).toMatch(/taskIds/);
    }
  });

  it("400s on malformed ids — letters, negatives, zero, fractions, repeated params", async () => {
    for (const bad of ["abc", "1,two", "-4", "0", "1.5", "1;DROP TABLE card_art"]) {
      const res = await request(app)
        .get(`/api/card-art?taskIds=${encodeURIComponent(bad)}`)
        .expect(400);
      expect(res.body.error).toMatch(/positive integers/);
    }
    // taskIds=1&taskIds=2 parses as an array, not a string — same honest 400.
    await request(app).get(`/api/card-art?taskIds=1&taskIds=2`).expect(400);
  });
});
