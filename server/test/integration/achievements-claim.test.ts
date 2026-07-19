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
  it("400s an unknown key", async () => {
    await request(app).post("/api/achievements/not_a_real_key/claim").expect(400);
  });

  it("400s a real key that is not unlocked yet", async () => {
    // draw_10 is a genuine achievement, but nothing has unlocked it here.
    await request(app).post("/api/achievements/draw_10/claim").expect(400);
  });

  it("pays super-rare XP (100), folds it into totalXp, and levels up from zero", async () => {
    expect(await xp()).toBe(0);
    seedUnlocked("first_goal"); // super-rare

    const res = await request(app).post("/api/achievements/first_goal/claim").expect(200);
    expect(res.body).toEqual({ xpAwarded: 100, levelUp: true }); // 0 → 100 XP crosses level 1→2

    // The XP is now in the total, and the payload marks the card claimed.
    expect(await xp()).toBe(100);
    const g = (await request(app).get("/api/gamification")).body;
    expect(g.level).toBe(2);
    const card = g.achievements.find((a: { key: string }) => a.key === "first_goal");
    expect(card.claimedAt).not.toBeNull();
    expect(card.claimXp).toBe(100);
  });

  it("is idempotent: a second claim 409s and the payout does not double", async () => {
    const before = await xp();
    await request(app).post("/api/achievements/first_goal/claim").expect(409);
    expect(await xp()).toBe(before); // still 100 — no second helping

    // Exactly one stamped payout for the key.
    const row = db
      .prepare("SELECT claim_xp AS claimXp FROM achievements WHERE key = 'first_goal'")
      .get() as { claimXp: number };
    expect(row.claimXp).toBe(100);
  });

  it("stamps the XP from the server tier table by rarity (common pays 25, no level-up)", async () => {
    seedUnlocked("first_draw"); // common
    const res = await request(app).post("/api/achievements/first_draw/claim").expect(200);
    // 100 → 125 XP stays inside level 2 (level 2 needs ~283 XP).
    expect(res.body).toEqual({ xpAwarded: 25, levelUp: false });
    expect(await xp()).toBe(125);
  });
});
