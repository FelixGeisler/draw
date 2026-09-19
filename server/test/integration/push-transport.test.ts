import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createNodePushTransport } from "../../src/push/transport.js";
import { PUSH_TLS_CERT, PUSH_TLS_KEY } from "../support/push-tls-fixture.js";

const servers: https.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function provider(handler: Parameters<typeof https.createServer>[1]) {
  const server = https.createServer({ key: PUSH_TLS_KEY, cert: PUSH_TLS_CERT }, handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return (server.address() as AddressInfo).port;
}

function send(port: number, signal = new AbortController().signal, timedOut = () => false) {
  return createNodePushTransport({ ca: PUSH_TLS_CERT }).send({
    details: {
      endpoint: `https://draw.example:${port}/push?opaque=1`,
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": "9" },
      body: Buffer.from("encrypted"),
    },
    hostname: "draw.example",
    address: "127.0.0.1",
    signal,
    timedOut,
  });
}

describe("core HTTPS Push transport", () => {
  it("pins one address while preserving original Host, SNI and certificate identity", async () => {
    let requests = 0;
    let observed: { host?: string; servername?: string; body?: string } = {};
    const port = await provider((req, res) => {
      requests += 1;
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        observed = {
          host: req.headers.host,
          servername: typeof (req.socket as import("node:tls").TLSSocket).servername === "string"
            ? (req.socket as import("node:tls").TLSSocket).servername as string
            : undefined,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.writeHead(204).end();
      });
    });
    expect(await send(port)).toBe("success");
    expect(requests).toBe(1);
    expect(observed).toEqual({ host: `draw.example:${port}`, servername: "draw.example", body: "encrypted" });
  });

  it("classifies complete status responses, never follows redirects, and enforces the response cap", async () => {
    for (const [status, expected] of [[201, "success"], [404, "gone"], [410, "gone"], [302, "failed"], [500, "failed"]] as const) {
      let requests = 0;
      const port = await provider((_req, res) => {
        requests += 1;
        res.writeHead(status, status === 302 ? { Location: "https://elsewhere.invalid/" } : {}).end("bounded");
      });
      expect(await send(port), String(status)).toBe(expected);
      expect(requests).toBe(1);
    }
    const oversized = await provider((_req, res) => res.writeHead(200).end(Buffer.alloc(4_097)));
    expect(await send(oversized)).toBe("failed");
  });

  it("waits for abort-driven socket closure and distinguishes total timeout from client abort", async () => {
    const sockets = new Set<import("node:stream").Duplex>();
    const port = await provider((_req, _res) => {});
    servers.at(-1)!.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    let timedOut = false;
    const timeoutAbort = new AbortController();
    const timeout = send(port, timeoutAbort.signal, () => timedOut);
    await new Promise((resolve) => setTimeout(resolve, 10));
    timedOut = true;
    timeoutAbort.abort();
    expect(await timeout).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets.size).toBe(0);

    const clientAbort = new AbortController();
    const aborted = send(port, clientAbort.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    clientAbort.abort();
    expect(await aborted).toBe("aborted");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets.size).toBe(0);
  });
});
