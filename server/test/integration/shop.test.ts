import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// The XP shop (#230, ADR-62). What must hold: the ledger is the only place XP
// moves (purchases negative, refunds positive), a retry with the same ref is
// harmless, a full freeze bank refuses BEFORE charging, and the pull odds are
// a service-level fact pinned with an injected rng — the HTTP surface only
// promises pack shape and balance arithmetic.

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
  db.prepare("DELETE FROM xp_ledger").run();
  db.prepare("DELETE FROM completions").run();
  db.prepare("DELETE FROM streak_freezes").run();
  db.prepare("DELETE FROM settings WHERE key IN ('owned_card_backs', 'equipped_card_back')").run();
});

/** Bank XP the honest way — completion rows, the first stored source. */
function seedXp(amount: number) {
  db.prepare(
    "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, ?)",
  ).run(taskId, new Date().toISOString(), amount);
}

describe("GET /api/shop", () => {
  it("ships the catalog, balance, bank state and the always-owned classic back", async () => {
    seedXp(300);
    const res = await request(app).get("/api/shop").expect(200);
    expect(res.body).toMatchObject({
      xp: 300,
      packCost: 250,
      freezeCost: 500,
      freezesBanked: 0,
      freezeBankCap: 2,
      equipped: "classic",
    });
    const classic = res.body.backs.find((b: { key: string }) => b.key === "classic");
    expect(classic.owned).toBe(true);
    expect(res.body.backs.length).toBeGreaterThan(4);
  });
});

describe("POST /api/shop/buy — pack", () => {
  it("refuses without enough XP, before writing anything", async () => {
    seedXp(200);
    const res = await request(app).post("/api/shop/buy").send({ item: "pack", ref: "p1" });
    expect(res.status).toBe(400);
    expect((await request(app).get("/api/shop")).body.xp).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM xp_ledger").get()).toEqual({ n: 0 });
  });

  it("charges once, deals two pulls, and a replayed ref 409s without re-charging", async () => {
    seedXp(600);
    const res = await request(app).post("/api/shop/buy").send({ item: "pack", ref: "p2" });
    expect(res.status).toBe(200);
    expect(res.body.pulls).toHaveLength(2);
    const refunds = res.body.pulls.reduce(
      (sum: number, p: { refund: number }) => sum + p.refund,
      0,
    );
    expect(res.body.xp).toBe(600 - 250 + refunds);

    const retry = await request(app).post("/api/shop/buy").send({ item: "pack", ref: "p2" });
    expect(retry.status).toBe(409);
    expect((await request(app).get("/api/shop")).body.xp).toBe(600 - 250 + refunds);
  });

  it("requires a ref — a purchase with no idempotency handle is refused", async () => {
    seedXp(600);
    const res = await request(app).post("/api/shop/buy").send({ item: "pack" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/shop/buy — freeze", () => {
  it("banks a token derived from the purchase ledger row itself", async () => {
    seedXp(500);
    const res = await request(app).post("/api/shop/buy").send({ item: "freeze", ref: "f1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xp: 0, freezesBanked: 1 });
    // No streak_freezes row: the buy:freeze ledger row IS the token — writing
    // the milestone table would swallow a same-day organic earn (ADR-62).
    expect(db.prepare("SELECT COUNT(*) AS n FROM streak_freezes").get()).toEqual({ n: 0 });
  });

  it("a full bank refuses BEFORE the charge", async () => {
    seedXp(1500);
    await request(app).post("/api/shop/buy").send({ item: "freeze", ref: "f2" }).expect(200);
    await request(app).post("/api/shop/buy").send({ item: "freeze", ref: "f3" }).expect(200);
    const third = await request(app).post("/api/shop/buy").send({ item: "freeze", ref: "f4" });
    expect(third.status).toBe(400);
    expect(third.body.error).toContain("full");
    expect((await request(app).get("/api/shop")).body.xp).toBe(500); // charged exactly twice
  });

  it("a bought token does not block a same-day ORGANIC milestone earn", async () => {
    // The regression ADR-62 exists to prevent: shouldEarnFreeze reads only
    // the milestone table, so a shop purchase today must leave an organic
    // earn's INSERT path untouched.
    seedXp(500);
    await request(app).post("/api/shop/buy").send({ item: "freeze", ref: "f5" }).expect(200);
    const organic = db
      .prepare("INSERT OR IGNORE INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)")
      .run(new Date().toISOString().slice(0, 10), new Date().toISOString());
    expect(organic.changes).toBe(1);
  });
});

describe("pull mechanics (service-level, injected rng)", () => {
  it("a duplicate pull refunds instead of re-owning; new pulls grow the owned set", async () => {
    const { buyPack } = await import("../../src/services/shopService.js");
    const { totalXp } = await import("../../src/services/gamificationService.js");
    seedXp(1000);
    // rng pinned low → both pulls land on the first (lowest-roll) pool entry:
    // slot 0 owns it, slot 1 is the duplicate and refunds.
    const { pulls } = db.transaction(() => buyPack(totalXp, "svc1", new Date(), () => 0))();
    expect(pulls[0].duplicate).toBe(false);
    expect(pulls[1].duplicate).toBe(true);
    expect(pulls[1].refund).toBe(75);
    expect(pulls[0].back.key).toBe(pulls[1].back.key);

    const shop = (await request(app).get("/api/shop")).body;
    const ownedKeys = shop.backs.filter((b: { owned: boolean }) => b.owned).map((b: { key: string }) => b.key);
    expect(ownedKeys).toContain(pulls[0].back.key);
    expect(shop.xp).toBe(1000 - 250 + 75);
  });
});

describe("POST /api/shop/equip", () => {
  it("equips an owned back and refuses an unowned one", async () => {
    seedXp(1000);
    const { buyPack } = await import("../../src/services/shopService.js");
    const { totalXp } = await import("../../src/services/gamificationService.js");
    const { pulls } = db.transaction(() => buyPack(totalXp, "svc2", new Date(), () => 0))();
    const owned = pulls[0].back.key;

    const ok = await request(app).post("/api/shop/equip").send({ back: owned });
    expect(ok.status).toBe(200);
    expect(ok.body.equipped).toBe(owned);

    const bad = await request(app).post("/api/shop/equip").send({ back: "prism" });
    expect(bad.status).toBe(400);
    // Still equipped as before — a refused equip changes nothing.
    expect((await request(app).get("/api/shop")).body.equipped).toBe(owned);
  });
});
