import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

describe("server binding", () => {
  it("listens on 127.0.0.1 only and serves the API there", async () => {
    const { startServer, HOST } = await import("../../src/server.js");
    expect(HOST).toBe("127.0.0.1");

    // Port 0 = ephemeral port, so a live dev server is undisturbed.
    const server = startServer(0);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    try {
      const addr = server.address() as AddressInfo;
      // listen(port) without a host would report "0.0.0.0" (all interfaces).
      expect(addr.address).toBe("127.0.0.1");

      const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
