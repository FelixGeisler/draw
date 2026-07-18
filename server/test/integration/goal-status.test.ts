import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

// Goal resolution (#145, ADR-38): the status enum with 'missed', the clean
// 400 on unknown statuses (previously an unhandled 500 from the SQLite
// CHECK), and the resolved_at event-fact rules — set once on leaving
// 'active', kept across resends and achieved<->missed corrections, cleared
// on reactivation, untouched by non-status edits.

let app: express.Express;

beforeAll(async () => {
  app = await freshApp();
});

async function createGoal(title: string): Promise<{ id: number }> {
  const res = await request(app).post("/api/goals").send({ title }).expect(201);
  return res.body;
}

// First describe in the file ON PURPOSE: first_goal unlocks on the FIRST
// transition into 'achieved' this database ever sees, so the unlock
// assertion must own that transition.
describe("first_goal achievement (#145)", () => {
  it("unlocks on the first achieved goal, delivered on the PATCH response", async () => {
    const goal = await createGoal("The very first win");
    const res = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ status: "achieved" })
      .expect(200);
    expect(res.body.newAchievements).toEqual(["first_goal"]);

    const gamification = await request(app).get("/api/gamification").expect(200);
    const firstGoal = gamification.body.achievements.find(
      (a: { key: string }) => a.key === "first_goal",
    );
    expect(firstGoal.unlockedAt).not.toBeNull();
  });

  it("does not fire again for later achievements — the field is omitted", async () => {
    const goal = await createGoal("The second win");
    const res = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ status: "achieved" })
      .expect(200);
    expect(res.body.newAchievements).toBeUndefined();
  });
});

describe("goal status validation", () => {
  it("rejects an unknown status with a clean 400, and the goal is untouched", async () => {
    const goal = await createGoal("Validation probe");
    const res = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ status: "failed" })
      .expect(400);
    expect(res.body.error).toMatch(/status must be one of active, achieved, missed, dropped/);

    const listed = await request(app).get("/api/goals").expect(200);
    const untouched = listed.body.find((g: { id: number }) => g.id === goal.id);
    expect(untouched.status).toBe("active");
  });

  it("404s a missing goal before writing anything", async () => {
    await request(app).patch("/api/goals/99999").send({ status: "achieved" }).expect(404);
  });

  it("still 400s an empty patch", async () => {
    const goal = await createGoal("Empty patch probe");
    await request(app).patch(`/api/goals/${goal.id}`).send({}).expect(400);
  });
});

describe("resolved_at lifecycle (ADR-38)", () => {
  it("stamps the transition out of 'active' with a server-side ISO instant", async () => {
    const goal = await createGoal("Stamp me");
    const before = Date.now();
    const res = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ status: "missed" })
      .expect(200);
    const stamped = Date.parse(res.body.resolvedAt);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it("keeps the stamp verbatim across a resend and an achieved<->missed correction", async () => {
    const goal = await createGoal("Correct me");
    const first = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ status: "achieved" })
      .expect(200);
    const stamp = first.body.resolvedAt;

    const resent = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ status: "achieved" })
      .expect(200);
    expect(resent.body.resolvedAt).toBe(stamp);

    const corrected = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ status: "missed" })
      .expect(200);
    expect(corrected.body.resolvedAt).toBe(stamp);
  });

  it("clears the stamp on reactivation", async () => {
    const goal = await createGoal("Bring me back");
    await request(app).patch(`/api/goals/${goal.id}`).send({ status: "achieved" }).expect(200);
    const reactivated = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ status: "active" })
      .expect(200);
    expect(reactivated.body.status).toBe("active");
    expect(reactivated.body.resolvedAt).toBeNull();
  });

  it("leaves the stamp alone on a non-status edit", async () => {
    const goal = await createGoal("Rename me");
    const resolved = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ status: "missed" })
      .expect(200);
    const renamed = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ title: "Renamed after the fact" })
      .expect(200);
    expect(renamed.body.status).toBe("missed");
    expect(renamed.body.resolvedAt).toBe(resolved.body.resolvedAt);
  });
});

describe("list filters", () => {
  it("keeps resolved goals out of the default listing and finds them by status", async () => {
    const goal = await createGoal("Filter probe");
    await request(app).patch(`/api/goals/${goal.id}`).send({ status: "missed" }).expect(200);

    const active = await request(app).get("/api/goals").expect(200);
    expect(active.body.map((g: { id: number }) => g.id)).not.toContain(goal.id);

    const missed = await request(app).get("/api/goals?status=missed").expect(200);
    expect(missed.body.map((g: { id: number }) => g.id)).toContain(goal.id);
    for (const g of missed.body) expect(g.status).toBe("missed");

    const all = await request(app).get("/api/goals?status=all").expect(200);
    expect(all.body.map((g: { id: number }) => g.id)).toContain(goal.id);
  });
});
