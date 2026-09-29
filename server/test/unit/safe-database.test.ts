import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { assertSafeSql, createSafeDatabase } from "../../src/safeDatabase.js";

const handles: Database.Database[] = [];
function memory() {
  const handle = new Database(":memory:");
  handles.push(handle);
  handle.exec("CREATE TABLE ordinary(id INTEGER PRIMARY KEY, value TEXT)");
  return handle;
}
afterEach(() => {
  while (handles.length) handles.pop()!.close();
});

describe("SafeDatabase lexical and capability boundary", () => {
  it("allows the application statement subset and harmless literals", () => {
    for (const sql of [
      "SELECT 1",
      " -- lead\n SELECT 1; /* tail */",
      "WITH one(value) AS (SELECT 1) SELECT value FROM one",
      "INSERT INTO ordinary(value) VALUES (?)",
      "UPDATE ordinary SET value=? WHERE id=?",
      "DELETE FROM ordinary WHERE id=?",
      "REPLACE INTO ordinary(id,value) VALUES (?,?)",
      "SELECT 'open', 'DROP', 'PRAGMA'",
      "SELECT 'week_interval''_access'",
      "SELECT X'7765656B5F696E74657276616C5F616363657373'",
    ]) expect(() => assertSafeSql(sql)).not.toThrow();
  });

  it("rejects DDL, pragmas, attachment, transaction SQL and multiple statements", () => {
    for (const sql of [
      "DROP TRIGGER tasks_stamp_sort_order",
      "/* split */ DrOp /* x */ TrIgGeR tasks_stamp_sort_order",
      "CREATE TEMP TRIGGER x AFTER INSERT ON ordinary BEGIN SELECT 1; END",
      "ALTER TABLE ordinary ADD COLUMN other TEXT",
      "VACUUM INTO 'other.db'",
      "REINDEX ordinary",
      "ANALYZE",
      "ATTACH 'other.db' AS other",
      "DETACH other",
      "PRAGMA database_list",
      "BEGIN",
      "COMMIT",
      "END",
      "ROLLBACK",
      "SAVEPOINT x",
      "RELEASE x",
      "SELECT 1; SELECT 2",
      "SELECT 1;;",
      "SELECT 1\0",
      "SELECT 'unterminated",
      "SELECT /* unterminated",
    ]) expect(() => assertSafeSql(sql), sql).toThrow(/unsafe SQL/);
  });

  it("rejects every protected path/projection spelling before native preparation", () => {
    for (const sql of [
      "SELECT * FROM pragma_database_list",
      "SELECT * FROM 'pragma_database_list'",
      "SELECT * FROM main.'week_access_state'",
      "SELECT * FROM 'main'.'week_interval_rtree_rowid'",
      "DELETE FROM 'week_interval_access' WHERE index_id=1",
      "UPDATE 'week_access_state' SET ready=1",
      "SELECT * FROM 'WeEk_InTeRvAl_RtReE'",
      "SELECT 'week_interval_access'",
      "SELECT 'PrAgMa_''database_list'",
      'SELECT * FROM "week_interval_access"',
      "SELECT * FROM `week_interval_access`",
      "SELECT * FROM [week_interval_access]",
      'SELECT * FROM main."sqlite_schema"',
      "SELECT * FROM sqlite_dbpage",
      "SELECT load_extension('x')",
      "SELECT readfile('x')",
      "SELECT writefile('x',X'00')",
      "SELECT eval('SELECT 1')",
      "SELECT * FROM bytecode('SELECT 1')",
    ]) {
      let resolutions = 0;
      const handle = memory();
      const safe = createSafeDatabase(() => {
        resolutions += 1;
        return handle;
      });
      const before = handle.serialize();
      expect(() => safe.prepare(sql), sql).toThrow(/unsafe SQL/);
      expect(resolutions).toBe(0);
      expect(handle.serialize().equals(before)).toBe(true);
    }
  });

  it("exports only frozen wrappers and plain copied values, never native capabilities", () => {
    const handle = memory();
    const safe = createSafeDatabase(() => handle);
    expect(Object.isFrozen(safe)).toBe(true);
    expect(Object.keys(safe).sort()).toEqual(["prepare", "transaction"]);
    for (const member of [
      "exec", "pragma", "iterate", "backup", "serialize", "function", "aggregate", "table",
      "loadExtension", "unsafeMode", "close", "name", "open", "inTransaction", "memory",
      "readonly", "database",
    ]) expect(member in safe).toBe(false);

    const statement = safe.prepare("INSERT INTO ordinary(value) VALUES (?)");
    expect(Object.isFrozen(statement)).toBe(true);
    expect(Object.keys(statement).sort()).toEqual(["all", "get", "run"]);
    expect("database" in statement).toBe(false);
    expect("iterate" in statement).toBe(false);
    const result = statement.run("one");
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.changes).toBe(1);

    const row = safe.prepare("SELECT id,value FROM ordinary").get()!;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(row).toEqual({ id: 1, value: "one" });
    row.value = "copy only";
    expect(safe.prepare("SELECT value FROM ordinary").get()).toEqual({ value: "one" });

    const transaction = safe.transaction((value: string) => {
      safe.prepare("INSERT INTO ordinary(value) VALUES (?)").run(value);
      return value;
    });
    expect(Object.isFrozen(transaction)).toBe(true);
    expect("database" in transaction).toBe(false);
    expect(Object.keys(transaction).sort()).toEqual(["deferred", "exclusive", "immediate"]);
    expect(Object.isFrozen(transaction.deferred)).toBe(true);
    expect(Object.isFrozen(transaction.immediate)).toBe(true);
    expect(Object.isFrozen(transaction.exclusive)).toBe(true);
    expect(transaction.immediate("two")).toBe("two");
  });

  it("resolves the current handle even for wrappers created before a restore-style replacement", () => {
    const first = memory();
    const second = memory();
    let current = first;
    const safe = createSafeDatabase(() => current);
    const insert = safe.prepare("INSERT INTO ordinary(value) VALUES (?)");
    const transaction = safe.transaction((value: string) => insert.run(value).changes);
    insert.run("first");
    current = second;
    expect(transaction.exclusive("second")).toBe(1);
    expect(first.prepare("SELECT value FROM ordinary").all()).toEqual([{ value: "first" }]);
    expect(second.prepare("SELECT value FROM ordinary").all()).toEqual([{ value: "second" }]);
  });
});
