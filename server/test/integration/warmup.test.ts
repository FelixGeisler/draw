import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import type Database from "better-sqlite3";
import { freshApp, testDb } from "../helpers.js";

// Warm-up draw (#57, ADR-30): POST /api/draw/warmup deterministically deals
// the smallest eligible card as the current draw, one deal per
// `warmup_every_hours`, and the XP rules keep it below the drawn ×1.5.
// Tests share one database file-wide: the helpers below reset the internal
// warm-up/draw state between scenarios exactly because production never does.

let app: express.Express;
let db: Database.Database;

beforeAll(async () => {
  app = await freshApp();
  db = await testDb();
});

async function seedGoal(title: string): Promise<number> {
  return (await request(app).post("/api/goals").send({ title }).expect(201)).body.id as number;
}

async function seedTask(
  title: string,
  goalId: number,
  effortMinutes: number,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  return (
    await request(app)
      .post("/api/tasks")
      .send({ title, categoryId: 1, goalId, effortMinutes, ...overrides })
      .expect(201)
  ).body;
}

async function warmup(filters: Record<string, unknown> = {}, status = 200) {
  return (await request(app).post("/api/draw/warmup").send(filters).expect(status)).body;
}

/** Free the allowance and drop any current draw + marker — test plumbing. */
function resetWarmupState() {
  db.prepare(
    "DELETE FROM settings WHERE key IN ('warmup_last_dealt', 'warmup_current_draw', 'current_draw_task_id')",
  ).run();
}

/** Push past warm-up completions out of the 30-minute momentum window. */
function disarmMomentum() {
  db.prepare("UPDATE completions SET completed_at = ? WHERE was_warmup = 1").run(
    new Date(Date.now() - 2 * 3_600_000).toISOString(),
  );
}

/** Local calendar day, matching the server's local-day bucketing. */
function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe("POST /api/draw/warmup — the deterministic deal", () => {
  it("deals the minimum-effort card, persists it as the current draw, and marks it a warm-up", async () => {
    const goalId = await seedGoal("warmup happy path");
    const tiny = await seedTask("tiny", goalId, 5);
    await seedTask("bigger", goalId, 25);

    const res = await warmup({ goalId });
    expect(res.task.id).toBe(tiny.id);
    // A deal has no odds — nothing was gambled: neither probability nor
    // poolSize (whose pre-exclusion count would misstate the pick anyway).
    expect(res.probability).toBeUndefined();
    expect(res.poolSize).toBeUndefined();
    // Window floor: max(5, 15) = 15 minutes.
    expect(res.warmup).toMatchObject({ taskId: tiny.id, windowMinutes: 15 });
    // A warm-up card is handed out, not gambled (ADR-30), so it lands in the
    // draws log as was_warmup 1 and does NOT advance the draws chain (#156):
    // first_draw stays locked until a REAL draw.
    expect(res.newAchievements).not.toContain("first_draw");
    const warmupRows = db
      .prepare("SELECT COUNT(*) AS n FROM draws WHERE task_id = ? AND was_warmup = 1")
      .get(tiny.id) as { n: number };
    expect(warmupRows.n).toBe(1);

    // The deal behaves like a draw: last_drawn_at stamped…
    const row = db
      .prepare("SELECT last_drawn_at AS lastDrawnAt FROM tasks WHERE id = ?")
      .get(tiny.id) as { lastDrawnAt: string | null };
    expect(row.lastDrawnAt).toBe(res.warmup.dealtAt);

    // …and the card survives a reload with its warm-up marker (ADR-13).
    const current = (await request(app).get("/api/draw/current").expect(200)).body;
    expect(current.task.id).toBe(tiny.id);
    expect(current.warmup).toEqual(res.warmup);
  });

  it("is not a re-roll (#88): 409 while a card is revealed, dealing works after resolving it", async () => {
    // The previous deal is still the current draw.
    const blocked = await warmup({}, 409);
    expect(blocked.error).toMatch(/never replaces a draw/);

    // Resolve it (snooze wears the pointer eagerly)…
    const currentId = Number(
      (db.prepare("SELECT value FROM settings WHERE key = 'current_draw_task_id'").get() as any)
        .value,
    );
    await request(app).patch(`/api/tasks/${currentId}`).send({ blocked: true }).expect(200);
    await request(app).patch(`/api/tasks/${currentId}`).send({ blocked: false }).expect(200);

    // …but the allowance was consumed at DEAL time — no refund for discarding.
    const unavailable = await warmup({});
    expect(unavailable.task).toBeNull();
    expect(unavailable.reason).toBe("warmup_unavailable");
    expect(unavailable.nextWarmupAt).toBeTruthy();
  });

  it("GET /api/draw/warmup reports the rate limit and flips back when the window passes", async () => {
    const spent = (await request(app).get("/api/draw/warmup").expect(200)).body;
    expect(spent.available).toBe(false);
    // Default window: 8 hours after the deal.
    const last = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'warmup_last_dealt'").get() as any).value,
    );
    expect(new Date(spent.nextWarmupAt).getTime()).toBe(
      new Date(last.dealtAt).getTime() + 8 * 3_600_000,
    );

    // Backdate the deal beyond warmup_every_hours → available again.
    db.prepare("UPDATE settings SET value = ? WHERE key = 'warmup_last_dealt'").run(
      JSON.stringify({ ...last, dealtAt: new Date(Date.now() - 9 * 3_600_000).toISOString() }),
    );
    const free = (await request(app).get("/api/draw/warmup").expect(200)).body;
    expect(free).toEqual({ available: true, nextWarmupAt: null });
  });

  it("honors the warmup_every_hours setting", async () => {
    await request(app).patch("/api/settings").send({ warmup_every_hours: 2 }).expect(200);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'warmup_last_dealt'").run(
      JSON.stringify({ taskId: 1, dealtAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
    );
    expect((await request(app).get("/api/draw/warmup").expect(200)).body.available).toBe(true);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'warmup_last_dealt'").run(
      JSON.stringify({ taskId: 1, dealtAt: new Date(Date.now() - 1 * 3_600_000).toISOString() }),
    );
    expect((await request(app).get("/api/draw/warmup").expect(200)).body.available).toBe(false);
    await request(app).patch("/api/settings").send({ warmup_every_hours: 8 }).expect(200);
  });

  it("applies the category/goal filters — the smallest card OUTSIDE the filter is ignored", async () => {
    resetWarmupState();
    const otherGoal = await seedGoal("warmup filter target");
    const scoped = await seedTask("scoped 20", otherGoal, 20);
    // "tiny" (5 min) from the first goal is smaller but filtered out.
    const res = await warmup({ goalId: otherGoal });
    expect(res.task.id).toBe(scoped.id);
  });

  it("cooldown applies as exclusion: a just-dealt single-card pool answers cooling_down", async () => {
    // The previous test dealt "scoped 20" seconds ago; resolve it and free
    // the allowance — the task itself is still inside draw_cooldown_minutes.
    const goalId = (
      await request(app).get("/api/goals").expect(200)
    ).body.find((g: any) => g.title === "warmup filter target").id;
    const current = (await request(app).get("/api/draw/current").expect(200)).body;
    await request(app).patch(`/api/tasks/${current.task.id}`).send({ blocked: true }).expect(200);
    await request(app).patch(`/api/tasks/${current.task.id}`).send({ blocked: false }).expect(200);
    db.prepare("DELETE FROM settings WHERE key = 'warmup_last_dealt'").run();

    const res = await warmup({ goalId });
    expect(res.task).toBeNull();
    expect(res.reason).toBe("cooling_down");
    // A cooling pool consumed nothing.
    expect((await request(app).get("/api/draw/warmup").expect(200)).body.available).toBe(true);
  });

  it("reuses the existing empty-pool reasons: all_too_big and no_ready_tasks", async () => {
    resetWarmupState();
    const bigGoal = await seedGoal("warmup oversized");
    await seedTask("way too big", bigGoal, 999);
    expect((await warmup({ goalId: bigGoal })).reason).toBe("all_too_big");

    const emptyGoal = await seedGoal("warmup empty");
    expect((await warmup({ goalId: emptyGoal })).reason).toBe("no_ready_tasks");
  });
});

describe("warm-up XP rules (#57): never ×1.5, window ×1.25, momentum ×1.25, cap ×1.5", () => {
  it("completing the warm-up inside its window pays ×1.25, records was_warmup, and names the bonus", async () => {
    resetWarmupState();
    const goalId = await seedGoal("warmup xp window");
    const task = await seedTask("xp 20", goalId, 20); // impact 3 → base 20

    await warmup({ goalId });
    const done = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200)
    ).body;
    // round(round(20 × 3/3) × 1.25) = 25 — NOT the drawn 30, although the
    // card IS the persisted current draw.
    expect(done.xpAwarded).toBe(25);
    expect(done.goldAwarded).toBe(3);
    expect(done.bonus).toBe("warmup");

    const row = db
      .prepare("SELECT was_drawn AS wasDrawn, was_warmup AS wasWarmup FROM completions WHERE task_id = ?")
      .get(task.id) as { wasDrawn: number; wasWarmup: number };
    expect(row.wasWarmup).toBe(1);

    // Completion cleared pointer and marker together.
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'warmup_current_draw'").get()).toBeUndefined();
  });

  it("momentum: another NON-drawn task within 30 min of the warm-up completion pays ×1.25", async () => {
    const goalId = await seedGoal("momentum target");
    const other = await seedTask("momentum 20", goalId, 20);
    const done = (
      await request(app).patch(`/api/tasks/${other.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.xpAwarded).toBe(25); // round(20 × 1.25)
    expect(done.goldAwarded).toBe(3);
    expect(done.bonus).toBe("momentum");
    const row = db
      .prepare("SELECT was_warmup AS wasWarmup FROM completions WHERE task_id = ?")
      .get(other.id) as { wasWarmup: number };
    expect(row.wasWarmup).toBe(0); // momentum is not a warm-up
  });

  it("momentum combines with the drawn bonus but is CAPPED at ×1.5 — the drawn card gains nothing", async () => {
    const goalId = await seedGoal("momentum drawn cap");
    const drawnTask = await seedTask("drawn 20", goalId, 20);
    await request(app).post("/api/draw").send({ goalId }).expect(200);
    const done = (
      await request(app).patch(`/api/tasks/${drawnTask.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.xpAwarded).toBe(30); // 1.5 × 1.25 would be 37.5 — capped
    expect(done.bonus).toBeNull(); // XP is no higher than drawn alone
  });

  it("momentum expires after 30 minutes", async () => {
    disarmMomentum();
    const goalId = await seedGoal("momentum expired");
    const task = await seedTask("plain 20", goalId, 20);
    const done = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.xpAwarded).toBe(20); // plain — no ghost momentum
    expect(done.bonus).toBeNull();
  });

  it("a late warm-up (outside its window) pays ×1.0 but still counts as a warm-up completion", async () => {
    resetWarmupState();
    disarmMomentum();
    const goalId = await seedGoal("warmup late");
    const task = await seedTask("late 20", goalId, 20);
    await warmup({ goalId });

    // Backdate the deal past the 20-minute window (max(20, 15)).
    const marker = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'warmup_current_draw'").get() as any)
        .value,
    );
    expect(marker.windowMinutes).toBe(20);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'warmup_current_draw'").run(
      JSON.stringify({ ...marker, dealtAt: new Date(Date.now() - 30 * 60_000).toISOString() }),
    );

    const done = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.xpAwarded).toBe(20); // ×1.0 — and never the drawn 30
    expect(done.bonus).toBeNull();
    const row = db
      .prepare("SELECT was_warmup AS wasWarmup FROM completions WHERE task_id = ?")
      .get(task.id) as { wasWarmup: number };
    expect(row.wasWarmup).toBe(1);
  });

  it("reopening the warm-up deletes its completion and disarms momentum — no stale bonus", async () => {
    // The late warm-up above is the most recent was_warmup completion.
    const reopenTitle = "late 20";
    const tasks = (await request(app).get("/api/tasks?status=all").expect(200)).body;
    const warmupTask = tasks.find((t: any) => t.title === reopenTitle);
    await request(app).patch(`/api/tasks/${warmupTask.id}`).send({ status: "open" }).expect(200);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM completions WHERE task_id = ?").get(warmupTask.id),
    ).toEqual({ n: 0 });

    const goalId = await seedGoal("post reopen");
    const bystander = await seedTask("bystander 20", goalId, 20);
    const done = (
      await request(app).patch(`/api/tasks/${bystander.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.xpAwarded).toBe(20); // plain — momentum derives from the log
    expect(done.bonus).toBeNull();
  });

  it("a recurring warm-up's own next completion gets no momentum from itself", async () => {
    resetWarmupState();
    disarmMomentum();
    const goalId = await seedGoal("recurring warmup");
    const task = await seedTask("recurring 20", goalId, 20, { recurEveryDays: 7 });
    await warmup({ goalId });
    const first = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(first.xpAwarded).toBe(25); // in-window warm-up
    expect(first.recurring).toBe(true);

    // The task stays open (recurring); completing it again minutes later is
    // the SAME task — momentum only rewards a different one. It is also no
    // longer the current draw, and the warm-up deal's last_drawn_at stamp is
    // excluded from the 6h drawn heuristic — so this pays plain XP.
    const again = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(again.xpAwarded).toBe(20);
    expect(again.bonus).toBeNull();
  });

  it("anti-fishing: a snoozed-away warm-up card completed later never earns the drawn ×1.5", async () => {
    resetWarmupState();
    disarmMomentum();
    const goalId = await seedGoal("warmup snooze fish");
    const task = await seedTask("fish 20", goalId, 20);
    await warmup({ goalId });

    // Snooze the dealt card: pointer + marker cleared eagerly (ADR-17)…
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ deferredUntil: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);
    expect((await request(app).get("/api/draw/current").expect(200)).body).toBeNull();

    // …then complete it from the Tasks page while last_drawn_at (stamped by
    // the DEAL, not a gamble) is still within the 6h drawn heuristic.
    const done = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: "done" }).expect(200)
    ).body;
    expect(done.xpAwarded).toBe(20); // plain — neither ×1.5 nor ×1.25
    expect(done.bonus).toBeNull();
    const row = db
      .prepare("SELECT was_drawn AS wasDrawn, was_warmup AS wasWarmup FROM completions WHERE task_id = ?")
      .get(task.id) as { wasDrawn: number; wasWarmup: number };
    expect(row.wasDrawn).toBe(0);
    expect(row.wasWarmup).toBe(0);
  });

  it("a regular draw overwrites the warm-up marker with its pointer", async () => {
    resetWarmupState();
    const goalId = await seedGoal("marker overwrite");
    await seedTask("small 5", goalId, 5);
    const bigger = await seedTask("big 25", goalId, 25);
    await warmup({ goalId });

    // Redraw via the API (the UI hides the deck while a card is revealed —
    // MCP/API callers can still do this, and it must not leak the marker).
    // Scope to a one-card pool so the roulette is deterministic.
    const soloGoal = await seedGoal("marker overwrite solo");
    await request(app)
      .patch(`/api/tasks/${bigger.id}`)
      .send({ goalId: soloGoal })
      .expect(200);
    const redraw = (await request(app).post("/api/draw").send({ goalId: soloGoal }).expect(200))
      .body;
    expect(redraw.task.id).toBe(bigger.id);

    const current = (await request(app).get("/api/draw/current").expect(200)).body;
    expect(current.task.id).toBe(bigger.id);
    expect(current.warmup).toBeUndefined(); // marker died with the old pointer
  });

  it("surfaces a warm-up completion as NOT drawn — an impact-5 deal mints no holo and no '(drawn)' label", async () => {
    resetWarmupState();
    disarmMomentum();
    const goalId = await seedGoal("warmup trophy plain");
    const five = await seedTask("warmup five star", goalId, 20, { impact: 5 });
    await warmup({ goalId });
    await request(app).patch(`/api/tasks/${five.id}`).send({ status: "done" }).expect(200);

    // The row keeps both raw facts — the card WAS the current draw, and it
    // got there by deal, not gamble…
    const row = db
      .prepare(
        "SELECT was_drawn AS wasDrawn, was_warmup AS wasWarmup FROM completions WHERE task_id = ?",
      )
      .get(five.id) as { wasDrawn: number; wasWarmup: number };
    expect(row).toEqual({ wasDrawn: 1, wasWarmup: 1 });

    // …but the trophy pile derives drawn-ness as was_drawn AND NOT was_warmup
    // (ADR-30): despite impact 5, trophyRarity mints no holo and the
    // "(drawn)" label stays off — display agrees with the denied ×1.5.
    const gam = (await request(app).get("/api/gamification").expect(200)).body;
    const trophy = gam.todayCompletions.find((c: any) => c.taskId === five.id);
    expect(trophy).toMatchObject({ impact: 5, wasDrawn: 0 });

    // The History calendar (GET /api/activity) reads the same derivation.
    const today = localDay(new Date());
    const days = (
      await request(app).get(`/api/activity?from=${today}&to=${today}`).expect(200)
    ).body.days as { cards: { taskId: number; wasDrawn: boolean }[] }[];
    const card = days.flatMap((d) => d.cards).find((c) => c.taskId === five.id);
    expect(card?.wasDrawn).toBe(false);

    // Contrast: a genuinely GAMBLED impact-5 completion still reads drawn.
    const soloGoal = await seedGoal("warmup trophy holo contrast");
    const gambled = await seedTask("gambled five star", soloGoal, 20, { impact: 5 });
    await request(app).post("/api/draw").send({ goalId: soloGoal }).expect(200);
    await request(app).patch(`/api/tasks/${gambled.id}`).send({ status: "done" }).expect(200);
    const gam2 = (await request(app).get("/api/gamification").expect(200)).body;
    expect(gam2.todayCompletions.find((c: any) => c.taskId === gambled.id).wasDrawn).toBe(1);
  });
});

describe("settings hygiene (#57)", () => {
  it("hides the internal warm-up keys and exposes warmup_every_hours as PATCHable", async () => {
    const settings = (await request(app).get("/api/settings").expect(200)).body;
    expect(settings).not.toHaveProperty("warmup_current_draw");
    expect(settings).not.toHaveProperty("warmup_last_dealt");
    expect(settings).not.toHaveProperty("current_draw_task_id");
    expect(settings.warmup_every_hours).toBe("8");

    const patched = (
      await request(app).patch("/api/settings").send({ warmup_every_hours: 12 }).expect(200)
    ).body;
    expect(patched.warmup_every_hours).toBe("12");
    await request(app).patch("/api/settings").send({ warmup_every_hours: 8 }).expect(200);
  });

  // Issue #103: the setting had no validation at all — anything the body
  // carried was String()-ed into the row.
  it("rejects values that would lie about what the setting does (#103)", async () => {
    for (const value of [-1, -8, 1.5, "abc", "", null, true, [8], {}]) {
      const res = await request(app).patch("/api/settings").send({ warmup_every_hours: value });
      expect(res.status, `warmup_every_hours: ${JSON.stringify(value)}`).toBe(400);
      expect(res.body.error).toMatch(/non-negative integer/);
    }
    // A rejected key leaves the stored value alone — and takes no innocent
    // co-passenger down with it (validate-everything-before-writing-anything).
    const settings = (await request(app).get("/api/settings").expect(200)).body;
    expect(settings.warmup_every_hours).toBe("8");

    await request(app)
      .patch("/api/settings")
      .send({ warmup_every_hours: -1, max_draw_effort: 99 })
      .expect(400);
    expect((await request(app).get("/api/settings").expect(200)).body.max_draw_effort).not.toBe(
      "99",
    );
  });

  it("accepts 0 as the documented off-switch, and numeric strings (ADR-30d)", async () => {
    // 0 = "always available": the deal still cannot happen while a card
    // stands (ADR-30c), so this loosens the pacing, not the commitment. The
    // E2E suite leans on it as the sanctioned allowance reset.
    const off = (
      await request(app).patch("/api/settings").send({ warmup_every_hours: 0 }).expect(200)
    ).body;
    expect(off.warmup_every_hours).toBe("0");
    expect((await request(app).get("/api/draw/warmup").expect(200)).body.available).toBe(true);

    // A raw-HTTP resend of a stored value arrives as a string — the settings
    // rows are text, so this must not read as garbage.
    await request(app).patch("/api/settings").send({ warmup_every_hours: "6" }).expect(200);
    expect((await request(app).get("/api/settings").expect(200)).body.warmup_every_hours).toBe("6");
    await request(app).patch("/api/settings").send({ warmup_every_hours: 8 }).expect(200);
  });
});
