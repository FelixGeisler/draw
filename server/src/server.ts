import type { Server } from "node:http";
import { createApp, type AppOptions } from "./app.js";
import { DEFAULT_HOST } from "./config.js";

export interface StartOptions extends AppOptions {
  /**
   * Listener address. Defaults to loopback — the dev entry never passes one,
   * so an ambient HOST export cannot silently unpin `npm run dev` from
   * 127.0.0.1 (the same injection class config.ts ignores PORT for). Only
   * the production entry resolves HOST deliberately (#189, ADR-49).
   */
  host?: string;
}

export function startServer(port: number, options: StartOptions = {}): Server {
  const { host = DEFAULT_HOST, ...appOptions } = options;
  return createApp(appOptions).listen(port, host, () => {
    console.log(`[server] listening on http://${host}:${port}`);
  });
}
