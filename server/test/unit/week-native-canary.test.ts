import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSafeDatabase } from "../../src/safeDatabase.js";

/** Repeated on Windows and Linux: these native escape paths justify ADR-75's facade. */
describe("pinned SQLite RTree/native capability canary", () => {
  it("confirms native recovery and virtual writes while the facade blocks them", () => {
    const native = new Database(":memory:");
    try {
      native.unsafeMode(false);
      native.exec("CREATE VIRTUAL TABLE week_interval_rtree USING rtree_i32(index_id,start_day,end_day)");
      const statement = native.prepare("SELECT 1");
      const transaction = native.transaction(() => undefined);
      expect((statement as unknown as { database: unknown }).database).toBe(native);
      expect((transaction as unknown as { database: unknown }).database).toBe(native);
      expect(() => native.prepare(
        "INSERT INTO week_interval_rtree(index_id,start_day,end_day) VALUES (1,2,3)",
      ).run()).not.toThrow();
      expect(() => native.prepare(
        "INSERT INTO week_interval_rtree_node(nodeno,data) VALUES (2,zeroblob(1228))",
      ).run()).toThrow();

      let resolutions = 0;
      const safe = createSafeDatabase(() => {
        resolutions += 1;
        return native;
      });
      for (const sql of [
        "SELECT * FROM week_interval_rtree",
        "DELETE FROM week_interval_rtree WHERE index_id=1",
        "SELECT * FROM week_interval_rtree_node",
      ]) expect(() => safe.prepare(sql)).toThrow(/unsafe SQL/);
      expect(resolutions).toBe(0);
      expect("database" in safe.prepare("SELECT 1")).toBe(false);
      expect("database" in safe.transaction(() => undefined)).toBe(false);
    } finally {
      native.close();
    }
  });
});
