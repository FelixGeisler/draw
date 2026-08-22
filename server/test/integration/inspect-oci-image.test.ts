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
  queryPresent: boolean;
  headerNames: string[];
};

const CONFIG_CDN_ORIGIN = "https://pkg-containers.githubusercontent.com";
const BEARER_CHALLENGE = "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:felixgeisler/draw:pull\"";

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

const TEST_CAPABILITY_QUERY = "?sig=opaque%2Fvalue%3D&part=one&part=two";

function redirectedConfigRoute(fixture = makeInspectionFixture(), observeCapability?: (exact: boolean) => void): Route {
  const direct = successfulRoute(fixture);
  const configArtifacts = [...fixture.artifacts.entries()].filter(([path]) => path.includes("/blobs/"));
  return (request, response) => {
    const logical = new URL(request.url ?? "/", "http://test.invalid");
    const cdnMatch = logical.pathname.match(/^\/ghcrblobs(?:04|17)\/blobs\/(sha256:[0-9a-f]{64})$/);
    if (cdnMatch) {
      observeCapability?.(logical.search === TEST_CAPABILITY_QUERY);
      const artifact = fixture.artifacts.get(`/v2/felixgeisler/draw/blobs/${cdnMatch[1]}`);
      if (!artifact) return send(response, 500, bytes({ error: "unexpected fixture path" }));
      return send(response, 200, artifact.body, {
        "Content-Type": artifact.contentType,
        "Docker-Content-Digest": artifact.dockerDigest,
        "Content-Encoding": "identity",
      });
    }
    const configIndex = configArtifacts.findIndex(([path]) => path === logical.pathname);
    if (configIndex >= 0) {
      const digest = logical.pathname.slice(logical.pathname.lastIndexOf("/") + 1);
      const cdnPath = `/ghcrblobs${configIndex === 0 ? "04" : "17"}/blobs/${digest}`;
      response.writeHead(307, {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "identity",
        Location: `${configIndex === 0 ? `${CONFIG_CDN_ORIGIN}:443` : CONFIG_CDN_ORIGIN}${cdnPath}${TEST_CAPABILITY_QUERY}`,
      });
      return response.end();
    }
    return direct(request, response);
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
    const logical = new URL(request.url);
    const retainedUrl = logical.origin === CONFIG_CDN_ORIGIN
      ? `${logical.origin}${logical.pathname}`
      : request.url;
    options.observeRawAuthorization?.(retainedUrl, authorization);
    observed.push({
      url: retainedUrl,
      method: request.method,
      redirect: request.redirect,
      accept: request.headers.get("accept"),
      acceptEncoding: request.headers.get("accept-encoding"),
      authorization: authorization === null ? null : "<redacted>",
      queryPresent: logical.search.length > 1,
      headerNames: [...request.headers.keys()].sort(),
    });
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
      expect(test.observed.map((item) => item.redirect)).toEqual([
        "error", "error", "error", "manual", "error", "manual",
      ]);
      expect(test.observed.every((item) => item.method === "GET" && item.acceptEncoding === "identity")).toBe(true);
      expect(test.observed.every((item) => !item.accept?.includes("*") && !item.url.includes("/layers/"))).toBe(true);
      expect(test.observed.every((item) => item.authorization === null)).toBe(true);
    } finally {
      await local.close();
    }
  });

  it.each([
    { mode: "derive", challenged: false, requests: 8 },
    { mode: "expected", challenged: true, requests: 10 },
  ])("follows constrained config redirects through shards 04 and 17 in $mode mode (challenged: $challenged)", async ({ mode, challenged, requests }) => {
    const fixture = makeInspectionFixture();
    let challengeSent = false;
    const capabilityChecks: boolean[] = [];
    const rawAuthorization: Array<[string, string | null]> = [];
    const redirectRoute = redirectedConfigRoute(fixture, (exact) => capabilityChecks.push(exact));
    const local = await fakeServer((request, response) => {
      if (request.url?.startsWith("/token?")) return send(response, 200, bytes({ token: "opaque-token" }));
      if (challenged && !challengeSent) {
        challengeSent = true;
        return send(response, 401, distributionError("UNAUTHORIZED"), { "WWW-Authenticate": BEARER_CHALLENGE });
      }
      return redirectRoute(request, response);
    });
    try {
      const argv = mode === "expected"
        ? ["--image", "ghcr.io/felixgeisler/draw:edge", "--expected-revision", REVISION]
        : undefined;
      const test = runner(local.origin, {
        argv,
        observeRawAuthorization: (url, value) => rawAuthorization.push([url, value]),
      });
      await expect(runCli(test.input)).resolves.toBe(0);
      expect(test.output()).toEqual({
        stdout: `${JSON.stringify({ digest: fixture.digest, revision: fixture.revision })}\n`,
        stderr: "",
      });
      expect(test.observed).toHaveLength(requests);
      expect(capabilityChecks).toEqual([true, true]);
      const fixturePaths = [...fixture.artifacts.keys()];
      const successOrder = [
        fixturePaths[0], fixturePaths[1], fixturePaths[2], fixturePaths[3],
        `/ghcrblobs04/blobs/${fixturePaths[3].slice(fixturePaths[3].lastIndexOf("/") + 1)}`,
        fixturePaths[4], fixturePaths[5],
        `/ghcrblobs17/blobs/${fixturePaths[5].slice(fixturePaths[5].lastIndexOf("/") + 1)}`,
      ];
      expect(test.observed.map((item) => new URL(item.url).pathname)).toEqual(challenged
        ? [fixturePaths[0], "/token", ...successOrder]
        : successOrder);

      const cdnRequests = test.observed.filter((item) => new URL(item.url).origin === CONFIG_CDN_ORIGIN);
      expect(cdnRequests).toHaveLength(2);
      expect(cdnRequests).toEqual(cdnRequests.map((item) => ({
        ...item,
        method: "GET",
        redirect: "error",
        accept: "application/octet-stream",
        acceptEncoding: "identity",
        authorization: null,
        queryPresent: true,
        headerNames: ["accept", "accept-encoding"],
      })));
      expect(cdnRequests.every((item) => !item.url.includes("?"))).toBe(true);
      expect(JSON.stringify(test.observed)).not.toContain("opaque%2Fvalue");

      const registryConfigs = test.observed.filter((item) =>
        new URL(item.url).origin === "https://ghcr.io" && new URL(item.url).pathname.includes("/blobs/"));
      expect(registryConfigs).toHaveLength(2);
      expect(registryConfigs.every((item) => item.redirect === "manual" && item.queryPresent === false)).toBe(true);
      expect(test.observed.filter((item) => new URL(item.url).origin === "https://ghcr.io" &&
        !new URL(item.url).pathname.includes("/blobs/"))).toHaveLength(challenged ? 6 : 4);
      expect(rawAuthorization.filter(([url]) => new URL(url).origin === CONFIG_CDN_ORIGIN)
        .every(([, value]) => value === null)).toBe(true);
      expect(test.observed.filter((item) => new URL(item.url).pathname !== "/token" &&
        new URL(item.url).origin !== CONFIG_CDN_ORIGIN)).toHaveLength(challenged ? 7 : 6);
    } finally {
      await local.close();
    }
  });

  it("accepts an opaque parseable query with encoded data, duplicate-looking parameters, and a decoded space", async () => {
    const fixture = makeInspectionFixture();
    const configPath = [...fixture.artifacts.keys()].find((path) => path.includes("/blobs/"));
    if (!configPath) throw new Error("fixture has no config path");
    const digest = configPath.slice(configPath.lastIndexOf("/") + 1);
    const cdnPath = `/ghcrblobs7/blobs/${digest}`;
    const capabilityMarker = "never-retain-opaque-capability";
    const rawQuery = `?sig=opaque%2Fvalue%3D&part=one&part=two&label=decoded space&secret=${capabilityMarker}`;
    const serializedQuery = rawQuery.replace("decoded space", "decoded%20space");
    const serializationChecks: boolean[] = [];
    let redirected = false;
    const local = await fakeServer((request, response) => {
      const logical = new URL(request.url ?? "/", "http://test.invalid");
      if (logical.pathname === cdnPath) {
        serializationChecks.push(logical.search === serializedQuery);
        const artifact = fixture.artifacts.get(configPath);
        if (!artifact) return send(response, 500, bytes({ error: "unexpected fixture path" }));
        return send(response, 200, artifact.body, {
          "Content-Type": artifact.contentType,
          "Docker-Content-Digest": artifact.dockerDigest,
          "Content-Encoding": "identity",
        });
      }
      if (!redirected && logical.pathname === configPath) {
        redirected = true;
        response.writeHead(307, {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "identity",
          Location: `${CONFIG_CDN_ORIGIN}${cdnPath}${rawQuery}`,
        });
        return response.end();
      }
      return successfulRoute(fixture)(request, response);
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(0);
      expect(serializationChecks).toEqual([true]);
      expect(test.output()).toEqual({
        stdout: `${JSON.stringify({ digest: fixture.digest, revision: fixture.revision })}\n`,
        stderr: "",
      });
      const cdnRequests = test.observed.filter((item) => new URL(item.url).origin === CONFIG_CDN_ORIGIN);
      expect(cdnRequests).toHaveLength(1);
      expect(cdnRequests[0]).toMatchObject({
        url: `${CONFIG_CDN_ORIGIN}${cdnPath}`,
        redirect: "error",
        authorization: null,
        queryPresent: true,
      });
      const retainedEvidence = JSON.stringify({ observed: test.observed, output: test.output() });
      const capabilityLeaked = [capabilityMarker, "opaque%2Fvalue", "decoded%20space"]
        .some((value) => retainedEvidence.includes(value));
      expect(capabilityLeaked).toBe(false);
    } finally {
      await local.close();
    }
  });

  it.each([
    { label: "302 status", status: 302, location: "valid" },
    { label: "HTTP scheme", status: 307, location: "http" },
    { label: "wrong origin", status: 307, location: "origin" },
    { label: "non-default port", status: 307, location: "port" },
    { label: "wrong path", status: 307, location: "path" },
    { label: "path-normalization material", status: 307, location: "normalized-path" },
    { label: "wrong digest", status: 307, location: "digest" },
    { label: "zero ghcrblobs number", status: 307, location: "zero" },
    { label: "zero-only padded ghcrblobs number", status: 307, location: "zero-padded" },
    { label: "signed ghcrblobs number", status: 307, location: "signed" },
    { label: "non-digit ghcrblobs number", status: 307, location: "non-digit" },
    { label: "decimal ghcrblobs number", status: 307, location: "decimal" },
    { label: "missing ghcrblobs number", status: 307, location: "missing-number" },
    { label: "extra path", status: 307, location: "extra" },
    { label: "credentials", status: 307, location: "credentials" },
    { label: "fragment", status: 307, location: "fragment" },
    { label: "empty query", status: 307, location: "empty-query" },
    { label: "missing Location", status: 307, location: "missing" },
    { label: "combined Location values", status: 307, location: "combined" },
  ])("rejects a config redirect with $label before CDN dispatch", async ({ status, location }) => {
    const fixture = makeInspectionFixture();
    const configPath = [...fixture.artifacts.keys()].find((path) => path.includes("/blobs/"));
    if (!configPath) throw new Error("fixture has no config path");
    const digest = configPath.slice(configPath.lastIndexOf("/") + 1);
    const good = `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/${digest}?sig=test`;
    const locations: Record<string, string | undefined> = {
      valid: good,
      http: good.replace("https:", "http:"),
      origin: good.replace("pkg-containers.githubusercontent.com", "example.invalid"),
      port: good.replace(".com/", ".com:444/"),
      path: `${CONFIG_CDN_ORIGIN}/other/blobs/${digest}?sig=test`,
      "normalized-path": `${CONFIG_CDN_ORIGIN}/ignored/../ghcrblobs1/blobs/${digest}?sig=test`,
      digest: `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/sha256:${"f".repeat(64)}?sig=test`,
      zero: `${CONFIG_CDN_ORIGIN}/ghcrblobs0/blobs/${digest}?sig=test`,
      "zero-padded": `${CONFIG_CDN_ORIGIN}/ghcrblobs00/blobs/${digest}?sig=test`,
      signed: `${CONFIG_CDN_ORIGIN}/ghcrblobs+1/blobs/${digest}?sig=test`,
      "non-digit": `${CONFIG_CDN_ORIGIN}/ghcrblobsabc/blobs/${digest}?sig=test`,
      decimal: `${CONFIG_CDN_ORIGIN}/ghcrblobs1.0/blobs/${digest}?sig=test`,
      "missing-number": `${CONFIG_CDN_ORIGIN}/ghcrblobs/blobs/${digest}?sig=test`,
      extra: `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/${digest}/extra?sig=test`,
      credentials: good.replace("https://", "https://user:password@"),
      fragment: `${good}#fragment`,
      "empty-query": good.slice(0, good.indexOf("?")) + "?",
      missing: undefined,
      combined: `${good.slice(0, good.indexOf("?"))}, ${good}`,
    };
    const local = await fakeServer((request, response) => {
      const path = request.url?.split("?")[0] ?? "";
      if (path !== configPath) return successfulRoute(fixture)(request, response);
      const headers: Record<string, string> = { "Content-Encoding": "identity" };
      const value = locations[location];
      if (value !== undefined) headers.Location = value;
      return send(response, status, new Uint8Array(), headers);
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(4);
      expect(test.observed.at(-1)?.redirect).toBe("manual");
      expect(test.observed.some((item) => new URL(item.url).origin === CONFIG_CDN_ORIGIN)).toBe(false);
      expect(test.output()).toEqual({ stdout: "", stderr: "inspection failed: request or image validation failed\n" });
    } finally {
      await local.close();
    }
  });

  it.each(["named index", "digest index", "manifest", "token"]) (
    "keeps redirect:error and rejects a redirect for $target",
    async (target) => {
      const fixture = makeInspectionFixture();
      const paths = [...fixture.artifacts.keys()];
      let registryCalls = 0;
      const local = await fakeServer((request, response) => {
        if (request.url?.startsWith("/token?")) {
          if (target === "token") return send(response, 307, new Uint8Array(), {
            Location: `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/sha256:${"a".repeat(64)}?sig=test`,
          });
          return send(response, 200, bytes({ token: "token" }));
        }
        registryCalls += 1;
        if (target === "token" && registryCalls === 1) {
          return send(response, 401, distributionError("UNAUTHORIZED"), { "WWW-Authenticate": BEARER_CHALLENGE });
        }
        const targetPath = target === "named index" ? paths[0] : target === "digest index" ? paths[1] : paths[2];
        if (request.url?.split("?")[0] === targetPath) {
          return send(response, 307, new Uint8Array(), {
            Location: `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/sha256:${"a".repeat(64)}?sig=test`,
          });
        }
        return successfulRoute(fixture)(request, response);
      });
      try {
        const test = runner(local.origin);
        await expect(runCli(test.input)).resolves.toBe(1);
        expect(test.observed.at(-1)?.redirect).toBe("error");
        expect(test.observed.some((item) => new URL(item.url).origin === CONFIG_CDN_ORIGIN)).toBe(false);
      } finally {
        await local.close();
      }
    },
  );

  it.each([
    { encoding: undefined, contentLength: undefined },
    { encoding: "identity", contentLength: "999" },
  ])("accepts an exactly empty 307 body with encoding $encoding and Content-Length $contentLength", async ({ encoding, contentLength }) => {
    const fixture = makeInspectionFixture();
    const configPath = [...fixture.artifacts.keys()].find((path) => path.includes("/blobs/"));
    if (!configPath) throw new Error("fixture has no config path");
    const digest = configPath.slice(configPath.lastIndexOf("/") + 1);
    const location = `${CONFIG_CDN_ORIGIN}/ghcrblobs9/blobs/${digest}${TEST_CAPABILITY_QUERY}`;
    let redirected = false;
    let calls = 0;
    const transport = async (request: Request) => {
      calls += 1;
      const logical = new URL(request.url);
      const artifactPath = logical.origin === CONFIG_CDN_ORIGIN
        ? `/v2/felixgeisler/draw/blobs/${logical.pathname.slice(logical.pathname.lastIndexOf("/") + 1)}`
        : logical.pathname;
      const artifact = fixture.artifacts.get(artifactPath);
      if (!artifact) throw new Error("unexpected path");
      if (!redirected && logical.pathname === configPath) {
        redirected = true;
        const headers = new Headers({ Location: location });
        if (encoding !== undefined) headers.set("Content-Encoding", encoding);
        if (contentLength !== undefined) headers.set("Content-Length", contentLength);
        return new Response(new Uint8Array(), { status: 307, headers });
      }
      return new Response(artifact.body, { status: 200, headers: {
        "Content-Type": artifact.contentType,
        "Docker-Content-Digest": artifact.dockerDigest,
        "Content-Encoding": "identity",
      } });
    };
    let stdout = "";
    let stderr = "";
    const code = await runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {},
      stdout: { write(value: string) { stdout += value; } },
      stderr: { write(value: string) { stderr += value; } },
      transport, signals: new EventEmitter(),
    });
    expect(code).toBe(0);
    expect(calls).toBe(7);
    expect({ stdout, stderr }).toEqual({
      stdout: `${JSON.stringify({ digest: fixture.digest, revision: fixture.revision })}\n`, stderr: "",
    });
  });

  it.each([
    { label: "first nonempty byte", size: 1, contentLength: "0" },
    { label: "oversize stream", size: 1_048_577, contentLength: undefined },
  ])("rejects and cancels a 307 $label before following", async ({ size, contentLength }) => {
    const fixture = makeInspectionFixture();
    const configPath = [...fixture.artifacts.keys()].find((path) => path.includes("/blobs/"));
    if (!configPath) throw new Error("fixture has no config path");
    const digest = configPath.slice(configPath.lastIndexOf("/") + 1);
    let calls = 0;
    let cancellations = 0;
    let requestAborted = false;
    const transport = async (request: Request) => {
      calls += 1;
      const path = new URL(request.url).pathname;
      const artifact = fixture.artifacts.get(path);
      if (!artifact) throw new Error("unexpected path");
      if (path !== configPath) return new Response(artifact.body, { status: 200, headers: {
        "Content-Type": artifact.contentType, "Docker-Content-Digest": artifact.dockerDigest,
      } });
      request.signal.addEventListener("abort", () => { requestAborted = true; }, { once: true });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (size === 1) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          } else {
            controller.enqueue(new Uint8Array(1_048_576));
            controller.enqueue(new Uint8Array([1]));
          }
        },
        cancel() { cancellations += 1; },
      });
      const headers = new Headers({
        Location: `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/${digest}?sig=test`,
      });
      if (contentLength !== undefined) headers.set("Content-Length", contentLength);
      return new Response(body, { status: 307, headers });
    };
    let stderr = "";
    const code = await runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {}, stdout: { write() {} },
      stderr: { write(value: string) { stderr += value; } }, transport, signals: new EventEmitter(),
    });
    expect(code).toBe(1);
    expect(calls).toBe(4);
    expect(cancellations).toBe(size > 1_048_576 ? 1 : 0);
    expect(requestAborted).toBe(size > 1_048_576);
    expect(stderr).toBe("inspection failed: request or image validation failed\n");
  });

  it("applies the 20-second fetch-and-stream deadline to a stalled 307 body", async () => {
    vi.useFakeTimers();
    const fixture = makeInspectionFixture();
    const configPath = [...fixture.artifacts.keys()].find((path) => path.includes("/blobs/"));
    if (!configPath) throw new Error("fixture has no config path");
    const digest = configPath.slice(configPath.lastIndexOf("/") + 1);
    let calls = 0;
    let cancellations = 0;
    let aborted = false;
    const transport = async (request: Request) => {
      calls += 1;
      const path = new URL(request.url).pathname;
      const artifact = fixture.artifacts.get(path);
      if (!artifact) throw new Error("unexpected path");
      if (path !== configPath) return new Response(artifact.body, { status: 200, headers: {
        "Content-Type": artifact.contentType, "Docker-Content-Digest": artifact.dockerDigest,
      } });
      request.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Response(new ReadableStream<Uint8Array>({
        pull() { /* the redirect headers arrive, but its body never completes */ },
        cancel() { cancellations += 1; },
      }), { status: 307, headers: {
        Location: `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/${digest}?sig=test`,
      } });
    };
    let stderr = "";
    const promise = runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {}, stdout: { write() {} },
      stderr: { write(value: string) { stderr += value; } }, transport, signals: new EventEmitter(),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toBe(1);
    expect({ calls, cancellations, aborted }).toEqual({ calls: 4, cancellations: 1, aborted: true });
    expect(stderr).toBe("inspection failed: request or image validation failed\n");
  });

  it.each(["status", "encoding", "content-type", "wrong-size", "digest", "further-redirect"]) (
    "rejects a CDN follow with $fault and starts no later graph request",
    async (fault) => {
      const fixture = makeInspectionFixture();
      const configPath = [...fixture.artifacts.keys()].find((path) => path.includes("/blobs/"));
      if (!configPath) throw new Error("fixture has no config path");
      const configArtifact = fixture.artifacts.get(configPath);
      if (!configArtifact) throw new Error("fixture config is missing");
      const digest = configPath.slice(configPath.lastIndexOf("/") + 1);
      const location = `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/${digest}?sig=never-retain-this`;
      let calls = 0;
      const transport = async (request: Request) => {
        calls += 1;
        const logical = new URL(request.url);
        if (logical.origin === CONFIG_CDN_ORIGIN) {
          if (fault === "status") return new Response(new Uint8Array(), { status: 503 });
          if (fault === "further-redirect") return new Response(new Uint8Array(), {
            status: 307, headers: { Location: "https://example.invalid/blocked" },
          });
          let body = configArtifact.body;
          if (fault === "wrong-size") body = new Uint8Array([...body, 0]);
          if (fault === "digest") {
            body = body.slice();
            body[0] ^= 1;
          }
          return new Response(body, { status: 200, headers: {
            "Content-Type": fault === "content-type" ? "application/json" : configArtifact.contentType,
            "Docker-Content-Digest": configArtifact.dockerDigest,
            ...(fault === "encoding" ? { "Content-Encoding": "gzip" } : {}),
          } });
        }
        const artifact = fixture.artifacts.get(logical.pathname);
        if (!artifact) throw new Error("unexpected path");
        if (logical.pathname === configPath) return new Response(new Uint8Array(), {
          status: 307, headers: { Location: location },
        });
        return new Response(artifact.body, { status: 200, headers: {
          "Content-Type": artifact.contentType, "Docker-Content-Digest": artifact.dockerDigest,
        } });
      };
      let stderr = "";
      const code = await runCli({
        argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {}, stdout: { write() {} },
        stderr: { write(value: string) { stderr += value; } }, transport, signals: new EventEmitter(),
      });
      expect(code).toBe(1);
      expect(calls).toBe(5);
      expect(stderr).toBe("inspection failed: request or image validation failed\n");
      expect(stderr).not.toContain("never-retain-this");
    },
  );

  it("cancels an oversized CDN response without retrying", async () => {
    const fixture = makeInspectionFixture();
    const configPath = [...fixture.artifacts.keys()].find((path) => path.includes("/blobs/"));
    if (!configPath) throw new Error("fixture has no config path");
    const digest = configPath.slice(configPath.lastIndexOf("/") + 1);
    let calls = 0;
    let cancellations = 0;
    let aborted = false;
    const transport = async (request: Request) => {
      calls += 1;
      const logical = new URL(request.url);
      if (logical.origin === CONFIG_CDN_ORIGIN) {
        request.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1_048_576));
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() { cancellations += 1; },
        }), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
      }
      const artifact = fixture.artifacts.get(logical.pathname);
      if (!artifact) throw new Error("unexpected path");
      if (logical.pathname === configPath) return new Response(new Uint8Array(), { status: 307, headers: {
        Location: `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/${digest}?sig=test`,
      } });
      return new Response(artifact.body, { status: 200, headers: {
        "Content-Type": artifact.contentType, "Docker-Content-Digest": artifact.dockerDigest,
      } });
    };
    const code = await runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {}, stdout: { write() {} }, stderr: { write() {} },
      transport, signals: new EventEmitter(),
    });
    expect(code).toBe(1);
    expect({ calls, cancellations, aborted }).toEqual({ calls: 5, cancellations: 1, aborted: true });
  });

  it("gives the 307 and CDN follow separate 20-second windows inside one overall deadline", async () => {
    vi.useFakeTimers();
    const fixture = makeInspectionFixture();
    const configPath = [...fixture.artifacts.keys()].find((path) => path.includes("/blobs/"));
    if (!configPath) throw new Error("fixture has no config path");
    const digest = configPath.slice(configPath.lastIndexOf("/") + 1);
    let redirected = false;
    let calls = 0;
    const transport = (request: Request): Promise<Response> => {
      calls += 1;
      const logical = new URL(request.url);
      const artifactPath = logical.origin === CONFIG_CDN_ORIGIN
        ? `/v2/felixgeisler/draw/blobs/${digest}` : logical.pathname;
      const artifact = fixture.artifacts.get(artifactPath);
      if (!artifact) return Promise.reject(new Error("unexpected path"));
      const isRedirect = !redirected && logical.pathname === configPath;
      if (isRedirect) redirected = true;
      const response = isRedirect
        ? new Response(new Uint8Array(), { status: 307, headers: {
          Location: `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/${digest}?sig=test`,
        } })
        : new Response(artifact.body, { status: 200, headers: {
          "Content-Type": artifact.contentType, "Docker-Content-Digest": artifact.dockerDigest,
        } });
      if (!isRedirect && logical.origin !== CONFIG_CDN_ORIGIN) return Promise.resolve(response);
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(response), 19_000);
        request.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
    };
    let stderr = "";
    const promise = runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {}, stdout: { write() {} },
      stderr: { write(value: string) { stderr += value; } }, transport, signals: new EventEmitter(),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(19_000);
    await vi.advanceTimersByTimeAsync(19_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toBe(0);
    expect(calls).toBe(7);
    expect(stderr).toBe("");
  });

  it("sanitizes a transport failure that carries the opaque CDN capability", async () => {
    const fixture = makeInspectionFixture();
    const configPath = [...fixture.artifacts.keys()].find((path) => path.includes("/blobs/"));
    if (!configPath) throw new Error("fixture has no config path");
    const digest = configPath.slice(configPath.lastIndexOf("/") + 1);
    let calls = 0;
    const transport = async (request: Request) => {
      calls += 1;
      const logical = new URL(request.url);
      if (logical.origin === CONFIG_CDN_ORIGIN) throw new Error(request.url);
      const artifact = fixture.artifacts.get(logical.pathname);
      if (!artifact) throw new Error("unexpected path");
      if (logical.pathname === configPath) return new Response(new Uint8Array(), { status: 307, headers: {
        Location: `${CONFIG_CDN_ORIGIN}/ghcrblobs1/blobs/${digest}?signed=opaque-secret`,
      } });
      return new Response(artifact.body, { status: 200, headers: {
        "Content-Type": artifact.contentType, "Docker-Content-Digest": artifact.dockerDigest,
      } });
    };
    let stdout = "";
    let stderr = "";
    const code = await runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {},
      stdout: { write(value: string) { stdout += value; } }, stderr: { write(value: string) { stderr += value; } },
      transport, signals: new EventEmitter(),
    });
    expect(code).toBe(1);
    expect(calls).toBe(5);
    expect({ stdout, stderr }).toEqual({ stdout: "", stderr: "inspection failed: request or image validation failed\n" });
    expect(`${stdout}${stderr}`).not.toContain("opaque-secret");
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

  it.each([
    "application/json;charset=utf-8",
    "Application/JSON \t;\t CHARSET=UTF-8",
  ])("accepts valid case-insensitive JSON content type %j", async (contentType) => {
    const local = await fakeServer((_request, response) => send(response, 404, distributionError("MANIFEST_UNKNOWN"), {
      "Content-Type": contentType,
    }));
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(3);
      expect(test.observed).toHaveLength(1);
    } finally {
      await local.close();
    }
  });

  it.each([
    { responseKind: "401", contentType: "application/json; charset = utf-8", requests: 1 },
    { responseKind: "401", contentType: "application/json; charset= utf-8", requests: 1 },
    { responseKind: "401", contentType: "application/json; charset =utf-8", requests: 1 },
    { responseKind: "404", contentType: "application/json; charset = utf-8", requests: 1 },
    { responseKind: "404", contentType: "application/json; charset= utf-8", requests: 1 },
    { responseKind: "404", contentType: "application/json; charset =utf-8", requests: 1 },
    { responseKind: "token", contentType: "application/json; charset = utf-8", requests: 2 },
    { responseKind: "token", contentType: "application/json; charset= utf-8", requests: 2 },
    { responseKind: "token", contentType: "application/json; charset =utf-8", requests: 2 },
  ])("rejects whitespace around JSON parameter equals for $responseKind: $contentType", async ({ responseKind, contentType, requests }) => {
    const local = await fakeServer((request, response) => {
      if (responseKind === "token" && request.url?.startsWith("/token?")) {
        return send(response, 200, bytes({ token: "token" }), { "Content-Type": contentType });
      }
      if (responseKind === "401" || responseKind === "token") {
        return send(response, 401, distributionError("UNAUTHORIZED"), {
          "Content-Type": responseKind === "401" ? contentType : "application/json",
          "WWW-Authenticate": BEARER_CHALLENGE,
        });
      }
      return send(response, 404, distributionError("MANIFEST_UNKNOWN"), { "Content-Type": contentType });
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(requests);
      expect(test.output().stdout).toBe("");
    } finally {
      await local.close();
    }
  });

  it.each([
    "application/json; charset",
    "application/json; charset==utf-8",
    "application/json; charset=\"utf-8\"",
    "application/json; charset=utf-8; charset=utf-8",
    "application/json; charset=utf-8; profile=x",
    "application/json, text/plain",
    "application/json; =utf-8",
  ])("rejects malformed or additional JSON content-type parameter form %j", async (contentType) => {
    const local = await fakeServer((_request, response) => send(response, 404, distributionError("MANIFEST_UNKNOWN"), {
      "Content-Type": contentType,
    }));
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(1);
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

  it.each(["x", "😀".repeat(512)])("accepts a Distribution message at the scalar boundary", async (message) => {
    const body = bytes({
      errors: [
        { code: "MANIFEST_UNKNOWN", message, detail: { arbitrary: [true, null, 7] } },
        { code: "MANIFEST_UNKNOWN", message: "same code" },
      ],
    });
    const local = await fakeServer((_request, response) => send(response, 404, body));
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(3);
      expect(test.output()).toEqual({ stdout: "", stderr: "image not found\n" });
    } finally {
      await local.close();
    }
  });

  it.each([401, 404].flatMap((status) => [
    { status, malformed: "empty-message" },
    { status, malformed: "513-scalars" },
    { status, malformed: "unpaired-surrogate" },
    { status, malformed: "missing-key" },
    { status, malformed: "extra-key" },
    { status, malformed: "mixed-code" },
    { status, malformed: "duplicate-detail-key" },
  ]))("rejects $status Distribution error with $malformed and stops", async ({ status, malformed }) => {
    const code = status === 401 ? "UNAUTHORIZED" : "MANIFEST_UNKNOWN";
    const otherCode = status === 401 ? "MANIFEST_UNKNOWN" : "UNAUTHORIZED";
    let body: Uint8Array;
    if (malformed === "empty-message") body = distributionError(code, "");
    else if (malformed === "513-scalars") body = distributionError(code, "x".repeat(513));
    else if (malformed === "unpaired-surrogate") body = bytes(`{"errors":[{"code":"${code}","message":"\\ud800"}]}`);
    else if (malformed === "missing-key") body = bytes({ errors: [{ code }] });
    else if (malformed === "extra-key") body = bytes({ errors: [{ code, message: "secret response", extra: true }] });
    else if (malformed === "mixed-code") body = bytes({ errors: [{ code, message: "one" }, { code: otherCode, message: "two" }] });
    else body = bytes(`{"errors":[{"code":"${code}","message":"one","detail":{"a":1,"a":2}}]}`);
    const local = await fakeServer((_request, response) => send(response, status, body, {
      ...(status === 401 ? { "WWW-Authenticate": BEARER_CHALLENGE } : {}),
    }));
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(1);
      expect(test.output()).toEqual({ stdout: "", stderr: "inspection failed: request or image validation failed\n" });
      expect(test.output().stderr).not.toContain("secret response");
    } finally {
      await local.close();
    }
  });

  it("returns absence for a valid post-auth named restart 404", async () => {
    let calls = 0;
    const local = await fakeServer((request, response) => {
      calls += 1;
      if (request.url?.startsWith("/token?")) return send(response, 200, bytes({ token: "token" }));
      if (calls === 1) return send(response, 401, distributionError("UNAUTHORIZED"), { "WWW-Authenticate": BEARER_CHALLENGE });
      return send(response, 404, distributionError("MANIFEST_UNKNOWN"));
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(3);
      expect(test.observed).toHaveLength(3);
      expect(test.observed.filter((item) => new URL(item.url).pathname === "/token")).toHaveLength(1);
    } finally {
      await local.close();
    }
  });

  it("rejects a repeated post-auth 401 without a second token exchange", async () => {
    let registryCalls = 0;
    const local = await fakeServer((request, response) => {
      if (request.url?.startsWith("/token?")) return send(response, 200, bytes({ token: "token" }));
      registryCalls += 1;
      return send(response, 401, distributionError("UNAUTHORIZED"), { "WWW-Authenticate": BEARER_CHALLENGE });
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(registryCalls).toBe(2);
      expect(test.observed).toHaveLength(3);
      expect(test.observed.filter((item) => new URL(item.url).pathname === "/token")).toHaveLength(1);
    } finally {
      await local.close();
    }
  });

  it.each([401, 404])("rejects later registry status %s after named resolution without authentication or retry", async (status) => {
    const fixture = makeInspectionFixture();
    let calls = 0;
    const local = await fakeServer((request, response) => {
      calls += 1;
      if (calls === 1) return successfulRoute(fixture)(request, response);
      const code = status === 401 ? "UNAUTHORIZED" : "MANIFEST_UNKNOWN";
      return send(response, status, distributionError(code), {
        ...(status === 401 ? { "WWW-Authenticate": BEARER_CHALLENGE } : {}),
      });
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(2);
      expect(test.observed.every((item) => new URL(item.url).pathname !== "/token")).toBe(true);
    } finally {
      await local.close();
    }
  });

  it.each([
    { responseKind: "401", fault: "encoding", requests: 1 },
    { responseKind: "404", fault: "encoding", requests: 1 },
    { responseKind: "generic", fault: "encoding", requests: 1 },
    { responseKind: "token", fault: "encoding", requests: 2 },
    { responseKind: "401", fault: "oversize", requests: 1 },
    { responseKind: "404", fault: "oversize", requests: 1 },
    { responseKind: "generic", fault: "oversize", requests: 1 },
    { responseKind: "token", fault: "oversize", requests: 2 },
  ])("enforces $fault before interpreting a $responseKind response", async ({ responseKind, fault, requests }) => {
    const oversized = new Uint8Array(1_048_577);
    const local = await fakeServer((request, response) => {
      if (responseKind === "token" && !request.url?.startsWith("/token?")) {
        return send(response, 401, distributionError("UNAUTHORIZED"), { "WWW-Authenticate": BEARER_CHALLENGE });
      }
      const status = responseKind === "401" ? 401 : responseKind === "404" ? 404 : responseKind === "generic" ? 500 : 200;
      const body = fault === "oversize"
        ? oversized
        : responseKind === "401" ? distributionError("UNAUTHORIZED")
          : responseKind === "404" ? distributionError("MANIFEST_UNKNOWN")
            : responseKind === "token" ? bytes({ token: "token" }) : bytes({ error: "failed" });
      const headers: Record<string, string> = fault === "encoding" ? { "Content-Encoding": "x-test-coding" } : {};
      send(response, status, body, headers);
    });
    try {
      const test = runner(local.origin);
      await expect(runCli(test.input)).resolves.toBe(1);
      expect(test.observed).toHaveLength(requests);
      expect(test.output()).toEqual({ stdout: "", stderr: "inspection failed: request or image validation failed\n" });
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

  it.each([
    { label: "misleading under-limit", contentLength: "1024" },
    { label: "absent", contentLength: undefined },
  ])("enforces the Fetch-exposed 1 MiB streaming cap with $label Content-Length", async ({ contentLength }) => {
    let calls = 0;
    let cancellations = 0;
    let requestAborted = false;
    const transport = async (request: Request) => {
      calls += 1;
      request.signal.addEventListener("abort", () => { requestAborted = true; }, { once: true });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1_048_576));
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() { cancellations += 1; },
      });
      const headers: Record<string, string> = {
        "Content-Type": INDEX_MEDIA_TYPE,
        "Docker-Content-Digest": `sha256:${"0".repeat(64)}`,
      };
      if (contentLength !== undefined) headers["Content-Length"] = contentLength;
      return new Response(body, { status: 200, headers });
    };
    let stdout = "";
    let stderr = "";
    const code = await runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {},
      stdout: { write(value: string) { stdout += value; } },
      stderr: { write(value: string) { stderr += value; } },
      transport, signals: new EventEmitter(),
    });
    expect(code).toBe(1);
    expect({ calls, cancellations, requestAborted }).toEqual({ calls: 1, cancellations: 1, requestAborted: true });
    expect({ stdout, stderr }).toEqual({ stdout: "", stderr: "inspection failed: request or image validation failed\n" });
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

  it("aborts one physical request after its 20-second response-header deadline", async () => {
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

  it("times out and cancels a stalled response body after headers without another request", async () => {
    vi.useFakeTimers();
    const fixture = makeInspectionFixture();
    const named = fixture.artifacts.values().next().value;
    let calls = 0;
    let cancellations = 0;
    let requestAborted = false;
    const transport = async (request: Request) => {
      calls += 1;
      request.signal.addEventListener("abort", () => { requestAborted = true; }, { once: true });
      const body = new ReadableStream<Uint8Array>({
        pull() { /* headers are available, but the body never yields a chunk */ },
        cancel() { cancellations += 1; },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": named.contentType,
          "Docker-Content-Digest": named.dockerDigest,
        },
      });
    };
    let stderr = "";
    const promise = runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {},
      stdout: { write() {} }, stderr: { write(value: string) { stderr += value; } },
      transport, signals: new EventEmitter(),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toBe(1);
    expect({ calls, cancellations, requestAborted }).toEqual({ calls: 1, cancellations: 1, requestAborted: true });
    expect(stderr).toBe("inspection failed: request or image validation failed\n");
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

  it("rejects success when the monotonic overall deadline crosses during final synchronous validation", async () => {
    const fixture = makeInspectionFixture();
    const realNow = performance.now.bind(performance);
    // Read 23 is the check immediately before the sixth synchronous core
    // validation; crossing on read 24 simulates that validation consuming the
    // remaining budget without yielding to the queued 90-second timer.
    let deadlineReads = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      const stack = new Error().stack ?? "";
      if (!stack.includes("scripts/inspect-oci-image.mjs")) return realNow();
      deadlineReads += 1;
      return deadlineReads >= 24 ? 90_001 : 0;
    });
    let calls = 0;
    const transport = async (request: Request) => {
      calls += 1;
      const artifact = fixture.artifacts.get(new URL(request.url).pathname);
      if (!artifact) throw new Error("unexpected path");
      return new Response(artifact.body, {
        status: 200,
        headers: {
          "Content-Type": artifact.contentType,
          "Docker-Content-Digest": artifact.dockerDigest,
          "Content-Encoding": "identity",
        },
      });
    };
    let stdout = "";
    let stderr = "";
    const code = await runCli({
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"], env: {},
      stdout: { write(value: string) { stdout += value; } },
      stderr: { write(value: string) { stderr += value; } },
      transport, signals: new EventEmitter(),
    });
    expect(code).toBe(1);
    expect(calls).toBe(6);
    expect(deadlineReads).toBe(24);
    expect({ stdout, stderr }).toEqual({ stdout: "", stderr: "inspection failed: request or image validation failed\n" });
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
