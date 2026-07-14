import type { Server } from "node:http";
import { createApp } from "./app.js";

// Loopback only: single local user by design (arc42 8.5), so the API must
// not be reachable from the LAN. listen(port) without a host would bind
// all interfaces.
export const HOST = "127.0.0.1";

export function startServer(port: number): Server {
  return createApp().listen(port, HOST, () => {
    console.log(`[server] listening on http://${HOST}:${port}`);
  });
}
