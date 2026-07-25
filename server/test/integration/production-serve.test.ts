import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";

// Production serve mode (#189, ADR-49): with `clientDir` set, createApp()
// serves the built client and answers deep links with index.html — while the
// /api surface behaves exactly as in dev. The client build is faked with a
// marker so the suite does not depend on vite output.

const INDEX_MARKER = "draw-spa-index-marker";
const ASSET_BODY = "console.log('draw-asset');";

let clientDir: string;
let app: express.Express;

beforeAll(async () => {
  clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-client-dist-"));
  fs.writeFileSync(
    path.join(clientDir, "index.html"),
    `<!doctype html><html><body>${INDEX_MARKER}</body></html>`,
  );
  fs.mkdirSync(path.join(clientDir, "assets"));
  fs.writeFileSync(path.join(clientDir, "assets", "app.js"), ASSET_BODY);

  const { createApp } = await import("../../src/app.js");
  app = createApp({ clientDir });
});

afterAll(() => {
  fs.rmSync(clientDir, { recursive: true, force: true });
});

describe("production serve mode", () => {
  it("serves index.html at /", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain(INDEX_MARKER);
  });

  it("serves static assets by path", async () => {
    const res = await request(app).get("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toBe(ASSET_BODY);
  });

  it("answers client deep links with index.html (SPA fallback)", async () => {
    for (const deepLink of ["/stats", "/goals", "/settings"]) {
      const res = await request(app).get(deepLink);
      expect(res.status).toBe(200);
      expect(res.text).toContain(INDEX_MARKER);
    }
  });

  it("leaves /api routes untouched", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("keeps 404s for unknown /api paths — never the SPA fallback", async () => {
    for (const missing of ["/api/definitely-not-a-route", "/api"]) {
      const res = await request(app).get(missing);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain(INDEX_MARKER);
    }
  });

  it("does not answer non-GET requests with the fallback", async () => {
    const res = await request(app).post("/stats");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(INDEX_MARKER);
  });
});

describe("dev mode (no clientDir)", () => {
  it("serves no client — non-API paths 404 as before", async () => {
    const { createApp } = await import("../../src/app.js");
    const devApp = createApp();
    expect((await request(devApp).get("/")).status).toBe(404);
    expect((await request(devApp).get("/stats")).status).toBe(404);
    expect((await request(devApp).get("/api/health")).status).toBe(200);
  });
});
