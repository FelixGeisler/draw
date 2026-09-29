import type Database from "better-sqlite3";
import { schemaSqlTokens } from "./schemaV18.js";
import { validateV22Contract } from "./schemaV22.js";

export const WEEK_MIN_MS = -62_135_596_800_000;
export const WEEK_MAX_MS = 253_402_300_799_999;
export const WEEK_DAY_MS = 86_400_000;
export const WEEK_MAX_DAY = 3_652_058;
export const WEEK_MAX_SAFE_ID = 9_007_199_254_740_991;
export const WEEK_PROJECTION_FORMAT = 1;
export const WEEK_FIXED_KIND = 0;
export const WEEK_TRACKED_KIND = 2;

export const WEEK_STATE_SQL = `CREATE TABLE week_access_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  projection_format INTEGER NOT NULL CHECK (projection_format = 1),
  ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
  source_generation INTEGER NOT NULL CHECK (source_generation BETWEEN 0 AND 9007199254740991),
  built_generation INTEGER NOT NULL CHECK (built_generation BETWEEN 0 AND 9007199254740991),
  CHECK (built_generation <= source_generation),
  CHECK (ready = 0 OR built_generation = source_generation)
) WITHOUT ROWID`;

export const WEEK_STATE_INITIAL_SQL = `INSERT INTO week_access_state(singleton, projection_format, ready, source_generation, built_generation)
VALUES (1, 1, 0, 0, 0)`;

export const WEEK_ACCESS_SQL = `CREATE TABLE week_interval_access (
  index_id INTEGER PRIMARY KEY CHECK (typeof(index_id) = 'integer' AND index_id BETWEEN 1 AND 9007199254740991),
  source_kind INTEGER NOT NULL CHECK (source_kind IN (0, 2)),
  source_id INTEGER NOT NULL CHECK (typeof(source_id) = 'integer' AND source_id BETWEEN 1 AND 9007199254740991),
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
    CHECK (typeof(task_id) = 'integer' AND task_id BETWEEN 1 AND 9007199254740991),
  start_ms INTEGER NOT NULL
    CHECK (typeof(start_ms) = 'integer' AND start_ms BETWEEN -62135596800000 AND 253402300799999),
  end_ms INTEGER
    CHECK (end_ms IS NULL OR (typeof(end_ms) = 'integer' AND end_ms BETWEEN -62135596800000 AND 253402300799999 AND end_ms > start_ms)),
  start_day INTEGER NOT NULL
    CHECK (typeof(start_day) = 'integer' AND start_day BETWEEN 0 AND 3652058),
  end_day INTEGER NOT NULL
    CHECK (typeof(end_day) = 'integer' AND end_day BETWEEN 0 AND 3652058),
  CHECK ((source_kind = 0 AND source_id = task_id AND end_ms IS NOT NULL) OR source_kind = 2),
  CHECK (start_day = (start_ms + 62135596800000) / 86400000),
  CHECK ((end_ms IS NULL AND source_kind = 2 AND end_day = 3652058) OR
         (end_ms IS NOT NULL AND end_day = (end_ms - 1 + 62135596800000) / 86400000)),
  CHECK (end_day >= start_day)
)`;

export const WEEK_ACCESS_INDEX_SQL = `CREATE UNIQUE INDEX week_interval_access_source_uq
  ON week_interval_access(source_kind, source_id)`;

export const WEEK_RTREE_SQL = `CREATE VIRTUAL TABLE week_interval_rtree
  USING rtree_i32(index_id, start_day, end_day)`;

export const WEEK_TRIGGER_SQL = [
`CREATE TRIGGER week_task_fixed_slots_ai_dirty
AFTER INSERT ON task_fixed_slots
BEGIN
  UPDATE week_access_state
  SET source_generation = source_generation + 1, ready = 0
  WHERE singleton = 1;
END`,
`CREATE TRIGGER week_task_fixed_slots_au_dirty
AFTER UPDATE OF task_id, starts_at, ends_at ON task_fixed_slots
BEGIN
  UPDATE week_access_state
  SET source_generation = source_generation + 1, ready = 0
  WHERE singleton = 1;
END`,
`CREATE TRIGGER week_task_fixed_slots_ad_dirty_delete
AFTER DELETE ON task_fixed_slots
BEGIN
  UPDATE week_access_state
  SET source_generation = source_generation + 1, ready = 0
  WHERE singleton = 1;
  DELETE FROM week_interval_access
  WHERE source_kind = 0 AND source_id = OLD.task_id;
END`,
`CREATE TRIGGER week_time_entries_ai_dirty
AFTER INSERT ON time_entries
BEGIN
  UPDATE week_access_state
  SET source_generation = source_generation + 1, ready = 0
  WHERE singleton = 1;
END`,
`CREATE TRIGGER week_time_entries_au_dirty
AFTER UPDATE OF id, task_id, started_at, ended_at ON time_entries
BEGIN
  UPDATE week_access_state
  SET source_generation = source_generation + 1, ready = 0
  WHERE singleton = 1;
END`,
`CREATE TRIGGER week_time_entries_ad_dirty_delete
AFTER DELETE ON time_entries
BEGIN
  UPDATE week_access_state
  SET source_generation = source_generation + 1, ready = 0
  WHERE singleton = 1;
  DELETE FROM week_interval_access
  WHERE source_kind = 2 AND source_id = OLD.id;
END`,
`CREATE TRIGGER week_interval_access_ai_rtree
AFTER INSERT ON week_interval_access
BEGIN
  INSERT INTO week_interval_rtree(index_id, start_day, end_day)
  VALUES (NEW.index_id, NEW.start_day, NEW.end_day);
END`,
`CREATE TRIGGER week_interval_access_au_rtree
AFTER UPDATE OF index_id, start_day, end_day ON week_interval_access
BEGIN
  DELETE FROM week_interval_rtree WHERE index_id = OLD.index_id;
  INSERT INTO week_interval_rtree(index_id, start_day, end_day)
  VALUES (NEW.index_id, NEW.start_day, NEW.end_day);
END`,
`CREATE TRIGGER week_interval_access_ad_rtree
AFTER DELETE ON week_interval_access
BEGIN
  DELETE FROM week_interval_rtree WHERE index_id = OLD.index_id;
END`,
] as const;

export const WEEK_SCHEMA_SQL = [
  WEEK_STATE_SQL,
  WEEK_STATE_INITIAL_SQL,
  WEEK_ACCESS_SQL,
  WEEK_ACCESS_INDEX_SQL,
  WEEK_RTREE_SQL,
  ...WEEK_TRIGGER_SQL,
] as const;

export const WEEK_PROJECTION_OBJECT_NAMES = [
  "week_task_fixed_slots_ai_dirty",
  "week_task_fixed_slots_au_dirty",
  "week_task_fixed_slots_ad_dirty_delete",
  "week_time_entries_ai_dirty",
  "week_time_entries_au_dirty",
  "week_time_entries_ad_dirty_delete",
  "week_interval_access_ai_rtree",
  "week_interval_access_au_rtree",
  "week_interval_access_ad_rtree",
  "week_interval_rtree",
  "week_interval_access",
  "week_access_state",
] as const;

const SHADOW_SQL: Readonly<Record<string, string>> = {
  week_interval_rtree_node: `CREATE TABLE "week_interval_rtree_node"(nodeno INTEGER PRIMARY KEY,data)`,
  week_interval_rtree_parent: `CREATE TABLE "week_interval_rtree_parent"(nodeno INTEGER PRIMARY KEY,parentnode)`,
  week_interval_rtree_rowid: `CREATE TABLE "week_interval_rtree_rowid"(rowid INTEGER PRIMARY KEY,nodeno)`,
};

const EXPECTED_TABLES = [
  "categories", "goals", "tasks", "task_fixed_slots", "time_entries", "completions",
  "materials", "card_art", "achievements", "draws", "streak_freezes", "xp_ledger",
  "gold_ledger", "pack_openings", "achievement_customizations", "push_subscriptions",
  "daily_digest_claims", "settings", "sqlite_sequence", "week_access_state",
  "week_interval_access", "week_interval_rtree", "week_interval_rtree_node",
  "week_interval_rtree_parent", "week_interval_rtree_rowid",
].sort();
const EXPECTED_INDEXES = [
  "idx_completions_date", "idx_goals_target_date", "idx_task_fixed_slots_range",
  "idx_tasks_due_date", "idx_tasks_parent", "idx_tasks_status", "idx_time_entries_range",
  "idx_time_entries_task", "idx_xp_ledger_reason", "week_interval_access_source_uq",
  "sqlite_autoindex_achievement_customizations_1", "sqlite_autoindex_achievements_1",
  "sqlite_autoindex_categories_1", "sqlite_autoindex_daily_digest_claims_1",
  "sqlite_autoindex_gold_ledger_1", "sqlite_autoindex_pack_openings_1",
  "sqlite_autoindex_push_subscriptions_1", "sqlite_autoindex_push_subscriptions_2",
  "sqlite_autoindex_settings_1", "sqlite_autoindex_streak_freezes_1",
  "sqlite_autoindex_xp_ledger_1",
].sort();
const EXPECTED_TRIGGERS = [
  "tasks_stamp_sort_order", "gold_ledger_no_replace", "gold_ledger_no_update",
  "gold_ledger_no_delete", "pack_openings_no_replace", "pack_openings_no_update",
  "pack_openings_no_delete", ...WEEK_TRIGGER_SQL.map((sql) => /^CREATE TRIGGER (\S+)/.exec(sql)![1]),
].sort();

export type WeekProjectionRow = {
  sourceKind: 0 | 2;
  sourceId: number;
  taskId: number;
  startMs: number;
  endMs: number | null;
  startDay: number;
  endDay: number;
};

export type WeekTimestampObserver = (value: unknown, field: string) => void;

export function parseWeekTimestamp(
  value: unknown,
  field: string,
  observer?: WeekTimestampObserver,
): number | null {
  observer?.(value, field);
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") !== 24) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < WEEK_MIN_MS || parsed > WEEK_MAX_MS) return null;
  if (new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function dayForStart(startMs: number): number {
  return Math.trunc((startMs - WEEK_MIN_MS) / WEEK_DAY_MS);
}
function dayForEnd(endMs: number | null): number {
  return endMs === null ? WEEK_MAX_DAY : Math.trunc((endMs - 1 - WEEK_MIN_MS) / WEEK_DAY_MS);
}
function safePositiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= WEEK_MAX_SAFE_ID;
}

const FIXED_CANDIDATE_SQL = `SELECT s.task_id AS sourceId, s.task_id AS taskId,
       s.starts_at AS startsAt, s.ends_at AS endsAt
FROM task_fixed_slots s JOIN tasks t ON t.id=s.task_id
WHERE s.task_id > ?
  AND typeof(s.task_id)='integer' AND s.task_id BETWEEN 1 AND 9007199254740991
  AND typeof(t.id)='integer' AND t.id BETWEEN 1 AND 9007199254740991
  AND CASE WHEN typeof(s.starts_at)='text'
           THEN CASE WHEN octet_length(s.starts_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1
  AND CASE WHEN typeof(s.ends_at)='text'
           THEN CASE WHEN octet_length(s.ends_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1
ORDER BY s.task_id LIMIT ?`;

const TRACKED_CANDIDATE_SQL = `SELECT e.id AS sourceId, e.task_id AS taskId,
       e.started_at AS startsAt, e.ended_at AS endsAt
FROM time_entries e JOIN tasks t ON t.id=e.task_id
WHERE e.id > ?
  AND typeof(e.id)='integer' AND e.id BETWEEN 1 AND 9007199254740991
  AND typeof(e.task_id)='integer' AND e.task_id BETWEEN 1 AND 9007199254740991
  AND typeof(t.id)='integer' AND t.id BETWEEN 1 AND 9007199254740991
  AND CASE WHEN typeof(e.started_at)='text'
           THEN CASE WHEN octet_length(e.started_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1
  AND (e.ended_at IS NULL OR
       CASE WHEN typeof(e.ended_at)='text'
            THEN CASE WHEN octet_length(e.ended_at)=24 THEN 1 ELSE 0 END ELSE 0 END=1)
ORDER BY e.id LIMIT ?`;

type Candidate = { sourceId: number; taskId: number; startsAt: unknown; endsAt: unknown };

function projectCandidate(
  kind: 0 | 2,
  row: Candidate,
  observer?: WeekTimestampObserver,
): WeekProjectionRow | null {
  if (!safePositiveId(row.sourceId) || !safePositiveId(row.taskId)) return null;
  const startMs = parseWeekTimestamp(row.startsAt, "start", observer);
  const endMs = row.endsAt === null ? null : parseWeekTimestamp(row.endsAt, "end", observer);
  if (startMs === null || (row.endsAt !== null && endMs === null)) return null;
  if (kind === WEEK_FIXED_KIND && (endMs === null || row.sourceId !== row.taskId)) return null;
  if (endMs !== null && endMs <= startMs) return null;
  return {
    sourceKind: kind,
    sourceId: row.sourceId,
    taskId: row.taskId,
    startMs,
    endMs,
    startDay: dayForStart(startMs),
    endDay: dayForEnd(endMs),
  };
}

export function collectWeekProjection(
  database: Database.Database,
  observer?: WeekTimestampObserver,
): WeekProjectionRow[] {
  const result: WeekProjectionRow[] = [];
  const collect = (kind: 0 | 2, sql: string) => {
    let after = 0;
    for (;;) {
      const rows = database.prepare(sql).all(after, 256) as Candidate[];
      if (rows.length === 0) break;
      for (const row of rows) {
        after = row.sourceId;
        const projected = projectCandidate(kind, row, observer);
        if (projected) result.push(projected);
      }
    }
  };
  collect(WEEK_FIXED_KIND, FIXED_CANDIDATE_SQL);
  collect(WEEK_TRACKED_KIND, TRACKED_CANDIDATE_SQL);
  return result;
}

const UPSERT_SQL = `INSERT INTO week_interval_access
  (source_kind,source_id,task_id,start_ms,end_ms,start_day,end_day)
VALUES (?,?,?,?,?,?,?)
ON CONFLICT(source_kind,source_id) DO UPDATE SET
  task_id=excluded.task_id,
  start_ms=excluded.start_ms,
  end_ms=excluded.end_ms,
  start_day=excluded.start_day,
  end_day=excluded.end_day`;

function upsertProjection(database: Database.Database, row: WeekProjectionRow): void {
  database.prepare(UPSERT_SQL).run(
    row.sourceKind, row.sourceId, row.taskId, row.startMs, row.endMs, row.startDay, row.endDay,
  );
}

function candidateByIdentity(database: Database.Database, kind: 0 | 2, id: number): Candidate | undefined {
  const base = kind === WEEK_FIXED_KIND ? FIXED_CANDIDATE_SQL : TRACKED_CANDIDATE_SQL;
  return database.prepare(`SELECT * FROM (${base.replace("ORDER BY s.task_id LIMIT ?", "ORDER BY s.task_id LIMIT ?").replace("ORDER BY e.id LIMIT ?", "ORDER BY e.id LIMIT ?")}) WHERE sourceId=?`).get(id - 1, 1, id) as Candidate | undefined;
}

export function reprojectWeekIdentity(database: Database.Database, kind: 0 | 2, id: number): void {
  if (!safePositiveId(id)) return;
  const row = candidateByIdentity(database, kind, id);
  const projected = row ? projectCandidate(kind, row) : null;
  if (projected) upsertProjection(database, projected);
  else database.prepare("DELETE FROM week_interval_access WHERE source_kind=? AND source_id=?").run(kind, id);
}

export function buildWeekProjection(database: Database.Database): void {
  database.prepare("DELETE FROM week_interval_access").run();
  for (const row of collectWeekProjection(database)) upsertProjection(database, row);
}

export function createWeekSchema(database: Database.Database): void {
  for (const statement of WEEK_SCHEMA_SQL) database.exec(statement);
}

export function dropWeekSchema(database: Database.Database): void {
  for (const name of WEEK_PROJECTION_OBJECT_NAMES.slice(0, 9)) {
    database.exec(`DROP TRIGGER ${name}`);
  }
  database.exec("DROP TABLE week_interval_rtree");
  database.exec("DROP TABLE week_interval_access");
  database.exec("DROP TABLE week_access_state");
}

/**
 * A staged imported v23 schema has already passed bounded exact preflight.
 * Its logical projection rows are nevertheless untrusted and disposable:
 * recreate every known projection object from compiled SQL and rebuild only
 * from authoritative source rows before sanitation/swap.
 */
export function resetImportedV23Projection(database: Database.Database): void {
  validateV23Structure(database);
  database.transaction(() => {
    dropWeekSchema(database);
    createWeekSchema(database);
    buildWeekProjection(database);
    validateV23Structure(database);
    validateV23Projection(database, true);
    database.prepare(
      "UPDATE week_access_state SET built_generation=source_generation,ready=1 WHERE singleton=1",
    ).run();
    validateV23Contract(database);
  })();
}

function exactSql(database: Database.Database, type: string, name: string, expected: string): void {
  const row = database.prepare("SELECT sql FROM sqlite_schema WHERE type=? AND name=?").get(type, name) as { sql: string | null } | undefined;
  if (!row?.sql || schemaSqlTokens(row.sql).join("\0") !== schemaSqlTokens(expected).join("\0")) {
    throw new Error(`schema v23 contract mismatch: ${name} DDL`);
  }
}

function names(database: Database.Database, type: string): string[] {
  return (database.prepare("SELECT name FROM sqlite_schema WHERE type=? ORDER BY name").all(type) as Array<{ name: string }>).map((row) => row.name);
}

function equal(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`schema v23 contract mismatch: ${label}`);
  }
}

export function validateV23Structure(database: Database.Database, requireVersion = true): void {
  validateV22Contract(database);
  if (requireVersion && database.pragma("user_version", { simple: true }) !== 23) {
    throw new Error("schema v23 contract mismatch: user_version");
  }
  exactSql(database, "table", "week_access_state", WEEK_STATE_SQL);
  exactSql(database, "table", "week_interval_access", WEEK_ACCESS_SQL);
  exactSql(database, "index", "week_interval_access_source_uq", WEEK_ACCESS_INDEX_SQL);
  exactSql(database, "table", "week_interval_rtree", WEEK_RTREE_SQL);
  for (const sql of WEEK_TRIGGER_SQL) {
    exactSql(database, "trigger", /^CREATE TRIGGER (\S+)/.exec(sql)![1], sql);
  }
  for (const [name, sql] of Object.entries(SHADOW_SQL)) exactSql(database, "table", name, sql);

  equal("table inventory", names(database, "table"), EXPECTED_TABLES);
  equal("index inventory", names(database, "index"), EXPECTED_INDEXES);
  equal("trigger inventory", names(database, "trigger"), EXPECTED_TRIGGERS);
  equal("view inventory", names(database, "view"), []);

  const columns = (table: string) => (database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
    .map((row) => [row.name, String(row.type).toUpperCase(), row.notnull, row.dflt_value, row.pk]);
  equal("week_access_state columns", columns("week_access_state"), [
    ["singleton", "INTEGER", 1, null, 1], ["projection_format", "INTEGER", 1, null, 0],
    ["ready", "INTEGER", 1, null, 0], ["source_generation", "INTEGER", 1, null, 0],
    ["built_generation", "INTEGER", 1, null, 0],
  ]);
  equal("week_interval_access columns", columns("week_interval_access"), [
    ["index_id", "INTEGER", 0, null, 1], ["source_kind", "INTEGER", 1, null, 0],
    ["source_id", "INTEGER", 1, null, 0], ["task_id", "INTEGER", 1, null, 0],
    ["start_ms", "INTEGER", 1, null, 0], ["end_ms", "INTEGER", 0, null, 0],
    ["start_day", "INTEGER", 1, null, 0], ["end_day", "INTEGER", 1, null, 0],
  ]);
  const indexes = database.prepare("PRAGMA index_list(week_interval_access)").all() as Array<Record<string, unknown>>;
  equal("week_interval_access index", indexes.map((row) => [row.name,row.unique,row.origin,row.partial]), [["week_interval_access_source_uq",1,"c",0]]);
  const xinfo = database.prepare("PRAGMA index_xinfo(week_interval_access_source_uq)").all() as Array<Record<string, unknown>>;
  equal("week_interval_access index order", xinfo.map((row) => [row.seqno,row.cid,row.name,row.desc,row.coll,row.key]), [
    [0,1,"source_kind",0,"BINARY",1], [1,2,"source_id",0,"BINARY",1], [2,-1,null,0,"BINARY",0],
  ]);
  const fks = database.prepare("PRAGMA foreign_key_list(week_interval_access)").all() as Array<Record<string, unknown>>;
  equal("week_interval_access foreign key", fks.map((row) => [row.id,row.seq,row.table,row.from,row.to,row.on_update,row.on_delete,row.match]), [
    [0,0,"tasks","task_id","id","NO ACTION","CASCADE","NONE"],
  ]);
}

export function validateV23Projection(database: Database.Database, allowUnready = false): void {
  const states = database.prepare("SELECT * FROM week_access_state").all() as Array<Record<string, unknown>>;
  if (states.length !== 1) throw new Error("schema v23 contract mismatch: state row count");
  const state = states[0] as { singleton: number; projection_format: number; ready: number; source_generation: number; built_generation: number };
  if (state.singleton !== 1 || state.projection_format !== 1 || ![0,1].includes(state.ready) ||
      !Number.isSafeInteger(state.source_generation) || !Number.isSafeInteger(state.built_generation) ||
      state.source_generation < 0 || state.source_generation > WEEK_MAX_SAFE_ID ||
      state.built_generation < 0 || state.built_generation > state.source_generation ||
      (!allowUnready && (state.ready !== 1 || state.built_generation !== state.source_generation)) ||
      (state.ready === 1 && state.built_generation !== state.source_generation)) {
    throw new Error("schema v23 contract mismatch: state row");
  }
  const expected = collectWeekProjection(database).map((row) => [row.sourceKind,row.sourceId,row.taskId,row.startMs,row.endMs,row.startDay,row.endDay]);
  const actual = (database.prepare(`SELECT source_kind,source_id,task_id,start_ms,end_ms,start_day,end_day
    FROM week_interval_access ORDER BY source_kind,source_id`).all() as Array<Record<string, unknown>>)
    .map((row) => [row.source_kind,row.source_id,row.task_id,row.start_ms,row.end_ms,row.start_day,row.end_day]);
  equal("source and companion equality", actual, expected);
  const companion = (database.prepare("SELECT index_id,start_day,end_day FROM week_interval_access ORDER BY index_id").all() as Array<Record<string, unknown>>)
    .map((row) => [row.index_id,row.start_day,row.end_day]);
  const rtree = (database.prepare("SELECT index_id,start_day,end_day FROM week_interval_rtree ORDER BY index_id").all() as Array<Record<string, unknown>>)
    .map((row) => [row.index_id,row.start_day,row.end_day]);
  equal("companion and RTree equality", rtree, companion);
  if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("schema v23 contract mismatch: foreign keys");
  if (database.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("schema v23 contract mismatch: integrity");
  const checked = database.prepare("SELECT rtreecheck('week_interval_rtree') AS result").get() as { result: string };
  if (checked.result !== "ok") throw new Error("schema v23 contract mismatch: RTree integrity");
}

export function validateV23Contract(
  database: Database.Database,
  options: { requireVersion?: boolean; allowUnready?: boolean } = {},
): void {
  validateV23Structure(database, options.requireVersion ?? true);
  validateV23Projection(database, options.allowUnready ?? false);
}

export interface WeekMutationToken { readonly weekMutation: unique symbol }
const mutationState = new WeakMap<object, boolean>();

export function beginWeekMutation(database: Database.Database): WeekMutationToken {
  const row = database.prepare(`SELECT ready,source_generation AS sourceGeneration,built_generation AS builtGeneration
    FROM week_access_state WHERE singleton=1`).get() as { ready: number; sourceGeneration: number; builtGeneration: number } | undefined;
  if (!row) throw new Error("week projection state is unavailable");
  const token = Object.freeze({}) as WeekMutationToken;
  mutationState.set(token, row.ready === 1 && row.sourceGeneration === row.builtGeneration);
  return token;
}

function assertToken(token: WeekMutationToken): boolean {
  const clean = mutationState.get(token);
  if (clean === undefined) throw new Error("invalid week projection mutation token");
  return clean;
}

export function maintainWeekFixed(database: Database.Database, token: WeekMutationToken, taskId: number): void {
  assertToken(token);
  reprojectWeekIdentity(database, WEEK_FIXED_KIND, taskId);
}

export function maintainWeekTracked(database: Database.Database, token: WeekMutationToken, entryIds: readonly number[]): void {
  assertToken(token);
  for (const id of new Set(entryIds)) reprojectWeekIdentity(database, WEEK_TRACKED_KIND, id);
}

export function finishWeekMutation(database: Database.Database, token: WeekMutationToken): void {
  const clean = assertToken(token);
  mutationState.delete(token);
  if (!clean) return;
  const result = database.prepare(`UPDATE week_access_state
    SET built_generation=source_generation,ready=1 WHERE singleton=1`).run();
  if (result.changes !== 1) throw new Error("week projection state finalization failed");
}
