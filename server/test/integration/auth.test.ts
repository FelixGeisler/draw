import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";

// The optional LAN password gate (#190, ADR-50) over the real app: off means
// byte-for-byte the pre-#190 surface (regression guard), on means every /api
// route and static asset demands a session cookie or the shared-secret
// header — with /api/health and the login route as the only openings.

const PASSWORD = "correct horse battery staple";
const INDEX_MARKER = "draw-auth-index-marker";

let clientDir: string;
let createApp: (options?: { clientDir?: string; password?: string }) => express.Express;

beforeAll(async () => {
  clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-auth-dist-"));
  fs.writeFileSync(
    path.join(clientDir, "index.html"),
    `<!doctype html><html><body>${INDEX_MARKER}</body></html>`,
  );
  ({ createApp } = await import("../../src/app.js"));
});

afterAll(() => {
  fs.rmSync(clientDir, { recursive: true, force: true });
});

describe("auth disabled (no password)", () => {
  it("leaves API and static wide open — pre-#190 behavior", async () => {
    const app = createApp({ clientDir });
    expect((await request(app).get("/api/health")).status).toBe(200);
    expect((await request(app).get("/api/tasks")).status).toBe(200);
    const index = await request(app).get("/");
    expect(index.status).toBe(200);
    expect(index.text).toContain(INDEX_MARKER);
  });

  it("does not even mount the login route", async () => {
    const app = createApp({ clientDir });
    const res = await request(app).post("/api/auth/login").send({ password: PASSWORD });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not found" });
  });

  it("ignores a stray shared-secret header", async () => {
    const app = createApp({ clientDir });
    const res = await request(app).get("/api/tasks").set("x-draw-password", "whatever");
    expect(res.status).toBe(200);
  });
});

describe("auth enabled", () => {
  let app: express.Express;

  beforeAll(() => {
    app = createApp({ clientDir, password: PASSWORD });
  });

  it("keeps /api/health open — healthchecks poll it before anyone logs in", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("401s unauthenticated /api requests as JSON — known and unknown paths alike", async () => {
    for (const apiPath of ["/api/tasks", "/api/settings", "/api/definitely-not-a-route", "/API/tasks"]) {
      const res = await request(app).get(apiPath);
      expect(res.status).toBe(401);
      expect(res.headers["content-type"]).toContain("application/json");
    }
  });

  it("serves the login page (status 401) for unauthenticated page views", async () => {
    for (const pagePath of ["/", "/stats", "/assets/app.js"]) {
      const res = await request(app).get(pagePath);
      expect(res.status).toBe(401);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.text).toContain('id="password"');
      expect(res.text).not.toContain(INDEX_MARKER);
    }
  });

  it("401s non-GET requests outside /api as JSON, not the login page", async () => {
    const res = await request(app).post("/stats");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("rejects a wrong password", async () => {
    const res = await request(app).post("/api/auth/login").send({ password: "nope" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid password" });
  });

  it("rejects a non-string password payload", async () => {
    const res = await request(app).post("/api/auth/login").send({ password: 42 });
    expect(res.status).toBe(401);
  });

  it("logs in with the correct password: httpOnly lax cookie, API + static unlocked", async () => {
    const login = await request(app).post("/api/auth/login").send({ password: PASSWORD });
    expect(login.status).toBe(204);

    const setCookie = login.headers["set-cookie"]?.[0] ?? "";
    expect(setCookie).toContain("draw_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    const cookie = setCookie.split(";")[0];
    const tasks = await request(app).get("/api/tasks").set("Cookie", cookie);
    expect(tasks.status).toBe(200);
    expect(Array.isArray(tasks.body)).toBe(true);

    const index = await request(app).get("/").set("Cookie", cookie);
    expect(index.status).toBe(200);
    expect(index.text).toContain(INDEX_MARKER);

    // Authenticated /api misses fall through to the JSON 404 again.
    const miss = await request(app).get("/api/definitely-not-a-route").set("Cookie", cookie);
    expect(miss.status).toBe(404);
    expect(miss.body).toEqual({ error: "not found" });
  });

  it("rejects a tampered session cookie", async () => {
    const login = await request(app).post("/api/auth/login").send({ password: PASSWORD });
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const tampered = cookie.slice(0, -4) + (cookie.endsWith("beef") ? "dead" : "beef");
    const res = await request(app).get("/api/tasks").set("Cookie", tampered);
    expect(res.status).toBe(401);
  });

  it("accepts the shared secret as a header — the MCP path", async () => {
    const res = await request(app).get("/api/tasks").set("x-draw-password", PASSWORD);
    expect(res.status).toBe(200);
  });

  it("rejects a wrong shared-secret header", async () => {
    const res = await request(app).get("/api/tasks").set("x-draw-password", "nope");
    expect(res.status).toBe(401);
  });
});

describe("login rate limiting", () => {
  // Fresh app instances: the limiter is per-app state, and these tests
  // deliberately exhaust it (default: 5 failures / 15 min per IP).

  it("blocks the 6th attempt — even with the correct password", async () => {
    const app = createApp({ password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post("/api/auth/login").send({ password: `wrong-${i}` });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app).post("/api/auth/login").send({ password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("throttles the header channel with the same limiter", async () => {
    const app = createApp({ password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/api/tasks").set("x-draw-password", `wrong-${i}`);
      expect(res.status).toBe(401);
    }
    const blocked = await request(app).get("/api/tasks").set("x-draw-password", PASSWORD);
    expect(blocked.status).toBe(429);
  });

  it("does not count credential-less requests as attempts", async () => {
    const app = createApp({ password: PASSWORD });
    for (let i = 0; i < 10; i++) {
      expect((await request(app).get("/api/tasks")).status).toBe(401);
    }
    const login = await request(app).post("/api/auth/login").send({ password: PASSWORD });
    expect(login.status).toBe(204);
  });

  it("a successful login clears the failure count", async () => {
    const app = createApp({ password: PASSWORD });
    for (let i = 0; i < 4; i++) {
      await request(app).post("/api/auth/login").send({ password: "wrong" });
    }
    expect(
      (await request(app).post("/api/auth/login").send({ password: PASSWORD })).status,
    ).toBe(204);
    // The slate is clean: four more failures fit before the limit again.
    for (let i = 0; i < 4; i++) {
      const res = await request(app).post("/api/auth/login").send({ password: "wrong" });
      expect(res.status).toBe(401);
    }
  });
});

describe("InProcessApiClient against a protected app (assistant tools)", () => {
  // The assistant's READ tools self-request over a private loopback listener
  // (ADR-37) — the gate cannot tell that listener from a stranger's socket,
  // so createApp() hands the client its own secret (see app.ts). Without it,
  // enabling DRAW_PASSWORD would silently break the assistant.

  it("is locked out without the secret, passes with it", async () => {
    const { InProcessApiClient } = await import("../../src/tools/inProcessApi.js");
    const app = createApp({ password: PASSWORD });

    const bare = new InProcessApiClient(app);
    try {
      expect((await bare.request("GET", "/api/tasks")).status).toBe(401);
    } finally {
      bare.close();
    }

    const withSecret = new InProcessApiClient(app, PASSWORD);
    try {
      const res = await withSecret.request("GET", "/api/tasks");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    } finally {
      withSecret.close();
    }
  });
});

describe("HttpApiClient against a protected instance (MCP)", () => {
  let httpServer: Server;
  let base: string;

  beforeAll(async () => {
    const { startServer } = await import("../../src/server.js");
    httpServer = startServer(0, { password: PASSWORD });
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => httpServer?.close(resolve));
  });

  it("gets 401s without the shared secret", async () => {
    const { HttpApiClient } = await import("../../src/tools/httpApi.js");
    const res = await new HttpApiClient(base).request("GET", "/api/tasks");
    expect(res.status).toBe(401);
  });

  it("round-trips reads and writes with the shared secret from env", async () => {
    const { HttpApiClient } = await import("../../src/tools/httpApi.js");
    const client = new HttpApiClient(base, PASSWORD);

    const created = await client.request("POST", "/api/tasks", {
      title: "Protected card",
      categoryId: 1,
      effortMinutes: 10,
    });
    expect(created.status).toBe(201);

    const listed = await client.request("GET", "/api/tasks");
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ title: string }>).map((t) => t.title)).toContain(
      "Protected card",
    );
  });
});
