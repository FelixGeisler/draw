import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Claim-for-XP (#156, ADR-42): POST /api/achievements/:key/claim pays
// rarity-scaled XP once ever. The XP is stamped from the SERVER tier table
// (common 25 / rare 50 / super-rare 100 / ultra-rare 250 / secret-rare 500) —
// the client is never the authority — and folds into totalXp, so a claim can
// raise the level. The guard is idempotent: a second claim is a 409, and the
// stored payout does not double.

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

/** Force an achievement to the unlocked-but-unclaimed state, bypassing its
 *  real condition — this file tests the CLAIM, not the unlock. */
function seedUnlocked(key: string) {
  db.prepare("INSERT INTO achievements (key, unlocked_at) VALUES (?, ?)").run(
    key,
    new Date().toISOString(),
  );
}

async function xp(): Promise<number> {
  return (await request(app).get("/api/gamification")).body.xp as number;
}

describe("POST /api/achievements/:key/claim", () => {
  it("400s an unknown key without a write", async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM achievements").get();
    await request(app).post("/api/achievements/not_a_real_key/claim").expect(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM achievements").get()).toEqual(before);
  });

  it("400s a real key that is not unlocked yet without a write", async () => {
    // draw_10 is a genuine achievement, but nothing has unlocked it here.
    const before = db.prepare("SELECT COUNT(*) AS n FROM achievements").get();
    await request(app).post("/api/achievements/draw_10/claim").expect(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM achievements").get()).toEqual(before);
  });

  it("pays super-rare XP (100), folds it into totalXp, and levels up from zero", async () => {
    expect(await xp()).toBe(0);
    seedUnlocked("first_goal"); // super-rare

    const res = await request(app).post("/api/achievements/first_goal/claim").expect(200);
    // 0 → 100 XP crosses level 1→2, but level 2 unlocks no chain card (the
    // lowest level achievement is level_5), so nothing rides back.
    expect(res.body).toEqual({
      xpAwarded: 100,
      goldAwarded: 25,
      levelUp: true,
      newAchievements: [],
    });

    // The XP is now in the total, and the payload marks the card claimed.
    expect(await xp()).toBe(100);
    const g = (await request(app).get("/api/gamification")).body;
    expect(g.level).toBe(2);
    const card = g.achievements.find((a: { key: string }) => a.key === "first_goal");
    expect(card.claimedAt).not.toBeNull();
    expect(card.claimXp).toBe(100);
    expect(card.claimGold).toBe(25);
    expect(g.totalGold).toBe(25);
  });

  it("is idempotent: a second claim 409s and the payout does not double", async () => {
    const before = await xp();
    const goldBefore = (await request(app).get("/api/gamification")).body.totalGold;
    await request(app).post("/api/achievements/first_goal/claim").expect(409);
    expect(await xp()).toBe(before); // still 100 — no second helping
    expect((await request(app).get("/api/gamification")).body.totalGold).toBe(goldBefore);

    // Exactly one stamped payout for the key.
    const row = db
      .prepare(
        "SELECT claim_xp AS claimXp, claim_gold AS claimGold FROM achievements WHERE key = 'first_goal'",
      )
      .get() as { claimXp: number; claimGold: number };
    expect(row).toEqual({ claimXp: 100, claimGold: 25 });
  });

  it("stamps the XP from the server tier table by rarity (common pays 25, no level-up)", async () => {
    seedUnlocked("first_draw"); // common
    const res = await request(app).post("/api/achievements/first_draw/claim").expect(200);
    // 100 → 125 XP stays inside level 2 (level 2 needs ~283 XP).
    expect(res.body).toEqual({
      xpAwarded: 25,
      goldAwarded: 5,
      levelUp: false,
      newAchievements: [],
    });
    expect(await xp()).toBe(125);
  });

  it("a claim that crosses a level threshold unlocks level_N in the same call (#156 review)", async () => {
    // The regression: claim XP feeds totalXp, which drives the level metric,
    // which is the level_N chain's metric — so a level-crossing claim must
    // unlock level_5 and toast it, not leave a full-bar-but-locked card.
    // Park base XP at level 4, just under level 5 (cumulative 1703).
    const task = (
      await request(app).post("/api/tasks").send({ title: "xp ballast", categoryId: 1 })
    ).body as { id: number };
    db.prepare(
      "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, 0, 0, ?)",
    ).run(task.id, new Date().toISOString(), 1500); // 125 + 1500 = 1625 → level 4
    seedUnlocked("first_completion"); // the one completion would else ride back as fresh
    expect((await request(app).get("/api/gamification")).body.level).toBe(4);

    // draw_10000 is secret-rare (500 XP): 1625 + 500 = 2125 → level 5.
    seedUnlocked("draw_10000");
    const res = await request(app).post("/api/achievements/draw_10000/claim").expect(200);
    expect(res.body.xpAwarded).toBe(500);
    expect(res.body.goldAwarded).toBe(100);
    expect(res.body.levelUp).toBe(true);
    expect(res.body.newAchievements).toContain("level_5");

    // The level card is genuinely unlocked now — not a full-bar-but-locked ghost.
    const g = (await request(app).get("/api/gamification")).body;
    expect(g.level).toBe(5);
    const levelCard = g.achievements.find((a: { key: string }) => a.key === "level_5");
    expect(levelCard.unlockedAt).not.toBeNull();
  });

  it("leaves a pre-v18 claimed row XP-only and never backfills it", async () => {
    db.prepare(
      `INSERT INTO achievements (key, unlocked_at, claimed_at, claim_xp, claim_gold)
       VALUES ('draw_10', ?, ?, 50, NULL)`,
    ).run(new Date().toISOString(), new Date().toISOString());

    await request(app).post("/api/achievements/draw_10/claim").expect(409);
    const card = (await request(app).get("/api/gamification").expect(200)).body.achievements.find(
      (a: { key: string }) => a.key === "draw_10",
    );
    expect(card).toMatchObject({ claimXp: 50, claimGold: null });
    expect(
      db.prepare("SELECT claim_gold AS claimGold FROM achievements WHERE key = 'draw_10'").get(),
    ).toEqual({ claimGold: null });
  });

  it("rolls back claim XP, Gold, level and new unlocks when the guarded update fails", async () => {
    seedUnlocked("hours_10");
    const before = (await request(app).get("/api/gamification").expect(200)).body;
    db.exec(`CREATE TRIGGER test_claim_failure
      BEFORE UPDATE OF claimed_at, claim_xp, claim_gold ON achievements
      WHEN NEW.key = 'hours_10' BEGIN
        SELECT RAISE(ABORT, 'forced claim update failure');
      END`);
    await request(app).post("/api/achievements/hours_10/claim").expect(500);
    db.prepare("DROP TRIGGER test_claim_failure").run();

    const after = (await request(app).get("/api/gamification").expect(200)).body;
    expect(after.xp).toBe(before.xp);
    expect(after.totalGold).toBe(before.totalGold);
    expect(after.level).toBe(before.level);
    expect(after.achievements.filter((a: { unlockedAt: string | null }) => a.unlockedAt)).toHaveLength(
      before.achievements.filter((a: { unlockedAt: string | null }) => a.unlockedAt).length,
    );
    expect(
      db.prepare(
        "SELECT claimed_at AS claimedAt, claim_xp AS claimXp, claim_gold AS claimGold FROM achievements WHERE key = 'hours_10'",
      ).get(),
    ).toEqual({ claimedAt: null, claimXp: null, claimGold: null });
  });
});
