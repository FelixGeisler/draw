import fs from "node:fs";
import { parentPort, threadId, workerData } from "node:worker_threads";
import NativeDatabase from "better-sqlite3";

const eventFile = process.env.DRAW_WEEK_TEST_EVENT_FILE;
const mode = process.env.DRAW_WEEK_TEST_MODE || "observe";
function event(type, detail = {}) {
  const row = { pid: process.pid, threadId, type, ...detail };
  if (eventFile) fs.appendFileSync(eventFile, `${JSON.stringify(row)}\n`);
}

let openConnections = 0;
let titleCalls = 0;
let activeTitleCalls = 0;
let maxActiveTitleCalls = 0;

function wrapStatement(statement, sql) {
  const isIdentity = /week_interval_rtree/.test(sql) && /LIMIT 101/.test(sql);
  const isTitle = /octet_length\(title\)/.test(sql) && /substr\(CAST\(title AS BLOB\),1,\?\)/.test(sql);
  return new Proxy(statement, {
    get(target, property) {
      if (property === "all") return (...args) => {
        if (isIdentity) {
          event("identity-all", { bindings: args.length });
          if (mode === "query") throw new Error("injected test-only identity query failure");
          if (mode === "block") {
            const control = workerData && workerData.__drawWeekTestControl;
            const releaseFile = process.env.DRAW_WEEK_TEST_RELEASE_FILE;
            event("identity-blocked");
            if (control instanceof SharedArrayBuffer) {
              Atomics.wait(new Int32Array(control), 0, 0);
            } else if (releaseFile) {
              const pause = new Int32Array(new SharedArrayBuffer(4));
              while (!fs.existsSync(releaseFile)) Atomics.wait(pause, 0, 0, 10);
            } else {
              throw new Error("missing test block control");
            }
            event("identity-released");
          }
        }
        return target.all(...args);
      };
      if (property === "get") return (...args) => {
        if (!isTitle) return target.get(...args);
        titleCalls += 1;
        activeTitleCalls += 1;
        maxActiveTitleCalls = Math.max(maxActiveTitleCalls, activeTitleCalls);
        event("title-get-start", { call: titleCalls, prefixLimit: args[0], sourceId: args[1], active: activeTitleCalls });
        try {
          if (mode === "allocation") throw new RangeError("injected test-only allocation failure");
          const value = target.get(...args);
          if (mode === "title-metadata" && value) return { ...value, byteLength: -1 };
          return value;
        } finally {
          activeTitleCalls -= 1;
          event("title-get-end", { call: titleCalls, active: activeTitleCalls, maxActive: maxActiveTitleCalls });
        }
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const InstrumentedDatabase = new Proxy(NativeDatabase, {
  construct(target, args) {
    const database = Reflect.construct(target, args, target);
    openConnections += 1;
    event("connection-open", {
      databasePath: args[0],
      options: args[1],
      readonlyProperty: database.readonly,
      openConnections,
    });
    const originalPrepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      const title = /octet_length\(title\)/.test(sql);
      const identity = /week_interval_rtree/.test(sql) && /LIMIT 101/.test(sql);
      event("prepare", { title, identity, sqlContainsTitle: /\btitle\b/i.test(sql) });
      return wrapStatement(originalPrepare(sql), sql);
    };
    const originalPragma = database.pragma.bind(database);
    database.pragma = (source, options) => {
      const result = originalPragma(source, options);
      event("pragma", { source });
      if (/^temp_store\s*=\s*FILE$/i.test(source)) {
        let blocked = false;
        try { originalPrepare("UPDATE tasks SET title=title WHERE id=-1").run(); } catch { blocked = true; }
        event("query-only-write-attempt", { blocked });
      }
      return result;
    };
    const originalFunction = database.function.bind(database);
    database.function = (...args) => {
      event("udf-registration", { name: args[0] });
      return originalFunction(...args);
    };
    const originalClose = database.close.bind(database);
    database.close = () => {
      event("connection-close-start", { openConnections });
      const result = originalClose();
      openConnections -= 1;
      event("connection-close-end", { openConnections });
      return result;
    };
    return database;
  },
});

export default InstrumentedDatabase;
