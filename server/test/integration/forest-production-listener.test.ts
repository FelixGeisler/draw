import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const invocations = vi.hoisted(() => ({
  express: 0,
  authentication: 0,
  forest: 0,
}));

type DispatchHandle = (req: Request, res: Response, next: NextFunction) => unknown;

// Test-only observation around the real application assembled by startProduction().
// The listener, parser, auth implementation and forest implementation remain real.
vi.mock("../../src/app.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app.js")>();
  return {
    ...actual,
    createApp(...args: Parameters<typeof actual.createApp>) {
      const app = actual.createApp(...args);
      const dispatchable = app as typeof app & { handle: DispatchHandle };
      const handle = dispatchable.handle.bind(app);
      dispatchable.handle = (req, res, next) => {
        invocations.express += 1;
        return handle(req, res, next);
      };
      return app;
    },
  };
});

vi.mock("../../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth.js")>();
  return {
    ...actual,
    createAuth(...args: Parameters<typeof actual.createAuth>) {
      const handlers = actual.createAuth(...args);
      const gate: RequestHandler = (req, res, next) => {
        invocations.authentication += 1;
        handlers.gate(req, res, next);
      };
      return { ...handlers, gate };
    },
  };
});

vi.mock("../../src/routes/forest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routes/forest.js")>();
  const dispatchable = actual.forestRouter as typeof actual.forestRouter & { handle: DispatchHandle };
  const handle = dispatchable.handle.bind(actual.forestRouter);
  dispatchable.handle = (req, res, next) => {
    invocations.forest += 1;
    return handle(req, res, next);
  };
  return actual;
});

import { db } from "../../src/db.js";
import { startProduction, type ProductionAssembly } from "../../src/prod.js";

type RawResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

let assembly: ProductionAssembly | undefined;
let root: string | undefined;

afterEach(async () => {
  if (assembly) {
    await new Promise<void>((resolve, reject) => {
      assembly?.server.close((error) => error ? reject(error) : resolve());
    });
    assembly = undefined;
  }
  if (root) {
    fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
  invocations.express = 0;
  invocations.authentication = 0;
  invocations.forest = 0;
});

function rawPacket(port: number, target: Buffer, credential?: string): Buffer {
  const headers = [
    Buffer.from("GET ", "ascii"),
    target,
    Buffer.from(
      ` HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        (credential ? `x-draw-password: ${credential}\r\n` : "") +
        "Connection: close\r\n\r\n",
      "ascii",
    ),
  ];
  return Buffer.concat(headers);
}

async function sendRaw(port: number, packet: Buffer): Promise<RawResponse> {
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => socket.write(packet));
    socket.setTimeout(5_000, () => socket.destroy(new Error("raw forest request timed out")));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("error", reject);
    socket.on("end", () => resolve(Buffer.concat(chunks)));
  });
  const separator = bytes.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("raw forest response has no header terminator");
  const lines = bytes.subarray(0, separator).toString("latin1").split("\r\n");
  const match = /^HTTP\/1\.1 ([0-9]{3}) /.exec(lines.shift() ?? "");
  if (!match) throw new Error("raw forest response has no HTTP/1.1 status");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("raw forest response has a malformed header");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(match[1]), headers, body: bytes.subarray(separator + 4) };
}

describe("forest boundary on the production listener", () => {
  it("keeps literal UTF-8 below Node while admitted ASCII preserves auth and forest contracts", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "draw-forest-production-"));
    const dataDir = path.join(root, "data");
    const clientDir = path.join(root, "client");
    fs.mkdirSync(dataDir);
    fs.mkdirSync(clientDir);
    fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>forest test</title>");
    let providerCalls = 0;
    assembly = startProduction({
      database: db,
      dataDir,
      clientDir,
      host: "127.0.0.1",
      port: 0,
      password: "forest-secret",
      startSchedulers: false,
      pushTransport: {
        send: async () => {
          providerCalls += 1;
          throw new Error("forest listener test must not contact a provider");
        },
      },
    });
    await new Promise<void>((resolve) => {
      if (assembly?.server.listening) resolve();
      else assembly?.server.once("listening", resolve);
    });
    const port = (assembly.server.address() as AddressInfo).port;
    expect(assembly.server.listenerCount("clientError")).toBe(0);

    const literalTarget = Buffer.concat([
      Buffer.from("/api/forest?beforeId=", "ascii"),
      Buffer.from([0xc3, 0xa9]),
    ]);
    const literal = await sendRaw(port, rawPacket(port, literalTarget));
    expect(literal.status).toBe(400);
    expect(literal.body).toHaveLength(0);
    expect(invocations).toEqual({ express: 0, authentication: 0, forest: 0 });

    const encodedTarget = Buffer.from("/api/forest?beforeId=%C3%A9", "ascii");
    const unauthenticated = await sendRaw(port, rawPacket(port, encodedTarget));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.toString("utf8")).toBe('{"error":"authentication required"}');
    expect(invocations).toEqual({ express: 1, authentication: 1, forest: 0 });

    const authenticated = await sendRaw(
      port,
      rawPacket(port, encodedTarget, "forest-secret"),
    );
    expect(authenticated.status).toBe(400);
    expect(authenticated.headers["cache-control"]).toBe("no-store");
    expect(authenticated.body.toString("utf8")).toBe('{"error":"invalid-forest-request"}');
    expect(invocations).toEqual({ express: 2, authentication: 2, forest: 1 });

    expect(assembly.server.listenerCount("clientError")).toBe(0);
    expect(providerCalls).toBe(0);
  });
});
