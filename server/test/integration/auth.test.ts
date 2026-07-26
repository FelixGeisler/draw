import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

// The optional LAN password gate (#190, ADR-50) over the real app: off means
// byte-for-byte the pre-#190 surface (regression guard), on means every /api
// route and static asset demands a session cookie or the shared-secret
// header — with /api/health and the login route as the only openings.

const PASSWORD = "correct horse battery staple";
const INDEX_MARKER = "draw-auth-index-marker";

let clientDir: string;
let createApp: (options?: {
  clientDir?: string;
  password?: string;
  trustProxy?: boolean | number | string;
}) => express.Express;

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

describe("login rate limiting (per de-proxied IP, ADR-50)", () => {
  // Under `trust proxy: "loopback"` — the recommended same-host reverse-proxy
  // setting — req.ip is the X-Forwarded-For client, so these simulate LAN
  // clients arriving through the proxy. Fresh app per test: the limiter is
  // per-app state, deliberately exhausted (default 5 failures / 15 min / IP).
  const LAN = "203.0.113.7";
  const OTHER = "198.51.100.9";
  const proxied = () => createApp({ password: PASSWORD, trustProxy: "loopback" });
  const login = (app: express.Express, from: string, password: string) =>
    request(app).post("/api/auth/login").set("X-Forwarded-For", from).send({ password });

  it("blocks the 6th failed login from an IP — even with the correct password", async () => {
    const app = proxied();
    for (let i = 0; i < 5; i++) expect((await login(app, LAN, `wrong-${i}`)).status).toBe(401);
    const blocked = await login(app, LAN, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("keys per IP — one attacker cannot lock another client out", async () => {
    const app = proxied();
    for (let i = 0; i < 5; i++) await login(app, LAN, "wrong");
    expect((await login(app, LAN, PASSWORD)).status).toBe(429);
    // A different de-proxied client has its own bucket, untouched.
    expect((await login(app, OTHER, PASSWORD)).status).toBe(204);
  });

  it("throttles the header channel with the same per-IP limiter", async () => {
    const app = proxied();
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get("/api/tasks")
        .set("X-Forwarded-For", LAN)
        .set("x-draw-password", `wrong-${i}`);
      expect(res.status).toBe(401);
    }
    const blocked = await request(app)
      .get("/api/tasks")
      .set("X-Forwarded-For", LAN)
      .set("x-draw-password", PASSWORD);
    expect(blocked.status).toBe(429);
  });

  it("does not count credential-less requests as attempts", async () => {
    const app = proxied();
    for (let i = 0; i < 10; i++) {
      expect((await request(app).get("/api/tasks").set("X-Forwarded-For", LAN)).status).toBe(401);
    }
    expect((await login(app, LAN, PASSWORD)).status).toBe(204);
  });

  it("does NOT count a present-but-invalid/expired cookie as an attempt (aging, not attacking)", async () => {
    // A lapsed-cookie browser must never lock the owner out: only the header
    // path records failures, the cookie path never does (the #190 review's
    // finding C). Ten bad-cookie hits, then the login still works.
    const app = proxied();
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .get("/api/tasks")
        .set("X-Forwarded-For", LAN)
        .set("Cookie", "draw_session=stale.deadbeef");
      expect(res.status).toBe(401);
    }
    expect((await login(app, LAN, PASSWORD)).status).toBe(204);
  });

  it("a successful login clears the failure count", async () => {
    const app = proxied();
    for (let i = 0; i < 4; i++) await login(app, LAN, "wrong");
    expect((await login(app, LAN, PASSWORD)).status).toBe(204);
    // The slate is clean: four more failures fit before the limit again.
    for (let i = 0; i < 4; i++) expect((await login(app, LAN, "wrong")).status).toBe(401);
  });

  it("exempts the loopback trusted-secret path: it never touches the limiter (finding B)", async () => {
    // The in-process assistant self-requests from loopback with the real
    // secret. It must not wipe an attacker's tally (recordSuccess) nor lock
    // itself out (check) — so on the loopback path the limiter is not
    // consulted at all. Injected limiter + trust proxy so this is precise.
    const { createAuth, LoginRateLimiter } = await import("../../src/auth.js");
    const limiter = new LoginRateLimiter();
    const check = vi.spyOn(limiter, "check");
    const recordSuccess = vi.spyOn(limiter, "recordSuccess");
    const recordFailure = vi.spyOn(limiter, "recordFailure");

    const { loginHandler, gate } = createAuth(PASSWORD, { limiter });
    const probe = express();
    probe.set("trust proxy", "loopback");
    probe.use(express.json());
    probe.post("/api/auth/login", loginHandler);
    probe.use(gate);
    probe.get("/api/tasks", (_req, res) => res.json([]));

    // Loopback header, real secret: unlocked, and the limiter is untouched.
    expect((await request(probe).get("/api/tasks").set("x-draw-password", PASSWORD)).status).toBe(
      200,
    );
    // Even a loopback WRONG secret must not record against the counter.
    expect((await request(probe).get("/api/tasks").set("x-draw-password", "nope")).status).toBe(401);
    expect(check).not.toHaveBeenCalled();
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(recordFailure).not.toHaveBeenCalled();

    // Contrast: a non-loopback (LAN) header failure DOES record.
    await request(probe).get("/api/tasks").set("X-Forwarded-For", LAN).set("x-draw-password", "nope");
    expect(recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe("the login FORM is throttled even from loopback (never exempt)", () => {
  it("blocks the 6th failed login POST from loopback — no trusted login-form user exists", async () => {
    // Unlike the header path, the login form has no loopback exemption: the
    // in-process/MCP clients never POST here, so exempting loopback would only
    // hand a same-host-proxy-with-TRUST_PROXY-unset misconfig unlimited
    // brute-force against the shared password. Under supertest req.ip is
    // loopback, and it MUST still throttle.
    const app = createApp({ password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post("/api/auth/login").send({ password: "wrong" })).status).toBe(
        401,
      );
    }
    const blocked = await request(app).post("/api/auth/login").send({ password: PASSWORD });
    expect(blocked.status).toBe(429);
  });

  it("ignores a spoofed X-Forwarded-For when trust proxy is off — no fresh bucket per header", async () => {
    // With trust proxy unset, req.ip is the socket peer regardless of XFF, so
    // rotating a spoofed XFF does not mint a new bucket — the shared loopback
    // bucket still trips.
    const app = createApp({ password: PASSWORD });
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", `203.0.113.${i}`)
        .send({ password: "wrong" });
    }
    const blocked = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.99")
      .send({ password: PASSWORD });
    expect(blocked.status).toBe(429);
  });
});

describe("constant-time password comparison is wired in (ADR-50)", () => {
  // timingSafeEqualStrings is unit-tested in isolation; this pins that the
  // login handler AND the header gate actually route through it — swapping
  // either call site to `===` would leave the spy uncalled and fail here
  // (the #190 review's finding D).
  it("both the login and header checks call the injected comparator", async () => {
    const { createAuth, timingSafeEqualStrings } = await import("../../src/auth.js");
    const compare = vi.fn(timingSafeEqualStrings);
    const { loginHandler, gate } = createAuth(PASSWORD, { compare });
    const probe = express();
    probe.use(express.json());
    probe.post("/api/auth/login", loginHandler);
    probe.use(gate);
    probe.get("/api/tasks", (_req, res) => res.json([]));

    await request(probe).post("/api/auth/login").send({ password: "attempt-login" });
    await request(probe).get("/api/tasks").set("x-draw-password", "attempt-header");

    const submitted = compare.mock.calls.map((call) => call[0]);
    expect(submitted).toContain("attempt-login");
    expect(submitted).toContain("attempt-header");
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
