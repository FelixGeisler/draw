import type Database from "better-sqlite3";
import path from "node:path";

type NativeDatabase = Database.Database;
type TransactionMode = "default" | "deferred" | "immediate" | "exclusive";

let liveFixtureDatabase: NativeDatabase | null = null;

function fixturePath(): string {
  if (!process.env.DATA_DIR) throw new Error("test database fixture requires DATA_DIR");
  return path.join(path.resolve(process.env.DATA_DIR), "app.db");
}

/** Test harness registration; deliberately returns no capability. */
export function trackFixtureDatabase(database: NativeDatabase): void {
  if (
    path.resolve(database.name) === fixturePath() &&
    !liveFixtureDatabase?.open
  ) liveFixtureDatabase = database;
}

function currentDatabase(): NativeDatabase {
  if (!liveFixtureDatabase?.open) throw new Error("test database fixture is unavailable");
  return liveFixtureDatabase;
}

function copiedValue(value: unknown): unknown {
  if (
    value === null || value === undefined ||
    typeof value === "string" || typeof value === "number" ||
    typeof value === "bigint" || typeof value === "boolean"
  ) return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(copiedValue);
  if (typeof value === "object") {
    if (value === liveFixtureDatabase) throw new Error("test fixture refused a native database result");
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, copiedValue(entry)]),
    );
  }
  throw new Error("test fixture refused a non-data result");
}

/**
 * Test-only adapter outside src/: callbacks share the app's connection for
 * rollback and TEMP-trigger fixtures, but every outward result is copied data
 * or void and the closure-private native handle is never exposed.
 */
export function createFixtureDatabase(): Database.Database {
  function transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const invoke = (mode: TransactionMode, args: A): R => {
      const native = currentDatabase().transaction(
        (...callbackArgs: A) => Reflect.apply(fn, undefined, callbackArgs),
      );
      const selected = mode === "default" ? native : native[mode];
      return copiedValue(Reflect.apply(selected, undefined, args)) as R;
    };
    const wrapped = ((...args: A) => invoke("default", args)) as {
      (...args: A): R;
      deferred(...args: A): R;
      immediate(...args: A): R;
      exclusive(...args: A): R;
    };
    Object.defineProperties(wrapped, {
      deferred: { value: (...args: A) => invoke("deferred", args), enumerable: true },
      immediate: { value: (...args: A) => invoke("immediate", args), enumerable: true },
      exclusive: { value: (...args: A) => invoke("exclusive", args), enumerable: true },
    });
    return Object.freeze(wrapped);
  }

  const fixture = {
    prepare(sql: string) {
      return Object.freeze({
        run(...bindings: unknown[]) {
          const result = currentDatabase().prepare(sql).run(...bindings);
          return Object.freeze({
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          });
        },
        get(...bindings: unknown[]) {
          return copiedValue(currentDatabase().prepare(sql).get(...bindings));
        },
        all(...bindings: unknown[]) {
          return copiedValue(currentDatabase().prepare(sql).all(...bindings));
        },
      });
    },
    transaction,
    exec(sql: string): void {
      currentDatabase().exec(sql);
    },
    pragma(source: string, options?: { simple?: boolean }) {
      return copiedValue(currentDatabase().pragma(source, options as never));
    },
    close(): void {},
    get open(): boolean {
      return liveFixtureDatabase?.open ?? false;
    },
    get inTransaction(): boolean {
      return liveFixtureDatabase?.inTransaction ?? false;
    },
  };

  return fixture as unknown as Database.Database;
}
