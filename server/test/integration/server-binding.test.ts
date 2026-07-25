import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

async function listen(server: Server): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server.address() as AddressInfo;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("server binding", () => {
  afterEach(() => {
    delete process.env.HOST;
  });

  it("listens on 127.0.0.1 by default and serves the API there", async () => {
    delete process.env.HOST;
    const { startServer } = await import("../../src/server.js");

    // Port 0 = ephemeral port, so a live dev server is undisturbed.
    const server = startServer(0);
    try {
      const addr = await listen(server);
      // listen(port) without a host would report "0.0.0.0" (all interfaces).
      expect(addr.address).toBe("127.0.0.1");

      const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await close(server);
    }
  });

  it("honors the HOST env var (#189)", async () => {
    // 127.0.0.2: any 127/8 address is loopback on Windows and Linux, so this
    // proves the env override reaches listen() without exposing a LAN port
    // or tripping a firewall prompt.
    process.env.HOST = "127.0.0.2";
    const { startServer } = await import("../../src/server.js");

    const server = startServer(0);
    try {
      const addr = await listen(server);
      expect(addr.address).toBe("127.0.0.2");

      const res = await fetch(`http://127.0.0.2:${addr.port}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await close(server);
    }
  });
});
