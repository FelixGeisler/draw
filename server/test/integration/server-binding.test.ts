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

// Never-listening guard: close() on a server whose listen() errored throws
// ERR_SERVER_NOT_RUNNING, and from a finally block that would mask the
// original failure.
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("server binding", () => {
  afterEach(() => {
    delete process.env.HOST;
  });

  it("listens on 127.0.0.1 by default and serves the API there", async () => {
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

  it("ignores an ambient HOST — dev stays pinned to loopback (#189)", async () => {
    // A shell profile or devcontainer exporting HOST must not silently move
    // the auth-less API off 127.0.0.1: only the production entry passes a
    // host deliberately (prod.ts + resolveHost).
    process.env.HOST = "0.0.0.0";
    const { startServer } = await import("../../src/server.js");

    const server = startServer(0);
    try {
      const addr = await listen(server);
      expect(addr.address).toBe("127.0.0.1");
    } finally {
      await close(server);
    }
  });

  // 127.0.0.2: any 127/8 address is loopback on Windows and Linux (CI), so
  // this proves an explicit host reaches listen() without exposing a LAN
  // port or tripping a firewall prompt. macOS only binds 127.0.0.1 by
  // default (EADDRNOTAVAIL), hence the skip.
  it.skipIf(process.platform === "darwin")(
    "honors an explicit host option — the production entry's path (#189)",
    async () => {
      const { startServer } = await import("../../src/server.js");

      const server = startServer(0, { host: "127.0.0.2" });
      try {
        const addr = await listen(server);
        expect(addr.address).toBe("127.0.0.2");

        const res = await fetch(`http://127.0.0.2:${addr.port}/api/health`);
        expect(res.status).toBe(200);
      } finally {
        await close(server);
      }
    },
  );
});
