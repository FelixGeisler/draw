import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import webPush from "web-push";
import { startProduction } from "../../src/prod.js";
import { createApp } from "../../src/app.js";
import { PushLifecycle } from "../../src/push/authority.js";
import { PushService } from "../../src/push/service.js";
import type { IsolatedResolver, ResolverFactory } from "../../src/push/resolver.js";
import { testDb } from "../helpers.js";
import { PUSH_TLS_CERT, PUSH_TLS_KEY } from "../support/push-tls-fixture.js";

const roots: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

const fakeResolver = (): IsolatedResolver => ({
  resolve4: async () => ["8.8.8.8"], resolve6: async () => { throw Object.assign(new Error("none"), { code: "ENODATA" }); }, cancel() {},
});
const keys = webPush.generateVAPIDKeys();
const body = JSON.stringify({
  subscription: {
    endpoint: "https://push.example/registration", expirationTime: null,
    keys: { p256dh: keys.publicKey, auth: crypto.randomBytes(16).toString("base64url") },
  },
});

function send(port: number, options: http.RequestOptions, chunks: string[] = []): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, ...options }, (response) => {
      const values: Buffer[] = [];
      response.on("data", (chunk) => values.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(values).toString("utf8");
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
    });
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for test condition");
}

class DelayedCancellationResolver implements IsolatedResolver {
  cancelled = false;
  operations: Array<{ reject: (reason: unknown) => void; settled: boolean }> = [];

  private resolve(): Promise<string[]> {
    return new Promise((_resolve, reject) => this.operations.push({ reject, settled: false }));
  }
  resolve4(): Promise<string[]> { return this.resolve(); }
  resolve6(): Promise<string[]> { return this.resolve(); }
  cancel(): void { this.cancelled = true; }
  settle(index: number): void {
    const operation = this.operations[index];
    if (!operation || operation.settled) return;
    operation.settled = true;
    operation.reject(Object.assign(new Error("cancelled"), { code: "ECANCELLED" }));
  }
  settleAll(): void { this.operations.forEach((_operation, index) => this.settle(index)); }
}

describe("real production Push assembly", () => {
  let database: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => {
    database = await testDb();
    database.prepare("DELETE FROM push_subscriptions").run();
  });

  function start(
    trustProxy: boolean | number | string = false,
    password?: string,
    resolverFactory: ResolverFactory = fakeResolver,
  ) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-push-prod-data-"));
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-push-prod-client-"));
    roots.push(dataDir, clientDir);
    fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>test</title>");
    const assembly = startProduction({
      database, dataDir, clientDir, host: "127.0.0.1", port: 0, trustProxy, password,
      resolverFactory, startSchedulers: false,
    });
    servers.push(assembly.server);
    return assembly;
  }

  it("reuses resolved host/ephemeral port and accepts bounded chunked identity JSON on the real listener", async () => {
    const assembly = start();
    await new Promise<void>((resolve) => assembly.server.listening ? resolve() : assembly.server.once("listening", resolve));
    const port = (assembly.server.address() as AddressInfo).port;
    expect(port).not.toBe(5173);
    expect(port).not.toBe(3001);
    expect(assembly.resolved).toMatchObject({ host: "127.0.0.1", port: 0, trustProxy: false });

    const status = await send(port, { method: "GET", path: "/api/push/status", headers: { Host: `localhost:${port}` } });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ available: true, mutationAllowed: true });

    const created = await send(port, {
      method: "POST", path: "/api/push/subscriptions",
      headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
    }, [body.slice(0, 17), body.slice(17)]);
    expect(created.status).toBe(201);

    const oversized = await send(port, {
      method: "PUT", path: "/api/push/preferences",
      headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "Content-Type": "application/json" },
    }, ["x".repeat(4_096), "x".repeat(4_097)]);
    expect(oversized).toMatchObject({ status: 413, body: { error: "push-body-too-large" } });

    const unknownPost = await send(port, {
      method: "POST", path: "/api/push/unknown", headers: { Host: `localhost:${port}` },
    }, ["x"]);
    expect(unknownPost).toMatchObject({ status: 400, body: { error: "invalid-push-request" } });
    const unknownPut = await send(port, {
      method: "PUT", path: "/api/push/unknown", headers: { Host: `localhost:${port}`, "Content-Length": "1" },
    }, ["x"]);
    expect(unknownPut).toMatchObject({ status: 400, body: { error: "invalid-push-request" } });
  });

  it("keeps chunked malformed bodies behind authentication on the real listener", async () => {
    const assembly = start(false, "owner-secret");
    await new Promise<void>((resolve) => assembly.server.listening ? resolve() : assembly.server.once("listening", resolve));
    const port = (assembly.server.address() as AddressInfo).port;
    const headers = {
      Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "Content-Type": "application/json",
    };
    const unauthenticated = await send(port, {
      method: "POST", path: "/api/push/subscriptions", headers,
    }, ["{", "bad"]);
    expect(unauthenticated).toMatchObject({ status: 401, body: { error: "authentication required" } });
    const authenticated = await send(port, {
      method: "POST", path: "/api/push/subscriptions", headers: { ...headers, "x-draw-password": "owner-secret" },
    }, ["{", "bad"]);
    expect(authenticated).toMatchObject({ status: 400, body: { error: "invalid-push-request" } });
  });

  it("accepts direct secure mutations through a real owned HTTPS listener", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "draw-push-https-data-"));
    roots.push(dataDir);
    const lifecycle = new PushLifecycle({
      dataDir,
      deleteSubscriptions: () => database.transaction(() => database.prepare("DELETE FROM push_subscriptions").run())(),
    });
    let secureServer: https.Server;
    const push = new PushService({
      database, lifecycle, resolverFactory: fakeResolver,
      topology: {
        listenerHost: "127.0.0.1", listenerPort: () => (secureServer.address() as AddressInfo).port,
        trustProxy: false,
      },
    });
    secureServer = https.createServer({ key: PUSH_TLS_KEY, cert: PUSH_TLS_CERT }, createApp({}, { push }));
    servers.push(secureServer);
    secureServer.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => secureServer.once("listening", resolve));
    const port = (secureServer.address() as AddressInfo).port;
    const response = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = https.request({
        host: "127.0.0.1", port, method: "PUT", path: "/api/push/preferences", rejectUnauthorized: false,
        headers: { Host: "draw.example", Origin: "https://draw.example", "Content-Type": "application/json" },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ hideDetails: true }));
    });
    expect(response).toEqual({ status: 200, body: { hideDetails: true } });
  });

  it("exercises source-pinned Tailscale and Nginx forwarded headers through the real listener", async () => {
    // Tailscale Serve: https://tailscale.com/kb/1242/tailscale-serve (For/Host/Proto).
    // Nginx proxy_set_header: https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header.
    const assembly = start(1);
    await new Promise<void>((resolve) => assembly.server.listening ? resolve() : assembly.server.once("listening", resolve));
    const port = (assembly.server.address() as AddressInfo).port;
    const directStatus = await send(port, { method: "GET", path: "/api/push/status", headers: { Host: `localhost:${port}` } });
    expect(directStatus.body).toMatchObject({ mutationAllowed: false, mutationReason: "secure-transport-required" });
    const directMutation = await send(port, {
      method: "PUT", path: "/api/push/preferences",
      headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "Content-Type": "application/json" },
    }, [JSON.stringify({ hideDetails: false })]);
    expect(directMutation).toMatchObject({ status: 403, body: { error: "push-mutation-forbidden" } });

    const baseHeaders = {
      Host: "draw.example", Origin: "https://draw.example", "Content-Type": "application/json",
      "X-Forwarded-For": "100.100.100.8", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "draw.example",
    };
    const tailscale = await send(port, { method: "PUT", path: "/api/push/preferences", headers: baseHeaders }, [JSON.stringify({ hideDetails: false })]);
    expect(tailscale.status).toBe(200);
    const nginx = await send(port, {
      method: "PUT", path: "/api/push/preferences", headers: { ...baseHeaders, "X-Real-IP": "192.0.2.10" },
    }, [JSON.stringify({ hideDetails: true })]);
    expect(nginx.status).toBe(200);
  });

  it("cancels completed-body disconnects and retains all four permits until both RR operations settle", async () => {
    const resolvers: DelayedCancellationResolver[] = [];
    const assembly = start(1, undefined, () => {
      const resolver = new DelayedCancellationResolver();
      resolvers.push(resolver);
      return resolver;
    });
    await new Promise<void>((resolve) => assembly.server.listening ? resolve() : assembly.server.once("listening", resolve));
    const port = (assembly.server.address() as AddressInfo).port;
    const headers = (client: number) => ({
      Host: "draw.example", Origin: "https://draw.example", "Content-Type": "application/json",
      "X-Forwarded-For": `198.51.100.${client}`, "X-Forwarded-Proto": "https",
    });
    const begin = (client: number) => {
      let resolveResponse!: (status: number) => void;
      const response = new Promise<number>((resolve) => { resolveResponse = resolve; });
      const request = http.request({
        host: "127.0.0.1", port, method: "POST", path: "/api/push/subscriptions", headers: headers(client),
      }, (incoming) => {
        incoming.resume();
        resolveResponse(incoming.statusCode ?? 0);
      });
      request.on("error", () => {});
      const finished = new Promise<void>((resolve) => request.once("finish", resolve));
      request.end(body);
      return { request, finished, response };
    };

    const held = [1, 2, 3, 4].map(begin);
    await Promise.all(held.map((entry) => entry.finished));
    await waitFor(() => resolvers.length === 4 && resolvers.every((resolver) => resolver.operations.length === 2));
    held.forEach((entry) => entry.request.destroy());
    await waitFor(() => resolvers.every((resolver) => resolver.cancelled));

    const busy = await send(port, {
      method: "POST", path: "/api/push/subscriptions", headers: headers(5),
    }, [body]);
    expect(busy).toMatchObject({ status: 503, body: { error: "push-busy" } });
    expect(resolvers).toHaveLength(4);

    resolvers[0].settle(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stillBusy = await send(port, {
      method: "POST", path: "/api/push/subscriptions", headers: headers(5),
    }, [body]);
    expect(stillBusy).toMatchObject({ status: 503, body: { error: "push-busy" } });

    resolvers[0].settle(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replacement = begin(5);
    const acquired = await Promise.race([
      waitFor(() => resolvers.length === 5).then(() => true),
      replacement.response.then(() => false),
    ]);
    expect(acquired).toBe(true);
    await replacement.finished;
    replacement.request.destroy();
    await waitFor(() => resolvers[4].cancelled);

    resolvers.slice(1).forEach((resolver) => resolver.settleAll());
    resolvers[4].settleAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
