import type Database from "better-sqlite3";

interface FixtureBridge {
  prepare(sql: string): {
    run(...bindings: unknown[]): unknown;
    get(...bindings: unknown[]): unknown;
    all(...bindings: unknown[]): unknown[];
  };
  transaction<A extends unknown[], R>(fn: (...args: A) => R): {
    (...args: A): R;
    deferred(...args: A): R;
    immediate(...args: A): R;
    exclusive(...args: A): R;
  };
  exec(sql: string): unknown;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  open(): boolean;
  inTransaction(): boolean;
}

/** Test-only semantic adapter; db.ts's native handle object never escapes. */
export function createFixtureDatabase(): Database.Database {
  const bridge = (globalThis as Record<symbol, unknown>)[
    Symbol.for("draw.test.database-fixture")
  ] as FixtureBridge | undefined;
  if (!bridge) throw new Error("test database fixture bridge is unavailable");
  return {
    prepare: bridge.prepare,
    transaction: bridge.transaction,
    exec: bridge.exec,
    pragma: bridge.pragma,
    close() {},
    get open() { return bridge.open(); },
    get inTransaction() { return bridge.inTransaction(); },
  } as unknown as Database.Database;
}
