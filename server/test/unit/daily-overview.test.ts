import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { dailyOverviewForDate } from "../../src/services/dailyOverviewService.js";
import { addCalendarDays, validCalendarDate, zonedLocalDate } from "../../src/services/localDay.js";

function fixture() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL,
      recur_every_days INTEGER, blocked INTEGER, deferred_until TEXT, window_days TEXT, window_start TEXT, window_end TEXT,
      parent_id INTEGER, subtask_order_mode TEXT NOT NULL DEFAULT 'parallel', sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE goals (id INTEGER PRIMARY KEY, title TEXT NOT NULL, target_date TEXT, status TEXT NOT NULL);
  `);
  return database;
}

describe("daily overview domain service", () => {
  it("classifies every eligible entity independently and orders date/type/id without drawability filters", () => {
    const db = fixture();
    // Reverse every unordered SQLite scan so the expected total order cannot
    // pass merely because INTEGER PRIMARY KEY happens to yield ascending ids.
    db.pragma("reverse_unordered_selects = ON");
    const task = db.prepare(`INSERT INTO tasks
      (id,title,due_date,status,recur_every_days,blocked,deferred_until,window_days,window_start,window_end)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    task.run(9, "blocked recurring", "2026-09-27", "open", 7, 1, "2099-01-01T00:00:00.000Z", "[1]", "09:00", "10:00");
    task.run(2, "old task", "2026-09-20", "open", null, 0, null, null, null, null);
    task.run(1, "done", "2026-09-27", "done", null, 0, null, null, null, null);
    task.run(3, "archived", "2026-09-27", "archived", null, 0, null, null, null, null);
    task.run(4, "undated", null, "open", null, 0, null, null, null, null);
    task.run(5, "malformed", "2026-02-30", "open", null, 0, null, null, null, null);
    task.run(6, "future", "2026-09-29", "open", null, 0, null, null, null, null);
    task.run(40, "later overdue task", "2026-09-26", "open", null, 0, null, null, null, null);
    task.run(15, "same-date overdue task", "2026-09-25", "open", null, 0, null, null, null, null);
    task.run(7, "lower-id same-day task inserted late", "2026-09-27", "open", null, 0, null, null, null, null);
    const hierarchyTask = db.prepare(`INSERT INTO tasks
      (id,title,due_date,status,recur_every_days,blocked,deferred_until,window_days,window_start,window_end,parent_id,subtask_order_mode,sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    hierarchyTask.run(20, "qualifying parent", "2026-09-27", "open", null, 0, null, null, null, null, null, "sequential", 0);
    hierarchyTask.run(22, "qualifying sequential-held subtask", "2026-09-27", "open", null, 0, null, null, null, null, 20, "parallel", 2);
    hierarchyTask.run(21, "qualifying first subtask", "2026-09-27", "open", null, 0, null, null, null, null, 20, "parallel", 1);
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(8, "same-day goal", "2026-09-27", "active");
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(4, "first same-day goal", "2026-09-27", "active");
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(10, "last same-day goal", "2026-09-27", "active");
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(7, "achieved goal", "2026-09-20", "achieved");
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(11, "missed goal", "2026-09-20", "missed");
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(12, "dropped goal", "2026-09-20", "dropped");
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(13, "impossible goal", "2025-02-29", "active");
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(99, "same-date overdue goal", "2026-09-25", "active");
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(14, "middle overdue goal", "2026-09-23", "active");
    db.prepare("INSERT INTO goals VALUES (?,?,?,?)").run(6, "tomorrow goal", "2026-09-28", "active");

    expect(dailyOverviewForDate("2026-09-27", db)).toEqual({
      overdue: [
        { type: "task", id: 2, title: "old task", date: "2026-09-20" },
        { type: "goal", id: 14, title: "middle overdue goal", date: "2026-09-23" },
        { type: "goal", id: 99, title: "same-date overdue goal", date: "2026-09-25" },
        { type: "task", id: 15, title: "same-date overdue task", date: "2026-09-25" },
        { type: "task", id: 40, title: "later overdue task", date: "2026-09-26" },
      ],
      today: [
        { type: "goal", id: 4, title: "first same-day goal", date: "2026-09-27" },
        { type: "goal", id: 8, title: "same-day goal", date: "2026-09-27" },
        { type: "goal", id: 10, title: "last same-day goal", date: "2026-09-27" },
        { type: "task", id: 7, title: "lower-id same-day task inserted late", date: "2026-09-27" },
        { type: "task", id: 9, title: "blocked recurring", date: "2026-09-27" },
        { type: "task", id: 20, title: "qualifying parent", date: "2026-09-27" },
        { type: "task", id: 21, title: "qualifying first subtask", date: "2026-09-27" },
        { type: "task", id: 22, title: "qualifying sequential-held subtask", date: "2026-09-27" },
      ],
      tomorrow: [{ type: "goal", id: 6, title: "tomorrow goal", date: "2026-09-28" }],
    });
    db.close();
  });

  it("uses canonical real Gregorian dates and bounded calendar addition", () => {
    for (const value of ["0001-01-01", "2000-02-29", "9999-12-31"]) expect(validCalendarDate(value)).toBe(true);
    for (const value of ["0000-01-01", "1900-02-29", "2026-2-03", "9999-13-01", "x"]) expect(validCalendarDate(value)).toBe(false);
    expect(addCalendarDays("2000-02-28", 1)).toBe("2000-02-29");
    expect(addCalendarDays("2000-02-29", 1)).toBe("2000-03-01");
    expect(addCalendarDays("0001-01-01", -1)).toBeNull();
    expect(addCalendarDays("9999-12-31", 1)).toBeNull();
  });

  it("derives different local dates at the same instant and stays correct around DST", () => {
    const instant = new Date("2026-03-29T00:30:00.000Z");
    expect(zonedLocalDate("Europe/Berlin", instant)).toBe("2026-03-29");
    expect(zonedLocalDate("America/Los_Angeles", instant)).toBe("2026-03-28");
    expect(zonedLocalDate("Europe/Berlin", new Date("2026-03-29T01:30:00.000Z"))).toBe("2026-03-29");
  });
});
