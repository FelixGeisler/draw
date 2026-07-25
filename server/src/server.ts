import type { Server } from "node:http";
import { createApp, type AppOptions } from "./app.js";
import { resolveHost } from "./config.js";

export function startServer(port: number, options: AppOptions = {}): Server {
  // Host resolved per call (not at import): tests set HOST around startServer.
  const host = resolveHost();
  return createApp(options).listen(port, host, () => {
    console.log(`[server] listening on http://${host}:${port}`);
  });
}
