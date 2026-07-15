import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp, testDb } from "../helpers.js";

// Card art endpoint (#27): GET /api/tasks/:id/card-art. The generation call
// itself is mocked (tests never hit the Claude API — setup.ts guarantees
// degraded mode, and the key set below is a dummy that only flips
// isConfigured()); everything around it is real: routing, the sanitizer,
// the card_art cache and its ON DELETE CASCADE.
const mocks = vi.hoisted(() => ({ generateCardArt: vi.fn() }));

vi.mock("../../src/services/aiService.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateCardArt: mocks.generateCardArt,
}));

// What a hostile/misbehaving model could return: valid art wrapped around
// every major smuggling vector. The endpoint must store and serve only the
// sanitized survivors.
const HOSTILE_SVG =
  `<svg viewBox="0 0 300 420" onload="alert(1)">` +
  `<script>fetch("https://evil.example")</script>` +
  `<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>` +
  `<image href="https://evil.example/x.png"/>` +
  `<use href="javascript:alert(2)"/>` +
  `<defs><linearGradient id="g"><stop offset="0" stop-color="#4f8cff"/></linearGradient></defs>` +
  `<rect width="300" height="420" fill="url(#g)" onclick="alert(3)"/>` +
  `<path d="M0 0 L300 420" stroke="#232735"/>` +
  `</svg>`;

let app: express.Express;
let taskId: number;

beforeAll(async () => {
  app = await freshApp();
  const task = (
    await request(app)
      .post("/api/tasks")
      .send({ title: "Artful task", categoryId: 1, effortMinutes: 15 })
      .expect(201)
  ).body;
  taskId = task.id;
});

describe("degraded mode (no API key)", () => {
  it("answers 503 ai_not_configured without calling generation or writing a row", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/card-art`).expect(503);
    expect(res.body.error).toBe("ai_not_configured");
    expect(mocks.generateCardArt).not.toHaveBeenCalled();

    const db = await testDb();
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_art").get()).toEqual({ n: 0 });
  });

  it("answers 404 for an unknown task — even before the key check", async () => {
    const res = await request(app).get("/api/tasks/999999/card-art").expect(404);
    expect(res.body.error).toMatch(/task not found/);
  });
});

describe("generation, sanitization and the once-per-task cache", () => {
  beforeAll(async () => {
    // Dummy key via the settings endpoint: flips isConfigured() to true; the
    // only network-touching function is mocked above.
    await request(app).put("/api/ai/key").send({ key: "sk-ant-test-dummy" }).expect(200);
    mocks.generateCardArt.mockResolvedValue(HOSTILE_SVG);
  });

  it("first call generates, sanitizes BEFORE storing, and serves the clean SVG", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/card-art`).expect(200);
    expect(mocks.generateCardArt).toHaveBeenCalledTimes(1);
    expect(mocks.generateCardArt).toHaveBeenCalledWith(taskId);

    const svg = res.body.svg as string;
    // hostile parts gone…
    expect(svg).not.toMatch(/script|foreignObject|iframe|onload|onclick|javascript|evil/i);
    expect(svg).not.toContain("<image");
    // …benign art intact
    expect(svg).toContain('fill="url(#g)"');
    expect(svg).toContain("<linearGradient");
    expect(svg).toContain('d="M0 0 L300 420"');

    // the STORED row is the sanitized markup, not the raw model output
    const db = await testDb();
    const row = db.prepare("SELECT svg FROM card_art WHERE task_id = ?").get(taskId) as {
      svg: string;
    };
    expect(row.svg).toBe(svg);
    expect(row.svg).not.toMatch(/script/i);
  });

  it("second call serves from cache without a second generation", async () => {
    const first = await request(app).get(`/api/tasks/${taskId}/card-art`).expect(200);
    const second = await request(app).get(`/api/tasks/${taskId}/card-art`).expect(200);
    expect(second.body.svg).toBe(first.body.svg);
    expect(mocks.generateCardArt).toHaveBeenCalledTimes(1); // still just the initial call
  });

  it("does NOT cache output that fails sanitization, so a later view can retry", async () => {
    const doomed = (
      await request(app)
        .post("/api/tasks")
        .send({ title: "Unlucky art", categoryId: 1, effortMinutes: 10 })
        .expect(201)
    ).body;

    mocks.generateCardArt.mockResolvedValueOnce("total garbage, not svg at all");
    const res = await request(app).get(`/api/tasks/${doomed.id}/card-art`).expect(502);
    expect(res.body.error).toMatch(/unusable/i);

    const db = await testDb();
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_art WHERE task_id = ?").get(doomed.id)).toEqual({ n: 0 });

    // the retry (mock back to good output) succeeds and caches
    await request(app).get(`/api/tasks/${doomed.id}/card-art`).expect(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_art WHERE task_id = ?").get(doomed.id)).toEqual({ n: 1 });
  });

  it("deleting the task cascade-deletes its cached art", async () => {
    const db = await testDb();
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_art WHERE task_id = ?").get(taskId)).toEqual({ n: 1 });

    await request(app).delete(`/api/tasks/${taskId}`).expect(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_art WHERE task_id = ?").get(taskId)).toEqual({ n: 0 });
  });
});
