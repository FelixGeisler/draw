import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  dailyDigestCountsForDate,
  dailyDigestForDate,
  dailyOverviewForDate,
} from "../../src/services/dailyOverviewService.js";
import { addCalendarDays, validCalendarDate, zonedLocalDate } from "../../src/services/localDay.js";

function fixture() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT, due_date TEXT, status TEXT NOT NULL,
      recur_every_days INTEGER, blocked INTEGER, deferred_until TEXT, window_days TEXT, window_start TEXT, window_end TEXT,
      parent_id INTEGER, subtask_order_mode TEXT NOT NULL DEFAULT 'parallel', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT 'fixture');
    CREATE TABLE goals (id INTEGER PRIMARY KEY, title TEXT NOT NULL, outcome TEXT, target_date TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT 'fixture');
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
    const goal = db.prepare("INSERT INTO goals(id,title,target_date,status) VALUES (?,?,?,?)");
    goal.run(8, "same-day goal", "2026-09-27", "active");
    goal.run(4, "first same-day goal", "2026-09-27", "active");
    goal.run(10, "last same-day goal", "2026-09-27", "active");
    goal.run(7, "achieved goal", "2026-09-20", "achieved");
    goal.run(11, "missed goal", "2026-09-20", "missed");
    goal.run(12, "dropped goal", "2026-09-20", "dropped");
    goal.run(13, "impossible goal", "2025-02-29", "active");
    goal.run(99, "same-date overdue goal", "2026-09-25", "active");
    goal.run(14, "middle overdue goal", "2026-09-23", "active");
    goal.run(6, "tomorrow goal", "2026-09-28", "active");

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

  it("aggregates every eligible row but returns only five ordered titles and no forbidden fields", () => {
    const db = fixture();
    const task = db.prepare("INSERT INTO tasks(id,title,description,due_date,status,created_at) VALUES (?,?,?,?,?,?)");
    const goal = db.prepare("INSERT INTO goals(id,title,outcome,target_date,status,created_at) VALUES (?,?,?,?,?,?)");
    goal.run(9, "old goal", "FORBIDDEN OUTCOME", "2026-09-18", "active", "goal-9");
    task.run(999, "old task", "FORBIDDEN DESCRIPTION", "2026-09-18", "open", "task-999");
    for (let id = 1; id <= 100; id++) {
      task.run(id, `today task ${id}`, `FORBIDDEN ${id}`, "2026-09-20", "open", `task-${id}`);
    }
    goal.run(1, "tomorrow goal", "FORBIDDEN TOMORROW", "2026-09-21", "active", "goal-1");
    goal.run(2, "resolved", "FORBIDDEN RESOLVED", "2026-09-20", "achieved", "goal-2");
    task.run(200, "malformed", "FORBIDDEN MALFORMED", "2026-02-30", "open", "task-200");

    const projection = dailyDigestForDate("2026-09-20", db);
    expect(projection).toEqual({
      overdueCount: 2,
      todayCount: 100,
      tomorrowCount: 1,
      titles: ["old goal", "old task", "today task 1", "today task 2", "today task 3"],
    });
    expect(JSON.stringify(projection)).not.toContain("FORBIDDEN");
    db.close();

    const empty = fixture();
    expect(dailyDigestForDate("2026-09-20", empty)).toEqual({
      overdueCount: 0, todayCount: 0, tomorrowCount: 0, titles: [],
    });
    empty.close();
  });

  it("excludes zero, negative and JS-unsafe IDs from overview and digest projections", () => {
    const db = fixture();
    db.exec(`
      INSERT INTO tasks(id,title,due_date,status) VALUES
        (1,'safe task','2026-09-20','open'),
        (0,'zero task','2026-09-20','open'),
        (-1,'negative task','2026-09-20','open'),
        (9007199254740992,'unsafe task','2026-09-20','open');
      INSERT INTO goals(id,title,target_date,status) VALUES
        (2,'safe goal','2026-09-20','active'),
        (0,'zero goal','2026-09-20','active'),
        (-1,'negative goal','2026-09-20','active'),
        (9007199254740992,'unsafe goal','2026-09-20','active');
    `);

    expect(dailyOverviewForDate("2026-09-20", db).today.map(({ type, id }) => ({ type, id })))
      .toEqual([{ type: "goal", id: 2 }, { type: "task", id: 1 }]);
    expect(dailyDigestForDate("2026-09-20", db)).toEqual({
      overdueCount: 0,
      todayCount: 2,
      tomorrowCount: 0,
      titles: ["safe goal", "safe task"],
    });
    db.close();
  });

  it("reads zero titles for counts and no more than five after identity selection", () => {
    const db = new Database(":memory:");
    let titleReads = 0;
    db.function("observe_title", (value: string) => { titleReads += 1; return value; });
    db.exec(`
      CREATE TABLE task_source(id INTEGER PRIMARY KEY,title TEXT NOT NULL,due_date TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE goal_source(id INTEGER PRIMARY KEY,title TEXT NOT NULL,target_date TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE VIEW tasks AS SELECT id,observe_title(title) AS title,due_date,status,created_at FROM task_source;
      CREATE VIEW goals AS SELECT id,observe_title(title) AS title,target_date,status,created_at FROM goal_source;
    `);
    const insert = db.prepare("INSERT INTO task_source VALUES (?,?,?,?,?)");
    for (let id = 1; id <= 1_000; id++) insert.run(id, `private title ${id}`, "2026-09-20", "open", `created-${id}`);

    expect(dailyDigestCountsForDate("2026-09-20", db)).toEqual({
      overdueCount: 0, todayCount: 1_000, tomorrowCount: 0,
    });
    expect(titleReads).toBe(0);
    expect(dailyDigestForDate("2026-09-20", db).titles).toEqual([
      "private title 1", "private title 2", "private title 3", "private title 4", "private title 5",
    ]);
    expect(titleReads).toBe(5);
    db.close();
  });

  it("does not alias the maximum supported date to tomorrow", () => {
    const db = fixture();
    db.prepare("INSERT INTO tasks(id,title,due_date,status) VALUES (1,'last day','9999-12-31','open')").run();
    expect(dailyDigestForDate("9999-12-31", db)).toEqual({
      overdueCount: 0, todayCount: 1, tomorrowCount: 0, titles: ["last day"],
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
