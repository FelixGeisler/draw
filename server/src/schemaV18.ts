import type Database from "better-sqlite3";

/**
 * Schema v18 contract (#263). Keep these statements byte-for-byte aligned
 * with schema.sql and the accepted issue DDL: restore validation compares the
 * resulting SQLite definitions, not merely object names.
 */
export const V18_STATEMENTS = [
  `ALTER TABLE completions
    ADD COLUMN gold_awarded INTEGER NOT NULL DEFAULT 0
    CHECK (gold_awarded >= 0)`,
  `ALTER TABLE achievements
    ADD COLUMN claim_gold INTEGER
    CHECK (claim_gold IS NULL OR claim_gold >= 0)`,
  `CREATE TABLE gold_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    ref TEXT NOT NULL CHECK (length(trim(ref)) > 0),
    created_at TEXT NOT NULL,
    UNIQUE (reason, ref)
  )`,
  `CREATE TRIGGER gold_ledger_no_replace
  BEFORE INSERT ON gold_ledger
  WHEN EXISTS (
    SELECT 1 FROM gold_ledger
    WHERE id = NEW.id OR (reason = NEW.reason AND ref = NEW.ref)
  )
  BEGIN
    SELECT RAISE(ABORT, 'gold_ledger is append-only');
  END`,
  `CREATE TRIGGER gold_ledger_no_update
  BEFORE UPDATE ON gold_ledger
  BEGIN
    SELECT RAISE(ABORT, 'gold_ledger is append-only');
  END`,
  `CREATE TRIGGER gold_ledger_no_delete
  BEFORE DELETE ON gold_ledger
  BEGIN
    SELECT RAISE(ABORT, 'gold_ledger is append-only');
  END`,
  `CREATE TABLE pack_openings (
    opening_order INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE CHECK (length(trim(ref)) > 0),
    payment TEXT NOT NULL CHECK (payment IN ('gold', 'ticket')),
    back_key TEXT NOT NULL CHECK (length(trim(back_key)) > 0),
    rarity TEXT NOT NULL
      CHECK (rarity IN ('common', 'rare', 'ultra-rare', 'secret-rare')),
    duplicate INTEGER NOT NULL CHECK (duplicate IN (0, 1)),
    secret_chance_bp INTEGER NOT NULL
      CHECK (
        secret_chance_bp BETWEEN 500 AND 1500
        AND secret_chance_bp % 50 = 0
      ),
    effective_bonus TEXT NOT NULL
      CHECK (effective_bonus IN ('none', 'freeze', 'pouch', 'ticket')),
    opened_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER pack_openings_no_replace
  BEFORE INSERT ON pack_openings
  WHEN EXISTS (
    SELECT 1 FROM pack_openings
    WHERE opening_order = NEW.opening_order OR ref = NEW.ref
  )
  BEGIN
    SELECT RAISE(ABORT, 'pack_openings are immutable');
  END`,
  `CREATE TRIGGER pack_openings_no_update
  BEFORE UPDATE ON pack_openings
  BEGIN
    SELECT RAISE(ABORT, 'pack_openings are immutable');
  END`,
  `CREATE TRIGGER pack_openings_no_delete
  BEFORE DELETE ON pack_openings
  BEGIN
    SELECT RAISE(ABORT, 'pack_openings are immutable');
  END`,
  `CREATE INDEX idx_xp_ledger_reason ON xp_ledger(reason)`,
] as const;

const expectedObjects = new Map(
  V18_STATEMENTS.filter((sql) => /^CREATE (TABLE|TRIGGER|INDEX)/.test(sql)).map((sql) => {
    const [, , name] = /^CREATE (TABLE|TRIGGER|INDEX) ([^\s(]+)/.exec(sql)!;
    return [name, sql] as const;
  }),
);

function normalized(sql: string): string {
  return sql
    .trim()
    .replace(/;$/, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),%=])\s*/g, "$1")
    .toLowerCase();
}

function objectSql(database: Database.Database, name: string): string | undefined {
  return (
    database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as
      | { sql: string }
      | undefined
  )?.sql;
}

function requireExactObject(database: Database.Database, name: string, expected: string): void {
  const actual = objectSql(database, name);
  if (!actual || normalized(actual) !== normalized(expected)) {
    throw new Error(`schema v18 contract mismatch: ${name}`);
  }
}

function requireOwnerColumn(
  database: Database.Database,
  table: "completions" | "achievements",
  column: "gold_awarded" | "claim_gold",
  expected: { notnull: number; dflt_value: string | null; clause: string },
): void {
  const row = (
    database.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[]
  ).find((entry) => entry.name === column);
  if (
    !row ||
    row.type.toUpperCase() !== "INTEGER" ||
    row.notnull !== expected.notnull ||
    row.dflt_value !== expected.dflt_value ||
    row.pk !== 0
  ) {
    throw new Error(`schema v18 contract mismatch: ${table}.${column}`);
  }
  const tableSql = objectSql(database, table);
  if (!tableSql || !normalized(tableSql).includes(normalized(expected.clause))) {
    throw new Error(`schema v18 CHECK mismatch: ${table}.${column}`);
  }
}

function expectAbort(run: () => unknown, message: string): void {
  try {
    run();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`schema v18 immutability mismatch: expected "${message}"`);
}

/** Validate the complete runtime-required v18 contract before a restore swap. */
export function validateV18Contract(database: Database.Database): void {
  requireOwnerColumn(database, "completions", "gold_awarded", {
    notnull: 1,
    dflt_value: "0",
    clause: "gold_awarded INTEGER NOT NULL DEFAULT 0 CHECK (gold_awarded >= 0)",
  });
  requireOwnerColumn(database, "achievements", "claim_gold", {
    notnull: 0,
    dflt_value: null,
    clause: "claim_gold INTEGER CHECK (claim_gold IS NULL OR claim_gold >= 0)",
  });
  for (const [name, sql] of expectedObjects) requireExactObject(database, name, sql);

  // Definition equality catches weakened DDL. These rollback-only probes also
  // prove trigger behavior with recursive_triggers left at its normal OFF.
  if (database.pragma("recursive_triggers", { simple: true }) !== 0) {
    throw new Error("schema v18 validation requires recursive_triggers=OFF");
  }
  const goldId = Number(
    (
      database.prepare("SELECT COALESCE(MAX(id), 0) + 1001 AS id FROM gold_ledger").get() as {
        id: number;
      }
    ).id,
  );
  const openingOrder = Number(
    (
      database
        .prepare("SELECT COALESCE(MAX(opening_order), 0) + 1001 AS id FROM pack_openings")
        .get() as { id: number }
    ).id,
  );
  const suffix = `${Date.now()}-${goldId}-${openingOrder}`;
  database.exec("SAVEPOINT validate_v18_contract");
  try {
    database
      .prepare(
        "INSERT INTO gold_ledger (id, amount, reason, ref, created_at) VALUES (?, 1, ?, ?, ?)",
      )
      .run(goldId, `validate:${suffix}`, `validate:${suffix}`, new Date(0).toISOString());
    expectAbort(
      () =>
        database
          .prepare(
            "INSERT OR REPLACE INTO gold_ledger (id, amount, reason, ref, created_at) VALUES (?, 2, ?, ?, ?)",
          )
          .run(goldId, `other:${suffix}`, `other:${suffix}`, new Date(0).toISOString()),
      "gold_ledger is append-only",
    );
    expectAbort(
      () =>
        database
          .prepare(
            "INSERT OR REPLACE INTO gold_ledger (amount, reason, ref, created_at) VALUES (2, ?, ?, ?)",
          )
          .run(`validate:${suffix}`, `validate:${suffix}`, new Date(0).toISOString()),
      "gold_ledger is append-only",
    );
    expectAbort(
      () => database.prepare("UPDATE gold_ledger SET amount = 2 WHERE id = ?").run(goldId),
      "gold_ledger is append-only",
    );
    expectAbort(
      () => database.prepare("DELETE FROM gold_ledger WHERE id = ?").run(goldId),
      "gold_ledger is append-only",
    );

    database
      .prepare(
        `INSERT INTO pack_openings
         (opening_order, ref, payment, back_key, rarity, duplicate, secret_chance_bp, effective_bonus, opened_at)
         VALUES (?, ?, 'gold', 'classic', 'common', 0, 500, 'none', ?)`,
      )
      .run(openingOrder, `validate:${suffix}`, new Date(0).toISOString());
    expectAbort(
      () =>
        database
          .prepare(
            `INSERT OR REPLACE INTO pack_openings
             (opening_order, ref, payment, back_key, rarity, duplicate, secret_chance_bp, effective_bonus, opened_at)
             VALUES (?, ?, 'gold', 'classic', 'common', 0, 500, 'none', ?)`,
          )
          .run(openingOrder, `other:${suffix}`, new Date(0).toISOString()),
      "pack_openings are immutable",
    );
    expectAbort(
      () =>
        database
          .prepare(
            `INSERT OR REPLACE INTO pack_openings
             (ref, payment, back_key, rarity, duplicate, secret_chance_bp, effective_bonus, opened_at)
             VALUES (?, 'gold', 'classic', 'common', 0, 500, 'none', ?)`,
          )
          .run(`validate:${suffix}`, new Date(0).toISOString()),
      "pack_openings are immutable",
    );
    expectAbort(
      () =>
        database
          .prepare("UPDATE pack_openings SET effective_bonus = 'ticket' WHERE opening_order = ?")
          .run(openingOrder),
      "pack_openings are immutable",
    );
    expectAbort(
      () => database.prepare("DELETE FROM pack_openings WHERE opening_order = ?").run(openingOrder),
      "pack_openings are immutable",
    );
  } finally {
    database.exec("ROLLBACK TO validate_v18_contract; RELEASE validate_v18_contract");
  }
}
