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

function send(
  port: number,
  signal = new AbortController().signal,
  timedOut = () => false,
  ownedEvents: string[] = [],
) {
  return createNodePushTransport({ ca: PUSH_TLS_CERT, onOwnedEvent: (event) => ownedEvents.push(event) }).send({
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

  it("classifies complete status responses, never follows redirects, and settles only after every local close", async () => {
    for (const [status, expected] of [[201, "success"], [404, "gone"], [410, "gone"], [302, "failed"], [500, "failed"]] as const) {
      let requests = 0;
      const port = await provider((_req, res) => {
        requests += 1;
        res.writeHead(status, status === 302 ? { Location: "https://elsewhere.invalid/" } : {}).end("bounded");
      });
      const events: string[] = [];
      expect(await send(port, undefined, undefined, events), String(status)).toBe(expected);
      expect(requests).toBe(1);
      expect(events.sort()).toEqual(["agent-destroy", "request-close", "response-close", "socket-close"]);
    }

    for (const [kind, handler] of [
      ["oversized", (_req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) =>
        res.writeHead(200).end(Buffer.alloc(4_097))],
      ["premature", (_req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
        res.writeHead(200);
        res.write("incomplete");
        res.destroy();
      }],
    ] as const) {
      const port = await provider(handler);
      const events: string[] = [];
      expect(await send(port, undefined, undefined, events), kind).toBe("failed");
      expect(events, kind).toContain("agent-destroy");
      expect(events, kind).toContain("request-close");
      expect(events, kind).toContain("socket-close");
      if (kind === "oversized") expect(events).toContain("response-close");
    }
  });

  it("destroys its one-use agent when core HTTPS rejects request construction synchronously", async () => {
    const events: string[] = [];
    const result = await createNodePushTransport({
      ca: PUSH_TLS_CERT,
      onOwnedEvent: (event) => events.push(event),
    }).send({
      details: {
        endpoint: "https://draw.example/push",
        method: "POST",
        headers: { "x-invalid": "line-one\nline-two" },
        body: Buffer.from("encrypted"),
      },
      hostname: "draw.example",
      address: "127.0.0.1",
      signal: new AbortController().signal,
      timedOut: () => false,
    });
    expect(result).toBe("failed");
    expect(events).toEqual(["agent-destroy"]);
  });

  it("waits for an incomplete provider response to close on total timeout and client abort", async () => {
    const port = await provider((_req, res) => {
      res.writeHead(200);
      res.write("incomplete");
    });

    let timedOut = false;
    const timeoutAbort = new AbortController();
    const timeoutEvents: string[] = [];
    const timeout = send(port, timeoutAbort.signal, () => timedOut, timeoutEvents);
    await new Promise((resolve) => setTimeout(resolve, 10));
    timedOut = true;
    timeoutAbort.abort();
    expect(await timeout).toBe("timeout");
    expect(timeoutEvents.sort()).toEqual(["agent-destroy", "request-close", "response-close", "socket-close"]);

    const clientAbort = new AbortController();
    const abortEvents: string[] = [];
    const aborted = send(port, clientAbort.signal, () => false, abortEvents);
    await new Promise((resolve) => setTimeout(resolve, 10));
    clientAbort.abort();
    expect(await aborted).toBe("aborted");
    expect(abortEvents.sort()).toEqual(["agent-destroy", "request-close", "response-close", "socket-close"]);
  });
});
