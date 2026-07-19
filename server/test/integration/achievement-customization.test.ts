import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";
import { ACHIEVEMENT_KEYS } from "../../../shared/achievementKeys.js";

// Display-only achievement customization (#177, ADR-44). PATCH
// /api/achievements/:key rewrites the title/description and toggles a hidden
// flag — metadata that gamificationState() COALESCEs onto the server default.
// DISTINCT from POST /:key/claim: nothing here touches unlock, claim, XP, rarity
// or the shared key set. A hidden achievement still unlocks and is still
// claimable — hiding is display curation, never removal (verified below).

let app: express.Express;
let db: Database.Database;

/** The current payload view of one achievement. */
async function card(key: string) {
  const g = (await request(app).get("/api/gamification")).body;
  return g.achievements.find((a: { key: string }) => a.key === key);
}

async function xp(): Promise<number> {
  return (await request(app).get("/api/gamification")).body.xp as number;
}

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

describe("PATCH /api/achievements/:key — display overrides", () => {
  // draw_100 is a LOCKED key here (nothing has drawn 100 cards): customization
  // must apply to locked keys too, so the whole flow runs on it without any
  // interference from unlock/claim.
  const KEY = "draw_100";
  const DEFAULT_TITLE = "Seasoned drawer";
  const DEFAULT_DESC = "Draw 100 cards.";

  it("defaults: an unedited achievement is not hidden and not customized", async () => {
    const c = await card(KEY);
    expect(c).toMatchObject({
      title: DEFAULT_TITLE,
      description: DEFAULT_DESC,
      hidden: false,
      customized: false,
    });
  });

  it("sets a title override and echoes the COALESCE'd achievement", async () => {
    const res = await request(app)
      .patch(`/api/achievements/${KEY}`)
      .send({ title: "My hundred" })
      .expect(200);
    // The response is the updated card — title overridden, description default.
    expect(res.body).toMatchObject({
      key: KEY,
      title: "My hundred",
      description: DEFAULT_DESC,
      hidden: false,
      customized: true,
    });
    // …and the payload agrees.
    expect(await card(KEY)).toMatchObject({
      title: "My hundred",
      description: DEFAULT_DESC,
      customized: true,
    });
  });

  it("upserts: a second PATCH sets description + hidden without dropping the title", async () => {
    await request(app)
      .patch(`/api/achievements/${KEY}`)
      .send({ description: "Hit 100 draws", hidden: true })
      .expect(200);
    expect(await card(KEY)).toMatchObject({
      title: "My hundred", // untouched — an absent field is left as-is
      description: "Hit 100 draws",
      hidden: true,
      customized: true,
    });
    // Exactly one row for the key — an upsert, not a second insert.
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM achievement_customizations WHERE key = ?")
      .get(KEY) as { n: number };
    expect(n.n).toBe(1);
  });

  it("clears just the title override with title:null — the default returns, others stay", async () => {
    await request(app).patch(`/api/achievements/${KEY}`).send({ title: null }).expect(200);
    expect(await card(KEY)).toMatchObject({
      title: DEFAULT_TITLE, // default restored
      description: "Hit 100 draws", // description override survives
      hidden: true,
      customized: true,
    });
  });

  it("normalizes a whitespace-only title to a cleared override (default restored)", async () => {
    await request(app).patch(`/api/achievements/${KEY}`).send({ title: "   " }).expect(200);
    expect(await card(KEY)).toMatchObject({ title: DEFAULT_TITLE });
  });

  it("resets to default: title:null + description:null + hidden:false clears the row entirely", async () => {
    await request(app)
      .patch(`/api/achievements/${KEY}`)
      .send({ title: null, description: null, hidden: false })
      .expect(200);
    expect(await card(KEY)).toMatchObject({
      title: DEFAULT_TITLE,
      description: DEFAULT_DESC,
      hidden: false,
      customized: false,
    });
    // An all-default result deletes the row rather than storing a no-op.
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM achievement_customizations WHERE key = ?")
      .get(KEY) as { n: number };
    expect(n.n).toBe(0);
  });

  it("saving the DEFAULT text verbatim creates no phantom override (#177 review)", async () => {
    // The inline editor seeds its inputs from the effective (here: default)
    // text, so a save that changed nothing sends the defaults back explicitly.
    // A value equal to the default is not an override — the row must not appear.
    await request(app)
      .patch(`/api/achievements/${KEY}`)
      .send({ title: DEFAULT_TITLE, description: DEFAULT_DESC })
      .expect(200);
    expect(await card(KEY)).toMatchObject({ customized: false, hidden: false });
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM achievement_customizations WHERE key = ?")
      .get(KEY) as { n: number };
    expect(n.n).toBe(0);
  });

  it("hide → un-hide with unchanged text leaves no phantom override (#177 review)", async () => {
    // Hiding sends the whole draft (default text + hidden:true); the row exists
    // only for the flag, its default-matching text folded to null.
    await request(app)
      .patch(`/api/achievements/${KEY}`)
      .send({ title: DEFAULT_TITLE, description: DEFAULT_DESC, hidden: true })
      .expect(200);
    expect(
      db
        .prepare("SELECT title, description, hidden FROM achievement_customizations WHERE key = ?")
        .get(KEY),
    ).toEqual({ title: null, description: null, hidden: 1 });
    // Un-hiding with the same default text is now all-default and not hidden —
    // the row collapses; the card is pristine again, customized:false (the bug
    // this test guards left the default frozen in as a fake override).
    await request(app)
      .patch(`/api/achievements/${KEY}`)
      .send({ title: DEFAULT_TITLE, description: DEFAULT_DESC, hidden: false })
      .expect(200);
    expect(await card(KEY)).toMatchObject({ customized: false, hidden: false });
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM achievement_customizations WHERE key = ?")
      .get(KEY) as { n: number };
    expect(n.n).toBe(0);
  });

  it("400s an unknown key", async () => {
    await request(app)
      .patch("/api/achievements/not_a_real_key")
      .send({ title: "nope" })
      .expect(400);
  });

  it("400s a non-string title and a non-boolean hidden", async () => {
    await request(app).patch(`/api/achievements/${KEY}`).send({ title: 42 }).expect(400);
    await request(app).patch(`/api/achievements/${KEY}`).send({ hidden: "yes" }).expect(400);
  });

  it("still ships exactly the shared key set after customizing — no key added, dropped or reordered", async () => {
    await request(app).patch(`/api/achievements/${KEY}`).send({ title: "renamed again" }).expect(200);
    const g = (await request(app).get("/api/gamification")).body;
    expect(g.achievements.map((a: { key: string }) => a.key)).toEqual([...ACHIEVEMENT_KEYS]);
    // Clean up so later tests see the default.
    await request(app)
      .patch(`/api/achievements/${KEY}`)
      .send({ title: null, description: null, hidden: false })
      .expect(200);
  });
});

describe("hiding is display-only — unlock, claim and XP are untouched", () => {
  const KEY = "first_completion"; // common → claim pays 25 XP

  it("a hidden achievement still unlocks, stays flagged hidden, and is still claimable", async () => {
    // Hide it while it is still LOCKED — the customization applies to a locked
    // key, and the unlock path must not care about the flag.
    await request(app).patch(`/api/achievements/${KEY}`).send({ hidden: true }).expect(200);
    expect(await card(KEY)).toMatchObject({ unlockedAt: null, hidden: true });

    const xpBefore = await xp();

    // A real completion flows through completeTask → checkAchievements, exactly
    // as it would for a visible achievement.
    const task = (
      await request(app).post("/api/tasks").send({ title: "hidden unlock", categoryId: 1, effortMinutes: 10 })
    ).body;
    const done = (await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" })).body;
    expect(done.newAchievements).toContain(KEY); // unlocked despite being hidden

    // Still in the payload, unlocked AND still flagged hidden — hiding did not
    // remove it or block the unlock.
    const unlocked = await card(KEY);
    expect(unlocked.unlockedAt).not.toBeNull();
    expect(unlocked.hidden).toBe(true);

    // And it is still claimable from its hidden state — the claim path pays the
    // rarity XP as usual.
    const claim = await request(app).post(`/api/achievements/${KEY}/claim`).expect(200);
    expect(claim.body.xpAwarded).toBe(25);

    // XP moved by the completion (10) + the claim (25) only — hiding added
    // nothing and took nothing.
    expect(await xp()).toBe(xpBefore + 10 + 25);

    // Reset so the shared serial DB is left tidy for any later reader.
    await request(app).patch(`/api/achievements/${KEY}`).send({ hidden: false }).expect(200);
  });
});
