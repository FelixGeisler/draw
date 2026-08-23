import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";
import { localDate } from "../../src/services/localDay.js";

let app: express.Express;
let db: Database.Database;
let taskId: number;
let samples: number[] = [];
let randomCalls = 0;
let immutableTriggers: { name: string; sql: string }[] = [];
let seedCounter = 0;

const random = () => {
  randomCalls += 1;
  if (samples.length === 0) throw new Error("test RNG exhausted");
  return samples.shift()!;
};

beforeAll(async () => {
  app = await freshApp({ shopRandom: random });
  db = await testDb();
  taskId = Number(
    db
      .prepare("INSERT INTO tasks (title, category_id, impact, created_at) VALUES (?, 1, 3, ?)")
      .run("shop seed", new Date().toISOString()).lastInsertRowid,
  );
  immutableTriggers = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'trigger' AND tbl_name IN ('gold_ledger', 'pack_openings')`,
    )
    .all() as { name: string; sql: string }[];
});

function resetAppendOnlyTables() {
  db.exec("DROP TRIGGER IF EXISTS test_fail_step");
  for (const trigger of immutableTriggers) db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  db.exec(
    `DELETE FROM gold_ledger;
     DELETE FROM pack_openings;
     DELETE FROM sqlite_sequence WHERE name IN ('gold_ledger', 'pack_openings');`,
  );
  for (const trigger of immutableTriggers) db.exec(trigger.sql);
}

beforeEach(() => {
  resetAppendOnlyTables();
  db.prepare("DELETE FROM completions").run();
  db.prepare("DELETE FROM achievements").run();
  db.prepare("DELETE FROM xp_ledger").run();
  db.prepare("DELETE FROM streak_freezes").run();
  db.prepare("DELETE FROM settings WHERE key IN ('owned_card_backs', 'equipped_card_back')").run();
  samples = [];
  randomCalls = 0;
  seedCounter += 1;
});

function queueSamples(...values: number[]) {
  samples.push(...values);
}

function seedCompletionGold(gold: number) {
  db.prepare(
    `INSERT INTO completions
     (task_id, completed_at, was_drawn, was_warmup, xp_awarded, gold_awarded)
     VALUES (?, ?, 0, 0, 0, ?)`,
  ).run(taskId, new Date().toISOString(), gold);
}

function seedGoldEffect(amount: number, reason = "seed") {
  db.prepare(
    "INSERT INTO gold_ledger (amount, reason, ref, created_at) VALUES (?, ?, ?, ?)",
  ).run(amount, reason, `${seedCounter}-${reason}-${Math.random()}`, new Date().toISOString());
}

interface SeedOpening {
  ref?: string;
  payment?: "gold" | "ticket";
  rarity?: "common" | "rare" | "ultra-rare" | "secret-rare";
  backKey?: string;
  duplicate?: boolean;
  chance?: number;
  bonus?: "none" | "freeze" | "pouch" | "ticket";
  openedAt?: string;
  order?: number;
}

function seedOpening(fixture: SeedOpening = {}) {
  const ref = fixture.ref ?? `seed-opening-${seedCounter}-${Math.random()}`;
  db.prepare(
    `INSERT INTO pack_openings
     (opening_order, ref, payment, back_key, rarity, duplicate, secret_chance_bp,
      effective_bonus, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fixture.order ?? null,
    ref,
    fixture.payment ?? "gold",
    fixture.backKey ?? "ember",
    fixture.rarity ?? "common",
    fixture.duplicate ? 1 : 0,
    fixture.chance ?? 500,
    fixture.bonus ?? "none",
    fixture.openedAt ?? new Date().toISOString(),
  );
  return ref;
}

function stateSnapshot() {
  return {
    gold: db.prepare("SELECT * FROM gold_ledger ORDER BY id").all(),
    openings: db.prepare("SELECT * FROM pack_openings ORDER BY opening_order").all(),
    xp: db.prepare("SELECT * FROM xp_ledger ORDER BY id").all(),
    settings: db
      .prepare(
        "SELECT * FROM settings WHERE key IN ('owned_card_backs', 'equipped_card_back') ORDER BY key",
      )
      .all(),
  };
}

const shopKeys = [
  "gold",
  "goldenTickets",
  "packCost",
  "nextSecretChanceBps",
  "freezesBanked",
  "freezeBankCap",
  "backs",
  "equipped",
].sort();
const exactCatalog = [
  ["classic", "Classic weave", "common"],
  ["ember", "Ember lattice", "common"],
  ["tide", "Tide glass", "common"],
  ["midnight", "Midnight stars", "common"],
  ["parchment", "Aged parchment", "common"],
  ["graphite", "Graphite weave", "common"],
  ["meadow", "Meadow braid", "rare"],
  ["royal", "Royal filigree", "rare"],
  ["sakura", "Sakura glass", "rare"],
  ["circuit", "Neon circuit", "rare"],
  ["frost", "Frost lattice", "rare"],
  ["aurum", "Aurum crest", "ultra-rare"],
  ["aurora", "Aurora silk", "ultra-rare"],
  ["obsidian", "Obsidian gold", "ultra-rare"],
  ["prism", "Prism foil", "secret-rare"],
] as const;

function expectOpeningShape(opening: Record<string, unknown>) {
  expect(Object.keys(opening).sort()).toEqual(
    [
      "openingOrder",
      "ref",
      "payment",
      "back",
      "duplicate",
      "appliedSecretChanceBps",
      "duplicateRefundGold",
      "bonus",
      "bonusGold",
      "openedAt",
    ].sort(),
  );
  expect(Object.keys(opening.back as object).sort()).toEqual(["key", "name", "rarity"].sort());
}

describe("GET /api/shop", () => {
  it("returns the exact snapshot shape, fixed catalog order, and no write", async () => {
    seedCompletionGold(123);
    seedOpening({ bonus: "ticket", rarity: "common" });
    const before = stateSnapshot();
    const response = await request(app).get("/api/shop").expect(200);

    expect(Object.keys(response.body).sort()).toEqual(shopKeys);
    expect(response.body).toMatchObject({
      gold: 123,
      goldenTickets: 1,
      packCost: 100,
      nextSecretChanceBps: 550,
      freezesBanked: 0,
      freezeBankCap: 2,
      equipped: "classic",
    });
    expect(
      response.body.backs.map((back: { key: string; name: string; rarity: string }) => [
        back.key,
        back.name,
        back.rarity,
      ]),
    ).toEqual(exactCatalog);
    expect(
      response.body.backs
        .filter((back: { owned: boolean }) => back.owned)
        .map((back: { key: string }) => back.key),
    ).toEqual(["classic"]);
    expect(stateSnapshot()).toEqual(before);
    expect(randomCalls).toBe(0);
  });

  it("uses immutable opening order for Secret progression and derives unclamped Tickets", async () => {
    seedOpening({ order: 1, rarity: "secret-rare", backKey: "prism", openedAt: "2030-01-02T00:00:00.000Z" });
    seedOpening({
      order: 2,
      payment: "ticket",
      rarity: "common",
      bonus: "ticket",
      openedAt: "2020-01-01T00:00:00.000Z",
    });
    seedOpening({ order: 3, payment: "ticket", rarity: "rare", openedAt: "2025-01-01T00:00:00.000Z" });

    const shop = (await request(app).get("/api/shop").expect(200)).body;
    expect(shop.nextSecretChanceBps).toBe(600);
    expect(shop.goldenTickets).toBe(-1);
  });

  it("joins ordered pack, milestone, and historical purchase Freeze earns in the unchanged cap-two fold", async () => {
    const now = new Date().toISOString();
    const today = localDate(new Date());
    seedOpening({ bonus: "freeze", openedAt: now });
    db.prepare("INSERT INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)").run(today, now);
    db.prepare(
      "INSERT INTO xp_ledger (amount, reason, ref, created_at) VALUES (0, 'buy:freeze', ?, ?)",
    ).run(`historical-join-${seedCounter}`, now);

    const shop = (await request(app).get("/api/shop").expect(200)).body;
    expect(shop.freezesBanked).toBe(2);
  });
});

describe("POST /api/shop/buy — validation and precedence", () => {
  const cases: Array<{ label: string; body: unknown; status?: number; error: string }> = [
    { label: "array", body: [], error: "body must contain only item, payment, and ref" },
    { label: "null", body: null, error: "body must contain only item, payment, and ref" },
    {
      label: "extra key",
      body: { item: "pack", payment: "gold", ref: "x", extra: true },
      error: "body must contain only item, payment, and ref",
    },
    { label: "missing item", body: { payment: "gold", ref: "x" }, error: "item must be 'pack'" },
    { label: "wrong item", body: { item: "freeze", payment: "gold", ref: "x" }, error: "item must be 'pack'" },
    { label: "missing payment", body: { item: "pack", ref: "x" }, error: "payment must be 'gold' or 'ticket'" },
    { label: "wrong payment", body: { item: "pack", payment: "xp", ref: "x" }, error: "payment must be 'gold' or 'ticket'" },
    { label: "missing ref", body: { item: "pack", payment: "gold" }, error: "ref must be a non-blank string" },
    { label: "non-string ref", body: { item: "pack", payment: "gold", ref: 1 }, error: "ref must be a non-blank string" },
    { label: "blank ref", body: { item: "pack", payment: "gold", ref: "  \t" }, error: "ref must be a non-blank string" },
  ];

  it.each(cases)("rejects $label exactly without RNG or writes", async ({ body, error }) => {
    seedCompletionGold(100);
    const before = stateSnapshot();
    const response = await request(app)
      .post("/api/shop/buy")
      .send(body as object | string | undefined)
      .expect(400);
    expect(response.body).toEqual({ error });
    expect(randomCalls).toBe(0);
    expect(stateSnapshot()).toEqual(before);
  });

  it("validates before matching an existing canonical ref", async () => {
    seedCompletionGold(100);
    queueSamples(0.1, 0, 0.5);
    await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: "same" })
      .expect(200);
    const before = stateSnapshot();
    const calls = randomCalls;
    const response = await request(app)
      .post("/api/shop/buy")
      .send({ item: "freeze", payment: "gold", ref: " same " })
      .expect(400);
    expect(response.body).toEqual({ error: "item must be 'pack'" });
    expect(randomCalls).toBe(calls);
    expect(stateSnapshot()).toEqual(before);
  });

  it("retains malformed JSON, body-limit, and authentication middleware precedence", async () => {
    const malformed = await request(app)
      .post("/api/shop/buy")
      .set("Content-Type", "application/json")
      .send('{"item":')
      .expect(400);
    expect(malformed.body).not.toEqual({ error: "body must contain only item, payment, and ref" });

    const overLimit = await request(app)
      .post("/api/shop/buy")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(110_000) }))
      .expect(413);
    expect(overLimit.body).not.toEqual({ error: "body must contain only item, payment, and ref" });

    const { createApp } = await import("../../src/app.js");
    const protectedApp = createApp({ password: "shop-secret" }, { shopRandom: random });
    const auth = await request(protectedApp)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: "auth" })
      .expect(401);
    expect(auth.body).not.toHaveProperty("opening");
    expect(randomCalls).toBe(0);
  });
});

describe("POST /api/shop/buy — exact success and replay contract", () => {
  it("trims the canonical ref, grants without equipping, and separates applied from next chance", async () => {
    seedCompletionGold(100);
    queueSamples(0.1, 0, 0.11);
    const response = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: "  Canonical-Ref  " })
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual(["opening", "shop", "replayed"].sort());
    expectOpeningShape(response.body.opening);
    expect(response.body).toMatchObject({
      replayed: false,
      opening: {
        openingOrder: 1,
        ref: "Canonical-Ref",
        payment: "gold",
        back: { key: "ember", name: "Ember lattice", rarity: "common" },
        duplicate: false,
        appliedSecretChanceBps: 500,
        duplicateRefundGold: 0,
        bonus: "ticket",
        bonusGold: 0,
      },
      shop: {
        gold: 0,
        goldenTickets: 1,
        packCost: 100,
        nextSecretChanceBps: 550,
        equipped: "classic",
      },
    });
    expect(response.body.opening.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.body.shop.backs.find((back: { key: string }) => back.key === "ember").owned).toBe(true);
    expect(randomCalls).toBe(3);
    expect(db.prepare("SELECT amount, reason, ref FROM gold_ledger").all()).toEqual([
      { amount: -100, reason: "buy:pack", ref: "Canonical-Ref" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM xp_ledger").get()).toEqual({ n: 0 });
  });

  it("replays the byte-equivalent opening with a fresh shop and no reroll, repair, or write", async () => {
    seedCompletionGold(150);
    queueSamples(0.1, 0, 0.5);
    const initial = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: "replay" })
      .expect(200);
    const openingBytes = JSON.stringify(initial.body.opening);
    const calls = randomCalls;
    seedGoldEffect(25, "external");
    db.prepare("UPDATE settings SET value = '[\"classic\"]' WHERE key = 'owned_card_backs'").run();
    const beforeReplay = stateSnapshot();

    const replay = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: " replay " })
      .expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(JSON.stringify(replay.body.opening)).toBe(openingBytes);
    expect(replay.body.shop.gold).toBe(75);
    expect(replay.body.shop.backs.find((back: { key: string }) => back.key === "ember").owned).toBe(false);
    expect(randomCalls).toBe(calls);
    expect(stateSnapshot()).toEqual(beforeReplay);
  });

  it("keeps refs case-sensitive and conflicts on changed payment", async () => {
    seedCompletionGold(200);
    queueSamples(0.1, 0, 0.5, 0.1, 0.3, 0.5);
    await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: "Case" })
      .expect(200);
    await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: "case" })
      .expect(200);
    const before = stateSnapshot();
    const calls = randomCalls;
    const conflict = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "ticket", ref: "Case" })
      .expect(409);
    expect(conflict.body).toEqual({ error: "ref was already used with a different payment" });
    expect(randomCalls).toBe(calls);
    expect(stateSnapshot()).toEqual(before);
  });
});

describe("POST /api/shop/buy — payment boundaries", () => {
  it.each([99, 0, -1])("refuses a fresh Gold payment at %s", async (gold) => {
    if (gold >= 0) seedCompletionGold(gold);
    else seedGoldEffect(gold);
    const before = stateSnapshot();
    const response = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: `gold-${gold}` })
      .expect(400);
    expect(response.body).toEqual({ error: "not enough Gold" });
    expect(randomCalls).toBe(0);
    expect(stateSnapshot()).toEqual(before);
  });

  it("succeeds at exactly 100 Gold with exactly one charge row", async () => {
    seedCompletionGold(100);
    queueSamples(0.1, 0, 0.5);
    await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: "gold-boundary" })
      .expect(200);
    expect(
      db.prepare("SELECT amount FROM gold_ledger WHERE reason = 'buy:pack' AND ref = ?").all("gold-boundary"),
    ).toEqual([{ amount: -100 }]);
  });

  it.each([0, -1])("refuses a fresh Ticket payment at derived balance %s", async (tickets) => {
    if (tickets < 0) seedOpening({ payment: "ticket" });
    const before = stateSnapshot();
    const response = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "ticket", ref: `ticket-${tickets}` })
      .expect(400);
    expect(response.body).toEqual({ error: "no Golden Ticket available" });
    expect(randomCalls).toBe(0);
    expect(stateSnapshot()).toEqual(before);
  });

  it("consumes one of one-or-more Tickets and no Gold", async () => {
    seedOpening({ bonus: "ticket" });
    seedOpening({ bonus: "ticket", rarity: "rare" });
    queueSamples(0.1, 0.3, 0.5);
    const response = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "ticket", ref: "ticket-pay" })
      .expect(200);
    expect(response.body.shop.goldenTickets).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gold_ledger").get()).toEqual({ n: 0 });
  });

  it("honors the explicit payment when both resources exist", async () => {
    seedCompletionGold(100);
    seedOpening({ bonus: "ticket" });
    queueSamples(0.1, 0, 0.5);
    const ticket = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "ticket", ref: "explicit-ticket" })
      .expect(200);
    expect(ticket.body.shop.gold).toBe(100);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gold_ledger").get()).toEqual({ n: 0 });
  });
});

describe("POST /api/shop/buy — deterministic outcomes and effects", () => {
  it.each([
    ["common", 0.1, "ember", 10],
    ["rare", 0.6, "meadow", 20],
    ["ultra-rare", 0.9, "aurum", 40],
    ["secret-rare", 0, "prism", 100],
  ] as const)("derives the %s duplicate refund", async (rarity, raritySample, backKey, refund) => {
    seedCompletionGold(100);
    db.prepare("INSERT INTO settings (key, value) VALUES ('owned_card_backs', ?)").run(
      JSON.stringify(["classic", backKey]),
    );
    queueSamples(raritySample, 0, 0.5);
    const response = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: `duplicate-${rarity}` })
      .expect(200);
    expect(response.body.opening).toMatchObject({
      back: { key: backKey, rarity },
      duplicate: true,
      duplicateRefundGold: refund,
    });
    expect(db.prepare("SELECT amount, reason FROM gold_ledger ORDER BY id").all()).toEqual([
      { amount: -100, reason: "buy:pack" },
      { amount: refund, reason: "refund:duplicate" },
    ]);
  });

  it.each([
    ["freeze", 0.01, 0],
    ["pouch", 0.06, 50],
    ["ticket", 0.11, 0],
    ["none", 0.5, 0],
  ] as const)("applies the %s bonus with its exact effect map", async (bonus, bonusSample, bonusGold) => {
    seedCompletionGold(100);
    queueSamples(0.1, 0, bonusSample);
    const response = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: `bonus-${bonus}` })
      .expect(200);
    expect(response.body.opening).toMatchObject({ bonus, bonusGold });
    const effects = db
      .prepare("SELECT amount, reason FROM gold_ledger WHERE ref = ? ORDER BY id")
      .all(`bonus-${bonus}`);
    expect(effects).toEqual(
      bonus === "pouch"
        ? [
            { amount: -100, reason: "buy:pack" },
            { amount: 50, reason: "bonus:pouch" },
          ]
        : [{ amount: -100, reason: "buy:pack" }],
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM xp_ledger").get()).toEqual({ n: 0 });
  });

  it.each([0, 1, 2])("resolves a selected Freeze at bank %s", async (bank) => {
    seedCompletionGold(100);
    const today = localDate(new Date());
    if (bank >= 1) {
      db.prepare("INSERT INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)").run(
        today,
        new Date().toISOString(),
      );
    }
    if (bank >= 2) {
      db.prepare(
        "INSERT INTO xp_ledger (amount, reason, ref, created_at) VALUES (0, 'buy:freeze', ?, ?)",
      ).run(`historical-${seedCounter}`, new Date().toISOString());
    }
    queueSamples(0.1, 0, 0.01);
    const response = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: `freeze-bank-${bank}` })
      .expect(200);
    expect(response.body.opening.bonus).toBe(bank === 2 ? "pouch" : "freeze");
    expect(response.body.opening.bonusGold).toBe(bank === 2 ? 50 : 0);
    expect(response.body.shop.freezesBanked).toBe(bank === 2 ? 2 : bank + 1);
  });

  it("preserves unknown ownership strings and never auto-equips a new grant", async () => {
    seedCompletionGold(100);
    db.prepare("INSERT INTO settings (key, value) VALUES ('owned_card_backs', ?)").run(
      JSON.stringify(["classic", "future-one", "future-two"]),
    );
    db.prepare("INSERT INTO settings (key, value) VALUES ('equipped_card_back', 'classic')").run();
    queueSamples(0.1, 0, 0.5);
    const response = await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: "preserve-unknown" })
      .expect(200);
    expect(response.body.shop.equipped).toBe("classic");
    expect(JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'owned_card_backs'").get() as { value: string }).value)).toEqual([
      "classic",
      "future-one",
      "future-two",
      "ember",
    ]);
  });

  it("normalizes malformed ownership only when persisting a new grant", async () => {
    seedCompletionGold(100);
    db.prepare("INSERT INTO settings (key, value) VALUES ('owned_card_backs', 'not-json')").run();
    queueSamples(0.1, 0, 0.5);
    await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: "normalize" })
      .expect(200);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'owned_card_backs'").get()).toEqual({
      value: '["classic","ember"]',
    });
  });
});

describe("POST /api/shop/buy — rollback", () => {
  const failures = [
    {
      step: "opening",
      prepare: () =>
        db.exec(`CREATE TEMP TRIGGER test_fail_step BEFORE INSERT ON main.pack_openings
                 BEGIN SELECT RAISE(ABORT, 'opening failed'); END`),
      owned: false,
      samples: [0.1, 0, 0.5],
    },
    {
      step: "ownership",
      prepare: () =>
        db.exec(`CREATE TEMP TRIGGER test_fail_step BEFORE INSERT ON main.settings
                 WHEN NEW.key = 'owned_card_backs'
                 BEGIN SELECT RAISE(ABORT, 'ownership failed'); END`),
      owned: false,
      samples: [0.1, 0, 0.5],
    },
    {
      step: "charge",
      prepare: () =>
        db.exec(`CREATE TEMP TRIGGER test_fail_step BEFORE INSERT ON main.gold_ledger
                 WHEN NEW.reason = 'buy:pack'
                 BEGIN SELECT RAISE(ABORT, 'charge failed'); END`),
      owned: false,
      samples: [0.1, 0, 0.5],
    },
    {
      step: "refund",
      prepare: () =>
        db.exec(`CREATE TEMP TRIGGER test_fail_step BEFORE INSERT ON main.gold_ledger
                 WHEN NEW.reason = 'refund:duplicate'
                 BEGIN SELECT RAISE(ABORT, 'refund failed'); END`),
      owned: true,
      samples: [0.1, 0, 0.5],
    },
    {
      step: "bonus",
      prepare: () =>
        db.exec(`CREATE TEMP TRIGGER test_fail_step BEFORE INSERT ON main.gold_ledger
                 WHEN NEW.reason = 'bonus:pouch'
                 BEGIN SELECT RAISE(ABORT, 'bonus failed'); END`),
      owned: false,
      samples: [0.1, 0, 0.06],
    },
  ];

  it.each(failures)("rolls back every fact when $step persistence fails", async (fixture) => {
    seedCompletionGold(100);
    if (fixture.owned) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('owned_card_backs', '[\"classic\",\"ember\"]')").run();
    }
    fixture.prepare();
    const before = stateSnapshot();
    queueSamples(...fixture.samples);
    await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: `fail-${fixture.step}` })
      .expect(500);
    expect(randomCalls).toBe(3);
    expect(stateSnapshot()).toEqual(before);
    db.exec("DROP TRIGGER test_fail_step");
  });

  it.each([0, 1, 2])("rolls back an invalid injected sample at position %s", async (position) => {
    seedCompletionGold(100);
    const values = [0.1, 0, 0.5];
    values[position] = position === 0 ? Number.NaN : 1;
    queueSamples(...values);
    const before = stateSnapshot();
    await request(app)
      .post("/api/shop/buy")
      .send({ item: "pack", payment: "gold", ref: `invalid-sample-${position}` })
      .expect(500);
    expect(randomCalls).toBe(position + 1);
    expect(stateSnapshot()).toEqual(before);
  });
});

describe("POST /api/shop/buy — sequential and concurrent serialization", () => {
  it("serializes concurrent same-ref requests into one initial response and one exact replay", async () => {
    seedCompletionGold(100);
    queueSamples(0.1, 0, 0.5);
    const [a, b] = await Promise.all([
      request(app).post("/api/shop/buy").send({ item: "pack", payment: "gold", ref: "concurrent-same" }),
      request(app).post("/api/shop/buy").send({ item: "pack", payment: "gold", ref: "concurrent-same" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    expect(a.body.opening).toEqual(b.body.opening);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pack_openings").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gold_ledger WHERE ref = 'concurrent-same'").get()).toEqual({ n: 1 });
    expect(randomCalls).toBe(3);
  });

  it("prevents concurrent Gold overspend at exactly 100", async () => {
    seedCompletionGold(100);
    queueSamples(0.1, 0, 0.5);
    const responses = await Promise.all([
      request(app).post("/api/shop/buy").send({ item: "pack", payment: "gold", ref: "gold-a" }),
      request(app).post("/api/shop/buy").send({ item: "pack", payment: "gold", ref: "gold-b" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(responses.find((response) => response.status === 400)!.body).toEqual({ error: "not enough Gold" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM pack_openings").get()).toEqual({ n: 1 });
    expect(randomCalls).toBe(3);
  });

  it("prevents concurrent Ticket overspend at exactly one Ticket", async () => {
    seedOpening({ bonus: "ticket" });
    queueSamples(0.1, 0, 0.5);
    const responses = await Promise.all([
      request(app).post("/api/shop/buy").send({ item: "pack", payment: "ticket", ref: "ticket-a" }),
      request(app).post("/api/shop/buy").send({ item: "pack", payment: "ticket", ref: "ticket-b" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(responses.find((response) => response.status === 400)!.body).toEqual({
      error: "no Golden Ticket available",
    });
    expect(randomCalls).toBe(3);
  });

  it("allocates unique increasing orders and predecessor-based Secret chance", async () => {
    seedCompletionGold(200);
    queueSamples(0.1, 0, 0.5, 0.1, 0.3, 0.5);
    const responses = await Promise.all([
      request(app).post("/api/shop/buy").send({ item: "pack", payment: "gold", ref: "ordered-a" }),
      request(app).post("/api/shop/buy").send({ item: "pack", payment: "gold", ref: "ordered-b" }),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const openings = db
      .prepare(
        "SELECT opening_order AS openingOrder, secret_chance_bp AS chance FROM pack_openings ORDER BY opening_order",
      )
      .all();
    expect(openings).toEqual([
      { openingOrder: 1, chance: 500 },
      { openingOrder: 2, chance: 550 },
    ]);
  });
});

describe("POST /api/shop/equip — compatibility", () => {
  it("equips an owned back, refuses an unowned one, and returns the new exact shop shape", async () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('owned_card_backs', '[\"classic\",\"ember\"]')",
    ).run();
    const ok = await request(app).post("/api/shop/equip").send({ back: "ember" }).expect(200);
    expect(Object.keys(ok.body).sort()).toEqual(shopKeys);
    expect(ok.body.equipped).toBe("ember");

    const bad = await request(app).post("/api/shop/equip").send({ back: "prism" }).expect(400);
    expect(bad.body).toEqual({ error: "you do not own that card back" });
    expect((await request(app).get("/api/shop")).body.equipped).toBe("ember");
  });
});
