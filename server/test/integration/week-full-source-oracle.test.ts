import { afterAll, describe, expect, it } from "vitest";
import request, { type Response } from "supertest";
import { createApp } from "../../src/app.js";
import { shutdownWeekProjection } from "../../src/db.js";
import { buildWeekProjection } from "../../src/schemaV23.js";
import { testDb } from "../helpers.js";

const app = createApp();

type SourceTask = { id: number; title: string; due_date: string | null; status: "open" | "done" | "archived" };
type SourceFixed = { task_id: number; starts_at: string; ends_at: string };
type SourceGoal = { id: number; title: string; target_date: string | null; status: string };
type SourceTracked = { id: number; task_id: number; started_at: string; ended_at: string | null };
type OracleSpec = {
  weekStart: string;
  timezone: string;
  dates: string[];
  midnights: string[];
  rangeStart: string;
  rangeEnd: string;
};

type OracleRecord = Record<string, unknown> & { kind: "task" | "goal" | "tracked"; id: number };

function dateAt(year: number, month: number, day: number): Date {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day);
  return value;
}
function dateText(value: Date): string {
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}
function utcSpec(weekStart: string): OracleSpec {
  const start = dateAt(Number(weekStart.slice(0, 4)), Number(weekStart.slice(5, 7)), Number(weekStart.slice(8, 10)));
  const dates = Array.from({ length: 7 }, (_, index) => {
    const value = new Date(start);
    value.setUTCDate(value.getUTCDate() + index);
    return dateText(value);
  });
  const midnights = Array.from({ length: 8 }, (_, index) => {
    const value = new Date(start);
    value.setUTCDate(value.getUTCDate() + index);
    return `${dateText(value)}T00:00:00.000Z`;
  });
  return { weekStart, timezone: "UTC", dates, midnights, rangeStart: midnights[0], rangeEnd: midnights[7] };
}

const berlinDst: OracleSpec = {
  weekStart: "2020-03-23",
  timezone: "Europe/Berlin",
  dates: ["2020-03-23", "2020-03-24", "2020-03-25", "2020-03-26", "2020-03-27", "2020-03-28", "2020-03-29"],
  midnights: [
    "2020-03-22T23:00:00.000Z", "2020-03-23T23:00:00.000Z", "2020-03-24T23:00:00.000Z",
    "2020-03-25T23:00:00.000Z", "2020-03-26T23:00:00.000Z", "2020-03-27T23:00:00.000Z",
    "2020-03-28T23:00:00.000Z", "2020-03-29T22:00:00.000Z",
  ],
  rangeStart: "2020-03-22T23:00:00.000Z",
  rangeEnd: "2020-03-29T22:00:00.000Z",
};

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const parsed = Date.parse(value);
  return year >= 1 && year <= 9999 && Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function localDate(value: string, timezone: string): string | null {
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
    timeZone: timezone, calendar: "gregory", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, "0")}-${parts.month}-${parts.day}`;
}

async function sourceOracle(spec: OracleSpec, requestNow: string): Promise<OracleRecord[]> {
  const database = await testDb();
  try {
    const tasks = database.prepare("SELECT id,title,due_date,status FROM tasks").all() as SourceTask[];
    const fixedRows = database.prepare("SELECT task_id,starts_at,ends_at FROM task_fixed_slots").all() as SourceFixed[];
    const goals = database.prepare("SELECT id,title,target_date,status FROM goals").all() as SourceGoal[];
    const trackedRows = database.prepare("SELECT id,task_id,started_at,ended_at FROM time_entries").all() as SourceTracked[];
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const fixedByTask = new Map(fixedRows.map((fixed) => [fixed.task_id, fixed]));
    const rangeStart = Date.parse(spec.rangeStart);
    const rangeEnd = Date.parse(spec.rangeEnd);
    const now = Date.parse(requestNow);
    const candidates: Array<{ tuple: [number, number, number]; record: OracleRecord }> = [];

    for (const task of tasks) {
      let fixed: Record<string, unknown> | null = null;
      let fixedAnchor: number | null = null;
      const source = fixedByTask.get(task.id);
      if (task.status !== "archived" && source && canonicalInstant(source.starts_at) && canonicalInstant(source.ends_at)) {
        const start = Date.parse(source.starts_at);
        const end = Date.parse(source.ends_at);
        if (start < rangeEnd && end > rangeStart && end > start) {
          fixedAnchor = Math.max(start, rangeStart);
          fixed = {
            startsAt: source.starts_at,
            endsAt: source.ends_at,
            contextDate: localDate(source.starts_at, spec.timezone),
          };
        }
      }
      const deadline = task.status === "open" && task.due_date !== null && spec.dates.includes(task.due_date)
        ? { date: task.due_date }
        : null;
      if (!fixed && !deadline) continue;
      const deadlineAnchor = deadline ? Date.parse(spec.midnights[spec.dates.indexOf(deadline.date)]) : null;
      const anchor = fixedAnchor !== null && deadlineAnchor !== null
        ? ((fixed?.contextDate === deadline!.date) ? fixedAnchor : Math.min(fixedAnchor, deadlineAnchor))
        : (fixedAnchor ?? deadlineAnchor!);
      candidates.push({
        tuple: [anchor, 0, task.id],
        record: {
          kind: "task", id: task.id, title: task.title, titleTruncated: false,
          status: task.status, fixed, deadline,
        },
      });
    }

    for (const goal of goals) {
      if (goal.status !== "active" || goal.target_date === null || !spec.dates.includes(goal.target_date)) continue;
      candidates.push({
        tuple: [Date.parse(spec.midnights[spec.dates.indexOf(goal.target_date)]), 1, goal.id],
        record: {
          kind: "goal", id: goal.id, title: goal.title, titleTruncated: false,
          status: "active", deadline: { date: goal.target_date },
        },
      });
    }

    for (const tracked of trackedRows) {
      const task = taskById.get(tracked.task_id);
      if (!task || !canonicalInstant(tracked.started_at)) continue;
      const start = Date.parse(tracked.started_at);
      const running = tracked.ended_at === null;
      if (!running && !canonicalInstant(tracked.ended_at)) continue;
      const end = running ? now : Date.parse(tracked.ended_at!);
      if (start >= rangeEnd || end <= rangeStart || end <= start || (running && start >= now)) continue;
      candidates.push({
        tuple: [Math.max(start, rangeStart), 2, tracked.id],
        record: {
          kind: "tracked", id: tracked.id, taskId: task.id, taskStatus: task.status,
          title: task.title, titleTruncated: false, startedAt: tracked.started_at,
          effectiveEndAt: running ? requestNow : tracked.ended_at, running,
        },
      });
    }

    candidates.sort((left, right) => left.tuple[0] - right.tuple[0] ||
      left.tuple[1] - right.tuple[1] || left.tuple[2] - right.tuple[2]);
    return candidates.map(({ record }) => record);
  } finally {
    database.close();
  }
}

async function productionPages(spec: OracleSpec) {
  const pages: Array<{ records: OracleRecord[]; requestNow: string; nextCursor: string | null }> = [];
  let cursor: string | null = null;
  do {
    const response: Response = await request(app).get(`/api/calendar/week?weekStart=${spec.weekStart}&timezone=${encodeURIComponent(spec.timezone)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).expect(200);
    pages.push(response.body);
    cursor = response.body.nextCursor;
  } while (cursor !== null);
  return {
    pages,
    requestNow: pages[0].requestNow,
    records: pages.flatMap((page) => page.records),
  };
}

async function rebuild(): Promise<void> {
  const database = await testDb();
  try {
    database.transaction(() => {
      buildWeekProjection(database);
      database.prepare("UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1").run();
    })();
  } finally {
    database.close();
  }
}

async function seedDiverseSource(): Promise<void> {
  const database = await testDb();
  try {
    const task = database.prepare("INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (?,?,1,?,?, '2019-01-01T00:00:00.000Z')");
    const fixed = database.prepare("INSERT INTO task_fixed_slots(task_id,starts_at,ends_at,entry_timezone) VALUES (?,?,?,'UTC')");
    const goal = database.prepare("INSERT INTO goals(id,title,target_date,status,created_at,resolved_at) VALUES (?,?,?,?, '2019-01-01T00:00:00.000Z',?)");
    const tracked = database.prepare("INSERT INTO time_entries(id,task_id,started_at,ended_at) VALUES (?,?,?,?)");
    database.transaction(() => {
      for (let index = 0; index < 260; index += 1) {
        const id = 100_000 + index;
        const day = berlinDst.dates[index % berlinDst.dates.length];
        if (index % 4 === 0) {
          task.run(id, `deadline-${index}`, day, "open");
        } else if (index % 4 === 1) {
          goal.run(id, `goal-${index}`, day, "active", null);
        } else if (index % 4 === 2) {
          task.run(id, `fixed-${index}`, index % 8 === 2 ? day : null, index % 12 === 2 ? "done" : "open");
          fixed.run(id, `2020-03-${String(24 + index % 4).padStart(2, "0")}T08:00:00.000Z`, `2020-03-${String(24 + index % 4).padStart(2, "0")}T09:00:00.000Z`);
        } else {
          const status = index % 12 === 3 ? "archived" : index % 12 === 7 ? "done" : "open";
          task.run(id, `tracked-${index}`, null, status);
          tracked.run(200_000 + index, id, `2020-03-${String(24 + index % 4).padStart(2, "0")}T08:00:00.000Z`, `2020-03-${String(24 + index % 4).padStart(2, "0")}T10:00:00.000Z`);
        }
      }
      task.run(101_000, "long fixed crosser", "2020-03-23", "open");
      fixed.run(101_000, "2020-03-20T00:00:00.000Z", "2020-03-24T01:00:00.000Z");
      task.run(101_001, "running crosser", null, "open");
      tracked.run(201_001, 101_001, "2020-03-20T00:00:00.000Z", null);
      task.run(101_002, "future running", null, "open");
      tracked.run(201_002, 101_002, "9999-12-20T00:00:00.000Z", null);
      goal.run(101_003, "resolved goal omitted", "2020-03-25", "achieved", "2020-03-25T12:00:00.000Z");
      for (let index = 0; index < 40; index += 1) {
        const id = 102_000 + index;
        task.run(id, `dense coarse false positive ${index}`, null, "open");
        fixed.run(id, "2020-03-22T22:00:00.000Z", "2020-03-22T23:00:00.000Z");
      }
      for (let index = 0; index < 150; index += 1) {
        task.run(103_000 + index, `sparse unrelated ${index}`, "2040-01-01", "open");
      }
    })();
  } finally {
    database.close();
  }
  await rebuild();
}

async function seedExactCount(base: number, count: number, date: string): Promise<void> {
  const database = await testDb();
  try {
    const task = database.prepare("INSERT INTO tasks(id,title,category_id,due_date,status,created_at) VALUES (?,?,1,?,'open','2020-01-01T00:00:00.000Z')");
    const goal = database.prepare("INSERT INTO goals(id,title,target_date,status,created_at) VALUES (?,?,?,'active','2020-01-01T00:00:00.000Z')");
    database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        if (index % 2 === 0) task.run(base + index, `count-task-${count}-${index}`, date);
        else goal.run(base + index, `count-goal-${count}-${index}`, date);
      }
    })();
  } finally {
    database.close();
  }
}

afterAll(async () => shutdownWeekProjection());

describe("independent full-source Week oracle", () => {
  it("matches concatenated production pages across diverse DST/deep/crosser/state/tie fixtures", async () => {
    await seedDiverseSource();
    const production = await productionPages(berlinDst);
    const oracle = await sourceOracle(berlinDst, production.requestNow);
    expect(production.records).toEqual(oracle);
    expect(production.pages.map((page) => page.records.length)).toEqual([100, 100, 62]);
    expect(production.records.slice(98, 101)).toEqual(oracle.slice(98, 101));
    const running = production.records.find((row) => row.kind === "tracked" && row.id === 201_001);
    expect(running).toMatchObject({ running: true, effectiveEndAt: production.requestNow });
    expect(production.records.some((row) => row.id === 101_003 || row.id === 201_002 ||
      (row.id >= 102_000 && row.id < 102_040))).toBe(false);
  });

  it("uses the same source scan for exact 99/100/101 candidate boundaries", async () => {
    const cases = [
      { spec: utcSpec("2035-01-01"), count: 99, base: 300_000, date: "2035-01-03" },
      { spec: utcSpec("2035-01-08"), count: 100, base: 301_000, date: "2035-01-10" },
      { spec: utcSpec("2035-01-15"), count: 101, base: 302_000, date: "2035-01-17" },
    ];
    for (const fixture of cases) await seedExactCount(fixture.base, fixture.count, fixture.date);
    for (const fixture of cases) {
      const production = await productionPages(fixture.spec);
      expect(production.records).toEqual(await sourceOracle(fixture.spec, production.requestNow));
      expect(production.records).toHaveLength(fixture.count);
      expect(production.pages.map((page) => page.records.length)).toEqual(
        fixture.count === 101 ? [100, 1] : [fixture.count],
      );
    }
  });

  it("matches the source scan at the accepted 0001 and 9999 UTC domain controls", async () => {
    await seedExactCount(400_001, 1, "0001-01-03");
    await seedExactCount(400_101, 1, "9999-12-23");
    for (const spec of [utcSpec("0001-01-01"), utcSpec("9999-12-20")]) {
      const production = await productionPages(spec);
      expect(production.records).toEqual(await sourceOracle(spec, production.requestNow));
      expect(production.records).toHaveLength(1);
    }
  });
});
