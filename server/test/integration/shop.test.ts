import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

let app: express.Express;
let db: Database.Database;
let taskId: number;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
  taskId = Number(
    db
      .prepare("INSERT INTO tasks (title, category_id, impact, created_at) VALUES (?, 1, 3, ?)")
      .run("shop seed", new Date().toISOString()).lastInsertRowid,
  );
});

beforeEach(() => {
  db.prepare("DELETE FROM completions").run();
  db.prepare("DELETE FROM achievements").run();
  db.prepare("DELETE FROM xp_ledger").run();
  db.prepare("DELETE FROM streak_freezes").run();
  db.prepare("DELETE FROM settings WHERE key IN ('owned_card_backs', 'equipped_card_back')").run();
});

function seedCompletion(xp: number, gold: number) {
  db.prepare(
    `INSERT INTO completions
     (task_id, completed_at, was_drawn, was_warmup, xp_awarded, gold_awarded)
     VALUES (?, ?, 0, 0, ?, ?)`,
  ).run(taskId, new Date().toISOString(), xp, gold);
}

function stateSnapshot() {
  return {
    gold: db.prepare("SELECT * FROM gold_ledger ORDER BY id").all(),
    openings: db.prepare("SELECT * FROM pack_openings ORDER BY opening_order").all(),
    xp: db.prepare("SELECT * FROM xp_ledger ORDER BY id").all(),
    settings: db
      .prepare("SELECT * FROM settings WHERE key IN ('owned_card_backs', 'equipped_card_back') ORDER BY key")
      .all(),
  };
}

const exactKeys = ["gold", "freezesBanked", "freezeBankCap", "backs", "equipped"].sort();

describe("GET /api/shop — exact transitional shape", () => {
  it.each([
    { completion: 0, claim: null, ledger: 0, expected: 0 },
    { completion: 20, claim: 5, ledger: 7, expected: 32 },
    { completion: 1, claim: null, ledger: -9, expected: -8 },
  ])("returns unclamped Gold $expected with no legacy fields", async (fixture) => {
    const baseline = (
      db.prepare("SELECT COALESCE(SUM(amount), 0) AS gold FROM gold_ledger").get() as {
        gold: number;
      }
    ).gold;
    seedCompletion(999, fixture.completion);
    if (fixture.claim !== null) {
      db.prepare(
        "INSERT INTO achievements (key, unlocked_at, claimed_at, claim_xp, claim_gold) VALUES ('first_draw', ?, ?, 888, ?)",
      ).run(new Date().toISOString(), new Date().toISOString(), fixture.claim);
    }
    if (fixture.ledger !== 0) {
      db.prepare(
        "INSERT INTO gold_ledger (amount, reason, ref, created_at) VALUES (?, 'challenge', ?, ?)",
      ).run(fixture.ledger, `gold-${fixture.expected}`, new Date().toISOString());
    }

    const response = await request(app).get("/api/shop").expect(200);
    expect(Object.keys(response.body).sort()).toEqual(exactKeys);
    expect(response.body).toMatchObject({
      gold: baseline + fixture.expected,
      freezesBanked: 0,
      freezeBankCap: 2,
      equipped: "classic",
    });
    expect(response.body).not.toHaveProperty("xp");
    expect(response.body).not.toHaveProperty("packCost");
    expect(response.body).not.toHaveProperty("freezeCost");
    expect(response.body).not.toHaveProperty("tickets");
    expect(response.body.backs.find((back: { key: string }) => back.key === "classic")).toMatchObject({
      owned: true,
    });
  });

  it("preserves settings-owned collection/equipment and unknown fallback without rewriting", async () => {
    const owned = '["classic","ember","unknown-future-key"]';
    db.prepare("INSERT INTO settings (key, value) VALUES ('owned_card_backs', ?)").run(owned);
    db.prepare("INSERT INTO settings (key, value) VALUES ('equipped_card_back', 'ember')").run();
    let response = await request(app).get("/api/shop").expect(200);
    expect(response.body.equipped).toBe("ember");
    expect(response.body.backs.find((back: { key: string }) => back.key === "ember").owned).toBe(true);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'owned_card_backs'").get()).toEqual({
      value: owned,
    });

    db.prepare("UPDATE settings SET value = 'unknown' WHERE key = 'equipped_card_back'").run();
    response = await request(app).get("/api/shop").expect(200);
    expect(response.body.equipped).toBe("classic");
    expect(db.prepare("SELECT value FROM settings WHERE key = 'equipped_card_back'").get()).toEqual({
      value: "unknown",
    });
  });
});

describe("POST /api/shop/buy — disabled exact response and no writes", () => {
  it.each([
    { label: "legacy pack", send: (r: request.Test) => r.send({ item: "pack", ref: "p1" }) },
    { label: "legacy freeze", send: (r: request.Test) => r.send({ item: "freeze", ref: "f1" }) },
    { label: "malformed domain", send: (r: request.Test) => r.send({ item: 42, ref: [] }) },
    { label: "unknown parsed body", send: (r: request.Test) => r.send({ future: true }) },
    { label: "absent content type", send: (r: request.Test) => r },
    {
      label: "non-json content type",
      send: (r: request.Test) => r.set("Content-Type", "text/plain").send("legacy"),
    },
  ])("rejects $label", async ({ send }) => {
    seedCompletion(500, 0);
    const before = stateSnapshot();
    const random = vi.spyOn(Math, "random");
    try {
      const response = await send(request(app).post("/api/shop/buy")).expect(400);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).toEqual({ error: "shop purchases are unavailable" });
      expect(random).not.toHaveBeenCalled();
      expect(stateSnapshot()).toEqual(before);
    } finally {
      random.mockRestore();
    }
  });

  it("retains malformed-JSON and body-limit middleware precedence", async () => {
    const malformed = await request(app)
      .post("/api/shop/buy")
      .set("Content-Type", "application/json")
      .send('{"item":')
      .expect(400);
    expect(malformed.body).not.toEqual({ error: "shop purchases are unavailable" });

    const overLimit = await request(app)
      .post("/api/shop/buy")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(110_000) }))
      .expect(413);
    expect(overLimit.body).not.toEqual({ error: "shop purchases are unavailable" });
  });

  it("retains authentication precedence for valid parsed requests", async () => {
    const { createApp } = await import("../../src/app.js");
    const protectedApp = createApp({ password: "shop-secret" });
    const response = await request(protectedApp)
      .post("/api/shop/buy")
      .send({ item: "pack", ref: "p1" })
      .expect(401);
    expect(response.body).not.toEqual({ error: "shop purchases are unavailable" });
  });
});

describe("POST /api/shop/equip — compatibility", () => {
  it("equips an owned back, refuses an unowned one, and returns the exact shape", async () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('owned_card_backs', '[\"classic\",\"ember\"]')",
    ).run();
    const ok = await request(app).post("/api/shop/equip").send({ back: "ember" }).expect(200);
    expect(Object.keys(ok.body).sort()).toEqual(exactKeys);
    expect(ok.body.equipped).toBe("ember");

    const bad = await request(app).post("/api/shop/equip").send({ back: "prism" }).expect(400);
    expect(bad.body).toEqual({ error: "you do not own that card back" });
    expect((await request(app).get("/api/shop")).body.equipped).toBe("ember");
  });
});
