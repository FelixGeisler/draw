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

  it("serves static assets by path, cached as immutable", async () => {
    const res = await request(app).get("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.text).toBe(ASSET_BODY);
    // Vite content-hashes assets/* — they may cache forever; the entry
    // document must not (a redeploy swaps the manifest under it).
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const index = await request(app).get("/");
    expect(index.headers["cache-control"]).toBe("no-cache");
  });

  it("404s a missing asset instead of handing the browser index.html", async () => {
    // A stale-hash tab after a redeploy requests a script that no longer
    // exists — 200 text/html here would be a MIME error, not a page view.
    for (const missing of ["/assets/app-OLDHASH.js", "/favicon-gone.png"]) {
      const res = await request(app).get(missing);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain(INDEX_MARKER);
    }
  });

  it("answers client deep links with index.html (SPA fallback)", async () => {
    // The query-string case pins req.path (not req.url) as the dispatch key.
    for (const deepLink of ["/stats", "/goals", "/settings", "/stats?range=30d"]) {
      const res = await request(app).get(deepLink);
      expect(res.status).toBe(200);
      expect(res.text).toContain(INDEX_MARKER);
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
  });

  it("leaves /api routes untouched", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("404s unknown /api paths as JSON — never the SPA fallback", async () => {
    // Express 5 route matching is case-insensitive, so the API namespace
    // guard must be too: /API/nope is the same miss as /api/nope.
    for (const missing of ["/api/definitely-not-a-route", "/api", "/API/definitely-not-a-route"]) {
      const res = await request(app).get(missing);
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body).toEqual({ error: "not found" });
    }
  });

  it("does not answer non-GET requests with the fallback", async () => {
    const res = await request(app).post("/stats");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(INDEX_MARKER);
  });

  it("does not advertise the framework", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("dev mode (no clientDir)", () => {
  it("serves no client — non-API paths 404, /api misses stay JSON", async () => {
    const { createApp } = await import("../../src/app.js");
    const devApp = createApp();
    expect((await request(devApp).get("/")).status).toBe(404);
    expect((await request(devApp).get("/stats")).status).toBe(404);
    expect((await request(devApp).get("/api/health")).status).toBe(200);
    const miss = await request(devApp).get("/api/definitely-not-a-route");
    expect(miss.status).toBe(404);
    expect(miss.body).toEqual({ error: "not found" });
  });
});
