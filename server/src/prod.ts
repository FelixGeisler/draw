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
import { PushService, type PushServiceOptions } from "./push/service.js";
import { createNodePushTransport, type PushTransport } from "./push/transport.js";
import type { ResolverFactory } from "./push/resolver.js";
import { startDeadlineScheduler, type DeadlineScheduler, type DeadlineTimer } from "./push/deadlineScheduler.js";

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
  pushTransport?: PushTransport;
  deadlineNow?: () => Date;
  deadlineTimer?: DeadlineTimer;
  generateRequestDetails?: PushServiceOptions["generateRequestDetails"];
  observeDeadlinePayload?: (payload: Buffer) => void;
  startSchedulers?: boolean;
}

export interface ProductionAssembly {
  server: Server;
  push: PushService;
  deadlineScheduler: DeadlineScheduler | null;
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

  const database = () => options.database ?? db;
  const root = options.dataDir ?? dataDir;
  const admission = new PushAdmission();
  const lifecycle = new PushLifecycle({
    dataDir: root,
    password,
    deleteSubscriptions: () => {
      const current = database();
      const removed = current.transaction(() => {
        const ids = current.prepare("SELECT id FROM push_subscriptions").all() as { id: string }[];
        current.prepare("DELETE FROM push_subscriptions").run();
        return ids.map(({ id }) => id);
      })();
      removed.forEach((id) => admission.removeDevice(id));
    },
  });
  let server: Server | undefined;
  const transport = options.pushTransport ?? createNodePushTransport(
    options.pushTransportCa === undefined ? {} : { ca: options.pushTransportCa },
  );
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
    transport,
    ...(options.resolverFactory ? { resolverFactory: options.resolverFactory } : {}),
    ...(options.generateRequestDetails ? { generateRequestDetails: options.generateRequestDetails } : {}),
    ...(options.observeDeadlinePayload ? { observeDeadlinePayload: options.observeDeadlinePayload } : {}),
  });
  const state = push.snapshot();
  if (!state.available) console.error(`[push] unavailable (${state.reason})`);

  server = startServer(port, { clientDir, host, password, trustProxy }, { push });

  let deadlineScheduler: DeadlineScheduler | null = null;
  if (options.startSchedulers !== false) {
    deadlineScheduler = startDeadlineScheduler({
      database,
      push,
      ...(options.deadlineNow ? { now: options.deadlineNow } : {}),
      ...(options.deadlineTimer ? { timer: options.deadlineTimer } : {}),
    });
    server.once("close", () => deadlineScheduler?.stop());
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
  return { server, push, deadlineScheduler, resolved: { host, port, password, trustProxy } };
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
