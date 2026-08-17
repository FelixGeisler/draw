import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

// #243 command palette: GET /api/search?q= over task titles and goal titles.
// Written TEST-FIRST — this file is the endpoint's contract:
//   - q is trimmed; missing/empty q → 200 {tasks:[], goals:[]}
//   - substring match, case- AND diacritic-insensitive (Unicode NFD); the
//     LIKE wildcards % and _ typed by a user match LITERALLY
//   - tasks: archived never appear; open first, then done; cap 20 total;
//     flat shape with joined category/goal names (NOT the TASK_SELECT payload)
//   - goals: any status; cap 10; openTaskCount over non-archived tasks
//   - deck scope / work mode (ADR-57) is client-only and must not leak here
// No schema migration: derived state over stored state (section 8).

let app: express.Express;
let work: { id: number; name: string; color: string };

async function createTask(data: Record<string, unknown>): Promise<{ id: number }> {
  const res = await request(app).post("/api/tasks").send(data).expect(201);
  return res.body;
}

async function setTaskStatus(id: number, status: "open" | "done" | "archived") {
  await request(app).patch(`/api/tasks/${id}`).send({ status }).expect(200);
}

async function createGoal(title: string): Promise<{ id: number }> {
  const res = await request(app).post("/api/goals").send({ title }).expect(201);
  return res.body;
}

async function search(q?: string) {
  const req = request(app).get("/api/search");
  const res = await (q === undefined ? req : req.query({ q })).expect(200);
  return res.body as {
    tasks: {
      id: number;
      title: string;
      status: string;
      effortMinutes: number | null;
      categoryId: number;
      categoryName: string;
      categoryColor: string;
      goalId: number | null;
      goalTitle: string | null;
    }[];
    goals: { id: number; title: string; status: string; openTaskCount: number }[];
  };
}

beforeAll(async () => {
  app = await freshApp();
  const categories = await request(app).get("/api/categories").expect(200);
  work = categories.body[0]; // seeded "Work"
});

describe("GET /api/search", () => {
  it("missing, empty and whitespace-only q → 200 with empty groups", async () => {
    expect((await search()).tasks).toEqual([]);
    expect(await search()).toEqual({ tasks: [], goals: [] });
    expect(await search("")).toEqual({ tasks: [], goals: [] });
    expect(await search("   ")).toEqual({ tasks: [], goals: [] });
  });

  it("matches tasks case-insensitively on a substring and returns the flat search shape", async () => {
    const goal = await createGoal("Palette fixture goal");
    await createTask({
      title: "Quarterly Zeppelin report",
      categoryId: work.id,
      goalId: goal.id,
      effortMinutes: 25,
    });
    await createTask({ title: "zeppelin maintenance", categoryId: work.id, effortMinutes: 10 });

    const body = await search("ZePpEl");
    expect(body.tasks).toHaveLength(2);

    const linked = body.tasks.find((t) => t.title === "Quarterly Zeppelin report");
    expect(linked).toMatchObject({
      title: "Quarterly Zeppelin report",
      status: "open",
      effortMinutes: 25,
      categoryId: work.id,
      categoryName: work.name,
      categoryColor: work.color,
      goalId: goal.id,
      goalTitle: "Palette fixture goal",
    });
    // The shape is EXACTLY the contract's — no TASK_SELECT payload leaking in.
    expect(Object.keys(linked!).sort()).toEqual(
      [
        "id",
        "title",
        "status",
        "effortMinutes",
        "categoryId",
        "categoryName",
        "categoryColor",
        "goalId",
        "goalTitle",
      ].sort(),
    );

    // goal_id is nullable → LEFT JOIN semantics: goal-less tasks carry nulls.
    const loose = body.tasks.find((t) => t.title === "zeppelin maintenance");
    expect(loose).toMatchObject({ goalId: null, goalTitle: null });
  });

  it("matches goals and reports openTaskCount over non-archived tasks", async () => {
    const goal = await createGoal("Gravel garden plan");
    await createTask({ title: "weed the north plot", categoryId: work.id, goalId: goal.id });
    await createTask({ title: "weed the south plot", categoryId: work.id, goalId: goal.id });
    const done = await createTask({ title: "order weed barrier", categoryId: work.id, goalId: goal.id });
    await setTaskStatus(done.id, "done");
    const gone = await createTask({ title: "old weed sketch", categoryId: work.id, goalId: goal.id });
    await setTaskStatus(gone.id, "archived");

    const body = await search("gravel garden");
    const found = body.goals.find((g) => g.title === "Gravel garden plan");
    expect(found).toMatchObject({ id: goal.id, status: "active", openTaskCount: 2 });
    expect(Object.keys(found!).sort()).toEqual(["id", "title", "status", "openTaskCount"].sort());
  });

  it("goals of every status are searchable", async () => {
    const goal = await createGoal("Marathon dropped ambition");
    await request(app).patch(`/api/goals/${goal.id}`).send({ status: "dropped" }).expect(200);

    const body = await search("marathon");
    expect(body.goals.map((g) => g.title)).toContain("Marathon dropped ambition");
    expect(body.goals.find((g) => g.id === goal.id)!.status).toBe("dropped");
  });

  it("archived tasks never appear; done tasks are included but ordered after open ones", async () => {
    const a = await createTask({ title: "quokka alpha", categoryId: work.id });
    void a;
    const b = await createTask({ title: "quokka beta", categoryId: work.id });
    await setTaskStatus(b.id, "done");
    const c = await createTask({ title: "quokka gamma", categoryId: work.id });
    await setTaskStatus(c.id, "archived");
    await createTask({ title: "quokka delta", categoryId: work.id });

    const body = await search("quokka");
    const titles = body.tasks.map((t) => t.title);
    expect(titles).toHaveLength(3);
    expect(titles).not.toContain("quokka gamma");
    // open first, then done — the palette surfaces live work before history.
    expect(body.tasks.map((t) => t.status)).toEqual(["open", "open", "done"]);
    expect(titles.slice(0, 2).sort()).toEqual(["quokka alpha", "quokka delta"]);
    expect(titles[2]).toBe("quokka beta");
  });

  it("q is trimmed before matching", async () => {
    const body = await search("  quokka  ");
    expect(body.tasks.map((t) => t.title).sort()).toEqual([
      "quokka alpha",
      "quokka beta",
      "quokka delta",
    ]);
  });

  it("diacritics are ignored in both directions (NFD, not SQLite's ASCII-only folding)", async () => {
    await createTask({ title: "Café Zubehör bestellen", categoryId: work.id });
    await createTask({ title: "cafe corner sweep", categoryId: work.id });

    // Plain query finds the accented title…
    const plain = await search("cafe");
    expect(plain.tasks.map((t) => t.title).sort()).toEqual([
      "Café Zubehör bestellen",
      "cafe corner sweep",
    ]);
    // …and an accented query finds the plain title.
    const accented = await search("café");
    expect(accented.tasks.map((t) => t.title).sort()).toEqual([
      "Café Zubehör bestellen",
      "cafe corner sweep",
    ]);
    // Umlauts fold too (TZ/locale is Europe/Berlin — German titles are the norm).
    const umlaut = await search("zubehor");
    expect(umlaut.tasks.map((t) => t.title)).toEqual(["Café Zubehör bestellen"]);
  });

  it("% and _ typed by the user match literally, never as LIKE wildcards", async () => {
    await createTask({ title: "Progress 100% audit", categoryId: work.id });
    await createTask({ title: "under_score migration", categoryId: work.id });
    await createTask({ title: "percent free decoy", categoryId: work.id });

    // A bare % as pattern would match EVERY row; literally it matches one.
    const percent = await search("%");
    expect(percent.tasks.map((t) => t.title)).toEqual(["Progress 100% audit"]);
    expect(percent.goals).toEqual([]);

    const around = await search("0% aud");
    expect(around.tasks.map((t) => t.title)).toEqual(["Progress 100% audit"]);

    // A bare _ as pattern would match any title with one char; literally: one.
    const underscore = await search("_");
    expect(underscore.tasks.map((t) => t.title)).toEqual(["under_score migration"]);

    // "r_s" as a pattern would also match "Progress" (r-e-s); literally it
    // matches only the actual underscore title.
    const rus = await search("r_s");
    expect(rus.tasks.map((t) => t.title)).toEqual(["under_score migration"]);
  });

  it("caps results at 20 tasks (open fill the cap first) and 10 goals", async () => {
    for (let i = 1; i <= 15; i++) {
      await createTask({ title: `capstack open ${String(i).padStart(2, "0")}`, categoryId: work.id });
    }
    for (let i = 1; i <= 10; i++) {
      const t = await createTask({
        title: `capstack done ${String(i).padStart(2, "0")}`,
        categoryId: work.id,
      });
      await setTaskStatus(t.id, "done");
    }
    const body = await search("capstack");
    expect(body.tasks).toHaveLength(20);
    // All 15 open ones made it; done tasks only fill the remainder.
    expect(body.tasks.filter((t) => t.status === "open")).toHaveLength(15);
    expect(body.tasks.slice(0, 15).every((t) => t.status === "open")).toBe(true);
    expect(body.tasks.slice(15).every((t) => t.status === "done")).toBe(true);

    for (let i = 1; i <= 12; i++) {
      await createGoal(`capgoal ${String(i).padStart(2, "0")}`);
    }
    const goals = await search("capgoal");
    expect(goals.goals).toHaveLength(10);
  });

  it("subtasks are findable by title — search sees inside breakdowns", async () => {
    // GET /api/tasks hides subtasks behind their roots; the palette exists to
    // find what pages hide, so a subtask's own title must hit.
    const parent = await createTask({ title: "Umbrella parent shell", categoryId: work.id });
    await request(app)
      .post(`/api/tasks/${parent.id}/subtasks`)
      .send({ subtasks: [{ title: "nested lighthouse step", effortMinutes: 5 }] })
      .expect(201);

    const body = await search("lighthouse");
    expect(body.tasks.map((t) => t.title)).toContain("nested lighthouse step");
  });
});
