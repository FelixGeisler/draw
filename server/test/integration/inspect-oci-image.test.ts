import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error JavaScript module has no declaration file.
import { runCli } from "../../../scripts/inspect-oci-image.mjs";
// @ts-expect-error Test fixture is a plain Node ESM module.
import { bytes, distributionError, INDEX_MEDIA_TYPE, makeInspectionFixture, MANIFEST_MEDIA_TYPE, REVISION } from "./inspect-oci-image-fixtures.mjs";

type Route = (request: IncomingMessage, response: ServerResponse) => void;

type ObservedRequest = {
  url: string;
  method: string;
  redirect: string;
  accept: string | null;
  acceptEncoding: string | null;
  authorization: string | null;
};

async function fakeServer(route: Route) {
  const server = createServer(route);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function send(response: ServerResponse, status: number, body: Uint8Array, headers: Record<string, string> = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(body);
}

function successfulRoute(fixture = makeInspectionFixture()): Route {
  return (request, response) => {
    const path = request.url?.split("?")[0] ?? "";
    const artifact = fixture.artifacts.get(path);
    if (!artifact) return send(response, 500, bytes({ error: "unexpected fixture path" }));
    send(response, 200, artifact.body, {
      "Content-Type": artifact.contentType,
      "Docker-Content-Digest": artifact.dockerDigest,
      "Content-Encoding": "identity",
      "Content-Length": String(artifact.body.length),
    });
  };
}

function runner(origin: string, options: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  observeRawAuthorization?: (url: string, value: string | null) => void;
} = {}) {
  let stdout = "";
  let stderr = "";
  const observed: ObservedRequest[] = [];
  const signals = new EventEmitter();
  const transport = async (request: Request) => {
    const authorization = request.headers.get("authorization");
    options.observeRawAuthorization?.(request.url, authorization);
    observed.push({
      url: request.url,
      method: request.method,
      redirect: request.redirect,
      accept: request.headers.get("accept"),
      acceptEncoding: request.headers.get("accept-encoding"),
      authorization: authorization === null ? null : "<redacted>",
    });
    const logical = new URL(request.url);
    return fetch(`${origin}${logical.pathname}${logical.search}`, {
      method: request.method,
      headers: request.headers,
      redirect: request.redirect,
      signal: request.signal,
    });
  };
  return {
    input: {
      argv: options.argv ?? ["--image", "ghcr.io/felixgeisler/draw:edge"],
      env: options.env ?? {},
      stdout: { write(value: string) { stdout += value; } },
      stderr: { write(value: string) { stderr += value; } },
      transport,
      signals,
    },
    signals,
    observed,
    output: () => ({ stdout, stderr }),
  };
}

afterEach(() => vi.useRealTimers());

async function runChild(scenario: string) {
  const child = fork(fileURLToPath(new URL("../support/inspect-oci-image-child.mjs", import.meta.url)), [scenario], {
    silent: true,
  });
  let stdout = "";
  let stderr = "";
  const messages: unknown[] = [];
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.on("message", (message) => {
    messages.push(message);
  });
  const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr, messages };
}

describe("bounded GHCR inspector integration", () => {
  it.each([false, true])("completes the canonical six-stage derive graph (reversed descriptors: %s)", async (reverseDescriptors) => {
    const fixture = makeInspectionFixture({ reverseDescriptors });
    const local = await fakeServer(successfulRoute(fixture));
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(0);
      expect(test.output()).toEqual({
        stdout: `${JSON.stringify({ digest: fixture.digest, revision: fixture.revision })}\n`,
        stderr: "",
      });
      expect(test.observed.map((item) => new URL(item.url).pathname)).toEqual([...fixture.artifacts.keys()]);
      expect(test.observed.map((item) => item.accept)).toEqual([
        INDEX_MEDIA_TYPE,
        INDEX_MEDIA_TYPE,
        MANIFEST_MEDIA_TYPE,
        "application/octet-stream",
        MANIFEST_MEDIA_TYPE,
        "application/octet-stream",
      ]);
      expect(test.observed.every((item) => item.method === "GET" && item.redirect === "error" && item.acceptEncoding === "identity")).toBe(true);
      expect(test.observed.every((item) => !item.accept?.includes("*") && !item.url.includes("/layers/"))).toBe(true);
      expect(test.observed.every((item) => item.authorization === null)).toBe(true);
    } finally {
      await local.close();
    }
  });

  it("supports expected mode and fails a syntactically valid revision mismatch as inspection", async () => {
    const fixture = makeInspectionFixture();
    const local = await fakeServer(successfulRoute(fixture));
    try {
      const good = runner(local.origin, { argv: ["--image", "ghcr.io/felixgeisler/draw:edge", "--expected-revision", REVISION] });
      await expect(runCli(good.input)).resolves.toBe(0);
      const bad = runner(local.origin, { argv: ["--image", "ghcr.io/felixgeisler/draw:edge", "--expected-revision", "f".repeat(40)] });
      await expect(runCli(bad.input)).resolves.toBe(1);
      expect(bad.observed).toHaveLength(1);
      expect(bad.output()).toEqual({ stdout: "", stderr: "inspection failed: request or image validation failed\n" });
    } finally {
      await local.close();
    }
  });

  it("performs one exact anonymous Bearer exchange and authenticated restart", async () => {
    const fixture = makeInspectionFixture();
    let challenged = false;
    const rawAuthorization: Array<[string, string | null]> = [];
    const local = await fakeServer((request, response) => {
      if (request.url?.startsWith("/token?")) {
        expect(request.url).toBe("/token?service=ghcr.io&scope=repository%3Afelixgeisler%2Fdraw%3Apull");
        expect(request.headers.authorization).toBeUndefined();
        return send(response, 200, bytes({ token: "opaque+/token==", ignored: true }), { "Content-Encoding": "identity" });
      }
      if (!challenged) {
        challenged = true;
        return send(response, 401, distributionError("UNAUTHORIZED"), {
          "WWW-Authenticate": "Bearer scope=\"repository:felixgeisler/draw:pull\", realm=\"https://ghcr.io/token\", service=\"ghcr.io\"",
        });
      }
      return successfulRoute(fixture)(request, response);
    });
    try {
      const test = runner(local.origin, { observeRawAuthorization: (url, value) => rawAuthorization.push([url, value]) });
      await expect(runCli(test.input)).resolves.toBe(0);
      expect(test.observed).toHaveLength(8);
      expect(test.observed.filter((item) => new URL(item.url).pathname === "/token")).toHaveLength(1);
      expect(rawAuthorization[0][1]).toBeNull();
      expect(rawAuthorization[1]).toEqual([expect.stringContaining("/token?"), null]);
      expect(rawAuthorization.slice(2).every(([, value]) => value === "Bearer opaque+/token==")).toBe(true);
      expect(JSON.stringify(test.observed)).not.toContain("opaque");
    } finally {
      await local.close();
    }
  });

  it("confines exact ASCII Basic credentials to the token request and permits a password colon", async () => {
    const fixture = makeInspectionFixture();
    let challenged = false;
    const raw: Array<[string, string | null]> = [];
    const local = await fakeServer((request, response) => {
      if (request.url?.startsWith("/token?")) return send(response, 200, bytes({ token: "token" }));
      if (!challenged) {
        challenged = true;
        return send(response, 401, distributionError("UNAUTHORIZED"), {
          "WWW-Authenticate": "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:felixgeisler/draw:pull\"",
        });
      }
      return successfulRoute(fixture)(request, response);
    });
    try {
      const test = runner(local.origin, {
        env: { OCI_REGISTRY_USERNAME: "user!", OCI_REGISTRY_PASSWORD: "pass:~" },
        observeRawAuthorization: (url, value) => raw.push([url, value]),
      });
      await expect(runCli(test.input)).resolves.toBe(0);
      const token = raw.find(([url]) => new URL(url).pathname === "/token");
      expect(token?.[1] === `Basic ${Buffer.from("user!:pass:~", "ascii").toString("base64")}`).toBe(true);
      expect(raw.filter(([, value]) => value?.startsWith("Basic "))).toHaveLength(1);
      expect(test.output().stdout).not.toContain("user!");
    } finally {
      await local.close();
    }
  });

  it.each([
    null,
    "Basic realm=\"https://ghcr.io/token\"",
    "Bearer realm=https://ghcr.io/token,service=\"ghcr.io\",scope=\"repository:felixgeisler/draw:pull\"",
    "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:felixgeisler/draw:pull\",extra=\"x\"",
    "Bearer realm=\"https://evil.example/token\",service=\"ghcr.io\",scope=\"repository:felixgeisler/draw:pull\"",
    "Bearer realm=\"https://ghcr.io/token\",realm=\"https://ghcr.io/token\",scope=\"repository:felixgeisler/draw:pull\"",
    "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:felixgeisler/draw:pull\", Bearer realm=\"https://ghcr.io/token\"",
  ])("rejects malformed or additional combined challenge material: %s", async (challenge) => {
    const local = await fakeServer((_request, response) => {
      const headers: Record<string, string> = challenge === null ? {} : { "WWW-Authenticate": challenge };
      send(response, 401, distributionError("UNAUTHORIZED"), headers);
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(1);
      expect(test.output().stdout).toBe("");
    } finally {
      await local.close();
    }
  });

  it.each(["", "bad token", "abc=def", "abc===x", "é", "abc\n"]) ("rejects invalid token before Bearer construction: %j", async (token) => {
    const local = await fakeServer((request, response) => {
      if (request.url?.startsWith("/token?")) return send(response, 200, bytes({ token }));
      send(response, 401, distributionError("UNAUTHORIZED"), {
        "WWW-Authenticate": "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:felixgeisler/draw:pull\"",
      });
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(2);
      expect(test.observed.every((item) => item.authorization === null)).toBe(true);
    } finally {
      await local.close();
    }
  });

  it("allows only a validated initial-name absence to return exit 3", async () => {
    const local = await fakeServer((_request, response) => send(response, 404, distributionError("MANIFEST_UNKNOWN", "not here", { ignored: true })));
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(3);
      expect(test.output()).toEqual({ stdout: "", stderr: "image not found\n" });
    } finally {
      await local.close();
    }
  });

  it.each([
    { status: 404, body: bytes({ errors: [] }), type: "application/json" },
    { status: 404, body: distributionError("UNAUTHORIZED"), type: "application/json" },
    { status: 404, body: bytes('{"errors":[],"errors":[]}'), type: "application/json" },
    { status: 404, body: distributionError("MANIFEST_UNKNOWN"), type: "text/plain" },
    { status: 403, body: bytes({ errors: [{ code: "DENIED", message: "no" }] }), type: "application/json" },
    { status: 500, body: bytes('{"a":1,"a":2}'), type: "application/json" },
  ])("fails closed on malformed absence and other HTTP errors: %j", async ({ status, body, type }) => {
    const local = await fakeServer((_request, response) => send(response, status, body, { "Content-Type": type }));
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.output().stdout).toBe("");
    } finally {
      await local.close();
    }
  });

  it.each(["gzip", "br", "deflate", "zstd", "identity; q=1", "identity, gzip", "IDENTITY"]) ("rejects non-exact response Content-Encoding %s", async (encoding) => {
    const fixture = makeInspectionFixture();
    const named = fixture.artifacts.values().next().value;
    const local = await fakeServer((_request, response) => send(response, 200, named.body, {
      "Content-Type": named.contentType,
      "Content-Encoding": encoding,
      "Docker-Content-Digest": named.dockerDigest,
    }));
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(1);
    } finally {
      await local.close();
    }
  });

  it("enforces the Fetch-exposed 1 MiB streaming cap without trusting Content-Length", async () => {
    let closedEarly = false;
    const local = await fakeServer((request, response) => {
      request.on("close", () => { closedEarly = true; });
      response.writeHead(200, {
        "Content-Type": INDEX_MEDIA_TYPE,
        "Docker-Content-Digest": `sha256:${"0".repeat(64)}`,
        "Content-Length": "1048577",
      });
      response.write(Buffer.alloc(1_048_576, 0x20));
      response.end(Buffer.from("x"));
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(1);
      expect(test.output().stdout).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closedEarly).toBe(true);
    } finally {
      await local.close();
    }
  });

  it("keeps the 1 MiB boundary bufferable before strict validation", async () => {
    const local = await fakeServer((_request, response) => send(response, 200, new Uint8Array(1_048_576), {
      "Content-Type": INDEX_MEDIA_TYPE,
      "Docker-Content-Digest": `sha256:${"0".repeat(64)}`,
    }));
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(1);
    } finally {
      await local.close();
    }
  });

  it("aborts one physical request after its 20-second streaming deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const transport = (request: Request) => new Promise<Response>((_resolve, reject) => {
      calls += 1;
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    let stderr = "";
    const promise = runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {},
      stdout: { write() {} }, stderr: { write(value: string) { stderr += value; } },
      transport, signals: new EventEmitter(),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toBe(1);
    expect(calls).toBe(1);
    expect(stderr).toMatch(/^inspection failed:/);
  });

  it("keeps one 90-second overall deadline across physical requests", async () => {
    vi.useFakeTimers();
    const fixture = makeInspectionFixture();
    let calls = 0;
    const transport = (request: Request) => new Promise<Response>((resolve, reject) => {
      calls += 1;
      const artifact = fixture.artifacts.get(new URL(request.url).pathname);
      if (!artifact) return reject(new Error("unexpected path"));
      const timer = setTimeout(() => resolve(new Response(artifact.body, {
        status: 200,
        headers: {
          "Content-Type": artifact.contentType,
          "Docker-Content-Digest": artifact.dockerDigest,
          "Content-Encoding": "identity",
        },
      })), 19_000);
      request.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    });
    let stderr = "";
    const promise = runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {},
      stdout: { write() {} }, stderr: { write(value: string) { stderr += value; } },
      transport, signals: new EventEmitter(),
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(promise).resolves.toBe(1);
    expect(calls).toBe(5);
    expect(stderr).toMatch(/^inspection failed:/);
  });

  it("preserves exact spawned-process success and no-network usage contracts", async () => {
    const success = await runChild("success");
    const fixture = makeInspectionFixture();
    expect(success).toMatchObject({
      code: 0,
      signal: null,
      stdout: `${JSON.stringify({ digest: fixture.digest, revision: fixture.revision })}\n`,
      stderr: "",
    });
    const usage = await runChild("usage-error");
    expect(usage.code).toBe(2);
    expect(usage.signal).toBeNull();
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toBe("invalid image reference\n");
    expect(usage.messages).not.toContain("transport-called");
  });

  it("uses real child-process signal handlers to abort streaming", async () => {
    const result = await runChild("signal-stream");
    expect(result).toMatchObject({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "inspection failed: request or image validation failed\n",
    });
  });

  it.each(["SIGINT", "SIGTERM"] as const)("aborts active streaming on %s", async (signal) => {
    const signals = new EventEmitter();
    let stderr = "";
    const transport = (request: Request) => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      queueMicrotask(() => signals.emit(signal));
    });
    const code = await runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {},
      stdout: { write() {} }, stderr: { write(value: string) { stderr += value; } }, transport, signals,
    });
    expect(code).toBe(1);
    expect(stderr).toBe("inspection failed: request or image validation failed\n");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
