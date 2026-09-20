import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  lanExposureWarning,
  resolveApiPort,
  resolveBackupIntervalHours,
  resolveBackupRetention,
  resolveHost,
  resolvePassword,
  resolveTrustProxy,
  resolveUpdateCheckIntervalHours,
} from "./config.js";
import { startServer } from "./server.js";
import { startBackupScheduler } from "./backupScheduler.js";
import { startUpdateScheduler } from "./updateScheduler.js";
import { dataDir, db } from "./db.js";
import { PushAdmission } from "./push/admission.js";
import { PushLifecycle } from "./push/authority.js";
import { PushService } from "./push/service.js";
import { createNodePushTransport } from "./push/transport.js";
import type { ResolverFactory } from "./push/resolver.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ProductionAssemblyOptions {
  /** Test-only production assembly seam; ordinary startup passes nothing. */
  env?: NodeJS.ProcessEnv;
  database?: Database.Database;
  dataDir?: string;
  clientDir?: string;
  host?: string;
  port?: number;
  password?: string;
  trustProxy?: boolean | number | string;
  resolverFactory?: ResolverFactory;
  /** Test-only CA seam for an isolated temporary Push TLS provider. */
  pushTransportCa?: string | Buffer;
  startSchedulers?: boolean;
}

export interface ProductionAssembly {
  server: Server;
  push: PushService;
  resolved: { host: string; port: number; password?: string; trustProxy: boolean | number | string };
}

/** Resolve production config once and reuse those exact values for topology and listen(). */
export function startProduction(options: ProductionAssemblyOptions = {}): ProductionAssembly {
  process.env.NODE_ENV ??= "production";
  const env = options.env ?? process.env;
  const clientDir = options.clientDir ?? (env.CLIENT_DIR
    ? path.resolve(env.CLIENT_DIR)
    : path.resolve(here, "../../client/dist"));
  if (!fs.existsSync(path.join(clientDir, "index.html"))) {
    throw new Error(`[server] no client build at ${clientDir} — run \`npm run build\` first`);
  }

  const password = options.password ?? resolvePassword(env);
  if (password) console.log("[server] password protection enabled (DRAW_PASSWORD)");
  const host = options.host ?? resolveHost(env);
  const port = options.port ?? resolveApiPort(env);
  const trustProxy = options.trustProxy ?? resolveTrustProxy(env);
  const warning = lanExposureWarning(host, password);
  if (warning) console.error(warning);

  const database = options.database ?? db;
  const root = options.dataDir ?? dataDir;
  const admission = new PushAdmission();
  const lifecycle = new PushLifecycle({
    dataDir: root,
    password,
    deleteSubscriptions: () => {
      const removed = database.transaction(() => {
        const ids = database.prepare("SELECT id FROM push_subscriptions").all() as { id: string }[];
        database.prepare("DELETE FROM push_subscriptions").run();
        return ids.map(({ id }) => id);
      })();
      removed.forEach((id) => admission.removeDevice(id));
    },
  });
  let server: Server | undefined;
  const push = new PushService({
    database,
    lifecycle,
    topology: {
      listenerHost: host,
      listenerPort: () => {
        if (port !== 0) return port;
        const address = server?.address();
        return typeof address === "object" && address ? (address as AddressInfo).port : 0;
      },
      trustProxy,
    },
    admission,
    transport: createNodePushTransport(options.pushTransportCa === undefined ? {} : { ca: options.pushTransportCa }),
    ...(options.resolverFactory ? { resolverFactory: options.resolverFactory } : {}),
  });
  const state = push.snapshot();
  if (!state.available) console.error(`[push] unavailable (${state.reason})`);

  server = startServer(port, { clientDir, host, password, trustProxy }, { push });

  if (options.startSchedulers !== false) {
    const backupIntervalHours = resolveBackupIntervalHours(env);
    const backupRetention = resolveBackupRetention(env);
    if (backupIntervalHours > 0) {
      console.log(
        `[server] scheduled backups every ${backupIntervalHours}h, keeping ${backupRetention} ` +
          `(DATA_DIR/backups; restore via POST /api/backup/import)`,
      );
      startBackupScheduler(backupIntervalHours, backupRetention);
    }
    const updateIntervalHours = resolveUpdateCheckIntervalHours(env);
    if (updateIntervalHours > 0) {
      console.log(
        `[server] update check every ${updateIntervalHours}h ` +
          `(UPDATE_CHECK_INTERVAL_HOURS=0 or the Settings toggle disables)`,
      );
      startUpdateScheduler(updateIntervalHours);
    }
  }
  return { server, push, resolved: { host, port, password, trustProxy } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    startProduction();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
