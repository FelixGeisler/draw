import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { testDb } from "../helpers.js";

// Invariant parity for the MCP surface (issue #36): the real HTTP API on an
// ephemeral port + temp DATA_DIR (test/setup.ts), an MCP client bound over
// the SDK's in-memory transport, and NO ANTHROPIC_API_KEY anywhere. Every
// tool goes through the same Express code paths as the web UI, so XP,
// achievements, the timer invariant, and the drawability rules must hold
// identically.

let httpServer: Server;
let base: string;
let client: Client;

beforeAll(async () => {
  const { startServer } = await import("../../src/server.js");
  const { buildMcpServer } = await import("../../src/mcpServer.js");
  const { HttpApiClient } = await import("../../src/tools/httpApi.js");

  httpServer = startServer(0);
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const server = buildMcpServer(new HttpApiClient(base));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "vitest", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client?.close();
  await new Promise((resolve) => httpServer?.close(resolve));
});

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  const text = content[0]?.text ?? "";
  return {
    isError: res.isError === true,
    text,
    json: <T = Record<string, unknown>>() => JSON.parse(text) as T,
  };
}

async function restJson(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

interface TaskJson {
  id: number;
  title: string;
  impact: number;
  goalId: number | null;
  parentId: number | null;
  categoryId: number;
  dueDate: string | null;
  deferredUntil: string | null;
  blocked: boolean;
  status: string;
  subtasks?: TaskJson[];
}

// State built up across the journey (one DB per test file, tests in order).
let parentId: number;
let goalId: number;
let goalTaskId: number;
let readCh1Id: number;
let drawMeId: number;
let noteId: number;
let fileId: number;

describe("MCP tool surface (tools/list)", () => {
  it("runs with no ANTHROPIC_API_KEY configured", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("lists exactly the documented tools with honest annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "complete_task",
      "create_goal",
      "create_subtasks",
      "create_task",
      "draw_card",
      "get_settings",
      "get_stats",
      "list_categories",
      "list_goals",
      "list_materials",
      "list_tasks",
      "start_timer",
      "stop_timer",
      "update_task",
    ]);

    const readOnly = [
      "get_settings",
      "get_stats",
      "list_categories",
      "list_goals",
      "list_materials",
      "list_tasks",
    ];
    for (const t of tools) {
      expect(t.name).not.toMatch(/delete/);
      expect(t.annotations?.readOnlyHint ?? false).toBe(readOnly.includes(t.name));
      expect(t.annotations?.destructiveHint).toBe(false);
    }

    const createTask = tools.find((t) => t.name === "create_task")!;
    const props = (createTask.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["title", "categoryId", "goalId", "impact", "effortMinutes"]),
    );
    expect((createTask.inputSchema as { required?: string[] }).required).toEqual(
      expect.arrayContaining(["title", "categoryId"]),
    );

    const createGoal = tools.find((t) => t.name === "create_goal")!;
    expect(createGoal.description).toBe(
      "Create a goal: a title plus how success is measured (outcome). Tasks link to it via " +
        "goalId and their 1–5 impact rates leverage toward it — what the draw weights by (ADR-4). " +
        "A targetDate (YYYY-MM-DD) lets the goal show the daily pace the remaining work requires. " +
        "New goals start active; resolving one (achieved/missed/dropped) stays in the app.",
    );
    const createGoalSchema = createGoal.inputSchema as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    expect(Object.keys(createGoalSchema.properties)).toEqual(["title", "outcome", "targetDate"]);
    expect(createGoalSchema.required).toEqual(["title"]);
    expect(createGoalSchema.properties.title.description).toBeUndefined();
    expect(createGoalSchema.properties.outcome.description).toBe(
      "How success is measured — the goal's definition of done",
    );
    expect(createGoalSchema.properties.targetDate.description).toBe(
      "Calendar date as YYYY-MM-DD",
    );
    expect(createGoal.annotations).toEqual({
      title: "Create goal",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });

    const updateTask = tools.find((t) => t.name === "update_task")!;
    const updateSchema = updateTask.inputSchema as {
      properties: Record<string, { type?: string; anyOf?: Array<{ type?: string }> }>;
      required?: string[];
    };
    expect(updateSchema.required ?? []).not.toContain("deferredUntil");
    expect(updateSchema.required ?? []).not.toContain("blocked");
    expect(updateSchema.properties.deferredUntil.anyOf?.map((part) => part.type)).toEqual(
      expect.arrayContaining(["string", "null"]),
    );
    expect(updateSchema.properties.blocked.type).toBe("boolean");
    expect(updateTask.description).toContain(
      "{ id, deferredUntil: <future ISO datetime>, blocked: false }",
    );
    expect(updateTask.description).toContain("{ id, blocked: true }");
    expect(updateTask.description).toContain(
      "{ id, deferredUntil: <current ISO datetime>, blocked: false }",
    );
  });
});

describe("read tools", () => {
  it("list_categories returns the seeded categories", async () => {
    const res = await callTool("list_categories");
    expect(res.isError).toBe(false);
    const names = res.json<Array<{ name: string }>>().map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Work", "Study", "Household"]));
  });

  it("get_settings exposes max_draw_effort and never the API key", async () => {
    const res = await callTool("get_settings");
    const settings = res.json<Record<string, string>>();
    expect(settings.max_draw_effort).toBe("30");
    expect(JSON.stringify(settings)).not.toContain("anthropic");
  });
});

describe("create_goal", () => {
  it("creates an active goal that default list_goals returns with every supplied value", async () => {
    const supplied = {
      title: "Ship the thesis",
      outcome: "Submitted and accepted",
      targetDate: "2026-12-01",
    };
    const res = await callTool("create_goal", supplied);

    expect(res.isError).toBe(false);
    const goal = res.json<{
      id: number;
      title: string;
      outcome: string | null;
      targetDate: string | null;
      status: string;
    }>();
    expect(goal).toMatchObject({ ...supplied, status: "active" });
    expect(goal.id).toBeGreaterThan(0);

    const goals = (await callTool("list_goals")).json<typeof goal[]>();
    expect(goals.find((candidate) => candidate.id === goal.id)).toMatchObject({
      id: goal.id,
      ...supplied,
      status: "active",
    });
  });

  it("passes whitespace through and surfaces the route's exact shared-convention error", async () => {
    const res = await callTool("create_goal", { title: "   " });
    expect(res).toMatchObject({
      isError: true,
      text: "title is required (API responded 400)",
    });
  });
});

describe("create_task and ADR-4", () => {
  it("creates a plain task with the neutral default impact", async () => {
    const res = await callTool("create_task", { title: "Parent exam prep", categoryId: 1 });
    expect(res.isError).toBe(false);
    const task = res.json<TaskJson>();
    expect(task.impact).toBe(3);
    parentId = task.id;
  });

  it("rejects goal-less impact with an explanation, creating nothing", async () => {
    const res = await callTool("create_task", {
      title: "Rejected impact",
      categoryId: 1,
      impact: 5,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/goal/i);

    const tasks = (await callTool("list_tasks")).json<TaskJson[]>();
    expect(tasks.some((t) => t.title === "Rejected impact")).toBe(false);
  });

  it("persists impact when a goal is linked", async () => {
    const goal = (await restJson("POST", "/api/goals", { title: "Pass the exam" })) as {
      id: number;
    };
    goalId = goal.id;
    const res = await callTool("create_task", {
      title: "Goal task",
      categoryId: 1,
      goalId,
      impact: 5,
      effortMinutes: 10,
    });
    expect(res.isError).toBe(false);
    const task = res.json<TaskJson>();
    expect(task.impact).toBe(5);
    expect(task.goalId).toBe(goalId);
    goalTaskId = task.id;
  });
});

describe("update_task", () => {
  it("patches fields idempotently", async () => {
    const first = await callTool("update_task", { id: parentId, dueDate: "2026-08-01" });
    expect(first.isError).toBe(false);
    expect(first.json<{ task: TaskJson }>().task.dueDate).toBe("2026-08-01");

    const second = await callTool("update_task", { id: parentId, dueDate: "2026-08-01" });
    expect(second.json<{ task: TaskJson }>().task.dueDate).toBe("2026-08-01");
  });

  // Issue #65 regression: the ADR-4 gate used to be bypassable via
  // update_task — the API now enforces it on PATCH, and the tool surfaces
  // that rejection instead of silently boosting a goal-less task's weight.
  it("cannot set impact on a goal-less task", async () => {
    const res = await callTool("update_task", { id: parentId, impact: 5 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/goal/i);
    expect(res.text).toContain("ADR-4");

    const tasks = (await callTool("list_tasks")).json<TaskJson[]>();
    expect(tasks.find((t) => t.id === parentId)!.impact).toBe(3);
  });

  it("pauses and resumes through the real MCP-to-HTTP path under ADR-17", async () => {
    const goal = (await restJson("POST", "/api/goals", { title: "MCP pause parity" })) as {
      id: number;
    };
    const task = (
      await callTool("create_task", {
        title: "Pause and wake through MCP",
        categoryId: 1,
        goalId: goal.id,
        effortMinutes: 10,
      })
    ).json<TaskJson>();

    const deckIds = async () => {
      const res = await client.readResource({ uri: "draw://deck" });
      const deck = JSON.parse((res.contents[0] as { text: string }).text) as {
        candidates: Array<{ id: number }>;
      };
      return deck.candidates.map((candidate) => candidate.id);
    };
    expect(await deckIds()).toContain(task.id); // otherwise drawable

    // Timed pause from any prior state: the route, not MCP, normalizes the
    // supplied offset and the otherwise-drawable task leaves the pool.
    const timed = await callTool("update_task", {
      id: task.id,
      deferredUntil: "2099-07-20T10:00:00+02:00",
      blocked: false,
    });
    expect(timed.isError).toBe(false);
    expect(timed.json<{ task: TaskJson }>().task).toMatchObject({
      deferredUntil: "2099-07-20T08:00:00.000Z",
      blocked: false,
    });
    expect(await deckIds()).not.toContain(task.id);

    // Manual resume from the timed mode is the documented pair in one call;
    // null is deliberately not used, so the wake timestamp remains visible.
    const timedWake = new Date(Date.now() - 1_000).toISOString();
    const wokeTimed = await callTool("update_task", {
      id: task.id,
      deferredUntil: timedWake,
      blocked: false,
    });
    expect(wokeTimed.json<{ task: TaskJson }>().task).toMatchObject({
      deferredUntil: timedWake,
      blocked: false,
    });
    expect(await deckIds()).toContain(task.id);

    // The indefinite recipe needs only blocked: true. It stays out even with
    // an expired timed pause retained underneath: blocked takes precedence.
    const blocked = await callTool("update_task", { id: task.id, blocked: true });
    expect(blocked.json<{ task: TaskJson }>().task).toMatchObject({
      deferredUntil: timedWake,
      blocked: true,
    });
    expect(await deckIds()).not.toContain(task.id);

    const expiredBehindBlock = new Date(Date.now() - 3_600_000).toISOString();
    const stillBlocked = await callTool("update_task", {
      id: task.id,
      deferredUntil: expiredBehindBlock,
    });
    expect(stillBlocked.json<{ task: TaskJson }>().task).toMatchObject({
      deferredUntil: expiredBehindBlock,
      blocked: true,
    });
    expect(await deckIds()).not.toContain(task.id);

    const blockedWake = new Date(Date.now() - 1_000).toISOString();
    const wokeBlocked = await callTool("update_task", {
      id: task.id,
      deferredUntil: blockedWake,
      blocked: false,
    });
    expect(wokeBlocked.json<{ task: TaskJson }>().task).toMatchObject({
      deferredUntil: blockedWake,
      blocked: false,
    });
    expect(await deckIds()).toContain(task.id);

    // Expiry resumes automatically: reading the pool performs no wake write
    // and the retained timestamp remains the staleness base (ADR-17).
    const expired = new Date(Date.now() - 3_600_000).toISOString();
    await callTool("update_task", { id: task.id, deferredUntil: expired, blocked: false });
    const db = await testDb();
    const storedBefore = db
      .prepare("SELECT deferred_until AS deferredUntil FROM tasks WHERE id = ?")
      .get(task.id) as { deferredUntil: string | null };
    expect(storedBefore.deferredUntil).toBe(expired);
    expect(await deckIds()).toContain(task.id);
    const storedAfter = db
      .prepare("SELECT deferred_until AS deferredUntil FROM tasks WHERE id = ?")
      .get(task.id) as { deferredUntil: string | null };
    expect(storedAfter.deferredUntil).toBe(expired);

    // String shape is accepted by MCP and rejected by the authoritative API;
    // its existing 400 text is surfaced verbatim rather than reimplemented.
    const invalid = await callTool("update_task", {
      id: task.id,
      deferredUntil: "not-a-date",
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toBe(
      "deferredUntil must be null or an ISO datetime (API responded 400)",
    );

    expect((await callTool("update_task", { id: task.id, status: "archived" })).isError).toBe(
      false,
    );
  });

  it("resets impact to the neutral default when unlinking the goal", async () => {
    const created = (
      await callTool("create_task", { title: "Unlink me", categoryId: 1, goalId, impact: 4 })
    ).json<TaskJson>();
    expect(created.impact).toBe(4);

    const unlinked = await callTool("update_task", { id: created.id, goalId: null });
    expect(unlinked.isError).toBe(false);
    const task = unlinked.json<{ task: TaskJson }>().task;
    expect(task.goalId).toBeNull();
    expect(task.impact).toBe(3); // the rating pointed at the removed goal
  });

  it("reparents through parentId — adopt under a root, then promote back (#100)", async () => {
    const adoptive = (
      await callTool("create_task", { title: "Adoptive parent", categoryId: 3 })
    ).json<TaskJson>();
    const loose = (
      await callTool("create_task", { title: "Loose step", categoryId: 1, effortMinutes: 10 })
    ).json<TaskJson>();

    // Adopt: same PATCH semantics as the REST path — inheritance included.
    const adopted = await callTool("update_task", { id: loose.id, parentId: adoptive.id });
    expect(adopted.isError).toBe(false);
    const adoptedTask = adopted.json<{ task: TaskJson }>().task;
    expect(adoptedTask.parentId).toBe(adoptive.id);
    expect(adoptedTask.categoryId).toBe(3); // adoption inherits the parent's category
    const listed = (await callTool("list_tasks")).json<TaskJson[]>();
    expect(listed.find((t) => t.id === adoptive.id)!.subtasks!.map((s) => s.title)).toContain(
      "Loose step",
    );

    // The one-level rule is relayed verbatim: a subtask is no adoption target.
    const third = (
      await callTool("create_task", { title: "Third wheel", categoryId: 1 })
    ).json<TaskJson>();
    const nested = await callTool("update_task", { id: third.id, parentId: loose.id });
    expect(nested.isError).toBe(true);
    expect(nested.text).toContain("one level deep");

    // Promote: null makes it a root again, keeping its links.
    const promoted = await callTool("update_task", { id: loose.id, parentId: null });
    expect(promoted.isError).toBe(false);
    const promotedTask = promoted.json<{ task: TaskJson }>().task;
    expect(promotedTask.parentId).toBeNull();
    expect(promotedTask.categoryId).toBe(3); // promote keeps goal/category/impact

    // Archive the trio so the later draw_card expectations (category 3 has
    // no open tasks at all) keep holding in this shared-journey DB.
    for (const id of [adoptive.id, loose.id, third.id]) {
      expect((await callTool("update_task", { id, status: "archived" })).isError).toBe(false);
    }
  });

  it("cascades the unlink impact reset to the subtasks (issue #76)", async () => {
    const parent = (
      await callTool("create_task", {
        title: "Unlink cascade parent",
        categoryId: 1,
        goalId,
        impact: 4,
      })
    ).json<TaskJson>();
    await callTool("create_subtasks", {
      parentId: parent.id,
      subtasks: [{ title: "Rated step", effortMinutes: 10, impact: 5 }],
    });

    const res = await callTool("update_task", { id: parent.id, goalId: null });
    expect(res.isError).toBe(false);

    const listed = (await callTool("list_tasks")).json<TaskJson[]>().find((t) => t.id === parent.id)!;
    expect(listed.impact).toBe(3);
    expect(listed.subtasks![0].goalId).toBeNull();
    expect(listed.subtasks![0].impact).toBe(3); // its rating pointed at the removed goal too
  });
});

describe("create_subtasks and the breakdown rule", () => {
  it("creates the batch and warns about oversized subtasks naming max_draw_effort", async () => {
    const res = await callTool("create_subtasks", {
      parentId,
      subtasks: [
        { title: "Read ch1", effortMinutes: 20 },
        { title: "Mock exam", effortMinutes: 45, description: "Past exam · ~45 min" },
      ],
    });
    expect(res.isError).toBe(false);
    const body = res.json<{ created: TaskJson[]; warning?: string }>();
    expect(body.created).toHaveLength(2);
    expect(body.warning).toContain("max_draw_effort");
    expect(body.warning).toContain("30");
    expect(body.warning).toContain("Mock exam");
    expect(body.warning).not.toContain('"Read ch1"');
    readCh1Id = body.created.find((t) => t.title === "Read ch1")!.id;

    // Created as stated — the 45 min estimate was not clamped.
    const tasks = (await callTool("list_tasks")).json<TaskJson[]>();
    const parent = tasks.find((t) => t.id === parentId)!;
    expect(parent.subtasks?.map((s) => s.title).sort()).toEqual(["Mock exam", "Read ch1"]);
  });

  it("stays silent when every subtask fits", async () => {
    const res = await callTool("create_subtasks", {
      parentId,
      subtasks: [{ title: "Flashcards", effortMinutes: 15 }],
    });
    expect(res.json<{ warning?: string }>().warning).toBeUndefined();
  });

  it("rejects nesting on both creation paths — breakdowns are one level deep (#35)", async () => {
    // "Read ch1" is a subtask; breaking IT down would hide the grandchildren
    // from every list while keeping them draw-eligible (ADR-16).
    const viaBatch = await callTool("create_subtasks", {
      parentId: readCh1Id,
      subtasks: [{ title: "Nested step", effortMinutes: 10 }],
    });
    expect(viaBatch.isError).toBe(true);
    expect(viaBatch.text).toContain("one level deep");

    const viaSingle = await callTool("create_task", {
      title: "Nested via create_task",
      categoryId: 1,
      parentId: readCh1Id,
    });
    expect(viaSingle.isError).toBe(true);
    expect(viaSingle.text).toContain("one level deep");

    // Neither rejected call left a row behind.
    const db = await testDb();
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?")
      .get(readCh1Id) as { n: number };
    expect(row.n).toBe(0);
  });

  it("accepts per-subtask impact under the goal-less parent — documented ADR-4 exception (#76)", async () => {
    // The parent has no goal; a breakdown's ratings rank the siblings
    // relative to each other, so the batch path skips the ADR-4 goal gate.
    const res = await callTool("create_subtasks", {
      parentId,
      subtasks: [{ title: "Key exercise", effortMinutes: 10, impact: 5 }],
    });
    expect(res.isError).toBe(false);
    const created = res.json<{ created: TaskJson[] }>().created;
    expect(created[0].impact).toBe(5);
    expect(created[0].goalId).toBeNull();
  });

  it("rejects an out-of-range per-subtask impact at the schema boundary", async () => {
    const res = await callTool("create_subtasks", {
      parentId,
      subtasks: [{ title: "Overrated step", impact: 99 }],
    });
    expect(res.isError).toBe(true);
    // The MCP SDK rejects at the schema boundary — the API is never reached.
    expect(res.text).toMatch(/invalid/i);
    expect(res.text).toContain("impact");

    const parent = (await callTool("list_tasks")).json<TaskJson[]>().find((t) => t.id === parentId)!;
    expect(parent.subtasks!.some((s) => s.title === "Overrated step")).toBe(false);
  });
});

describe("complete_task invariants", () => {
  it("relays the subtask 409 as a tool error suggesting create_subtasks", async () => {
    const res = await callTool("complete_task", { id: parentId });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("complete all subtasks first");
    expect(res.text).toContain("create_subtasks");
  });

  it("passes through the same additive XP/Gold result as REST without an MCP contract change", async () => {
    const twinA = (await callTool("create_task", { title: "Twin A", categoryId: 1, effortMinutes: 15 })).json<TaskJson>();
    const twinB = (await callTool("create_task", { title: "Twin B", categoryId: 1, effortMinutes: 15 })).json<TaskJson>();

    const viaMcp = (await callTool("complete_task", { id: twinA.id })).json<{
      xpAwarded: number;
      goldAwarded: number;
      newAchievements: string[];
      recurring: boolean;
      levelUp: boolean;
    }>();
    const viaRest = (await restJson("PATCH", `/api/tasks/${twinB.id}`, { status: "done" })) as {
      xpAwarded: number;
      goldAwarded: number;
    };

    expect(viaMcp.xpAwarded).toBe(15); // round(15 * 3/3), no drawn bonus
    expect(viaMcp.goldAwarded).toBe(2);
    expect(viaMcp).toMatchObject({
      xpAwarded: viaRest.xpAwarded,
      goldAwarded: viaRest.goldAwarded,
    });
    expect(viaMcp.recurring).toBe(false);
    // The very first completion in this DB happened through MCP — the
    // gamification path ran identically.
    expect(viaMcp.newAchievements).toContain("first_completion");
  });

  it("closes the task's own running timer on completion (ADR-12)", async () => {
    const db = await testDb();
    await callTool("start_timer", { taskId: goalTaskId });
    const done = (await callTool("complete_task", { id: goalTaskId })).json<{
      xpAwarded: number;
      task: TaskJson;
    }>();
    expect(done.task.status).toBe("done");
    expect(done.xpAwarded).toBe(17); // round(10 * 5/3)

    const open = db
      .prepare("SELECT COUNT(*) AS n FROM time_entries WHERE ended_at IS NULL")
      .get() as { n: number };
    expect(open.n).toBe(0);
  });
});

describe("timer invariants", () => {
  it("start_timer closes any previously running entry — never two open", async () => {
    const db = await testDb();
    await callTool("start_timer", { taskId: readCh1Id });
    const second = await callTool("start_timer", { taskId: parentId });
    expect(second.isError).toBe(false);

    const open = db
      .prepare("SELECT task_id AS taskId FROM time_entries WHERE ended_at IS NULL")
      .all() as Array<{ taskId: number }>;
    expect(open).toHaveLength(1);
    expect(open[0].taskId).toBe(parentId);
  });

  it("stop_timer stops the running entry and errors when none runs", async () => {
    const stopped = await callTool("stop_timer");
    expect(stopped.isError).toBe(false);
    expect(stopped.json<{ endedAt: string | null }>().endedAt).toBeTruthy();

    const again = await callTool("stop_timer");
    expect(again.isError).toBe(true);
    expect(again.text).toContain("no running timer");
  });
});

describe("draw_card", () => {
  it("only draws within max_draw_effort, stamps last_drawn_at, unlocks first_draw", async () => {
    const db = await testDb();
    drawMeId = (
      await callTool("create_task", { title: "Draw me", categoryId: 2, effortMinutes: 10 })
    ).json<TaskJson>().id;
    await callTool("create_task", { title: "Huge card", categoryId: 2, effortMinutes: 45 });

    for (let i = 0; i < 10; i++) {
      const res = await callTool("draw_card", { categoryId: 2 });
      const body = res.json<{
        task: TaskJson;
        poolSize: number;
        probability: number;
        newAchievements: string[];
      }>();
      expect(body.task.title).toBe("Draw me");
      expect(body.poolSize).toBe(1);
      expect(body.probability).toBe(1);
      if (i === 0) expect(body.newAchievements).toContain("first_draw");
    }

    const row = db
      .prepare("SELECT last_drawn_at AS lastDrawnAt FROM tasks WHERE id = ?")
      .get(drawMeId) as { lastDrawnAt: string | null };
    expect(row.lastDrawnAt).toBeTruthy();
  });

  it("relays all_too_big and no_ready_tasks with breakdown guidance", async () => {
    await callTool("update_task", { id: drawMeId, status: "archived" });

    const tooBig = (await callTool("draw_card", { categoryId: 2 })).json<{
      task: null;
      reason: string;
      hint: string;
    }>();
    expect(tooBig.task).toBeNull();
    expect(tooBig.reason).toBe("all_too_big");
    expect(tooBig.hint).toContain("create_subtasks");

    const nothing = (await callTool("draw_card", { categoryId: 3 })).json<{
      task: null;
      reason: string;
    }>();
    expect(nothing.reason).toBe("no_ready_tasks");
  });
});

describe("stats, goals, materials", () => {
  it("get_stats reflects the completions made through MCP", async () => {
    const stats = (await callTool("get_stats")).json<{
      totalMinutes: number;
      completed: { count: number };
    }>();
    expect(stats.completed.count).toBe(3); // Twin A, Twin B, Goal task
    expect(stats.totalMinutes).toBeGreaterThanOrEqual(0);
  });

  it("list_goals and list_materials expose the goal's attachments with ids", async () => {
    const goals = (await callTool("list_goals")).json<
      Array<{ id: number; title: string; taskCount: number }>
    >();
    const goal = goals.find((g) => g.id === goalId)!;
    expect(goal.title).toBe("Pass the exam");
    expect(goal.taskCount).toBeGreaterThanOrEqual(1);

    noteId = (
      (await restJson("POST", `/api/goals/${goalId}/materials`, {
        noteText: "Focus on chapters 3-5",
      })) as { id: number }
    ).id;

    const fd = new FormData();
    fd.append("file", new Blob(["hello world"], { type: "text/plain" }), "notes.txt");
    const uploaded = await fetch(`${base}/api/goals/${goalId}/materials`, {
      method: "POST",
      body: fd,
    });
    expect(uploaded.status).toBe(201);
    fileId = ((await uploaded.json()) as { id: number }).id;

    const materials = (await callTool("list_materials", { goalId })).json<
      Array<{ id: number; kind: string }>
    >();
    expect(materials.map((m) => m.kind).sort()).toEqual(["file", "note"]);
    expect(materials.map((m) => m.id)).toEqual(expect.arrayContaining([noteId, fileId]));
  });

  it("list_goals filters by the missed status (#145)", async () => {
    // Own goal, resolved via REST — the shared journey goal stays active for
    // the tests that follow.
    const missedGoal = (await restJson("POST", "/api/goals", {
      title: "Missed the mark",
    })) as { id: number };
    await restJson("PATCH", `/api/goals/${missedGoal.id}`, { status: "missed" });

    const missed = (await callTool("list_goals", { status: "missed" })).json<
      Array<{ id: number; status: string }>
    >();
    expect(missed.map((g) => g.id)).toContain(missedGoal.id);
    for (const g of missed) expect(g.status).toBe("missed");

    // The default (active) listing keeps it out.
    const active = (await callTool("list_goals")).json<Array<{ id: number }>>();
    expect(active.map((g) => g.id)).not.toContain(missedGoal.id);
  });
});

describe("resources", () => {
  it("lists draw://deck, draw://gamification, and the materials", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("draw://deck");
    expect(uris).toContain("draw://gamification");
    expect(uris).toContain(`draw://materials/${noteId}`);
    expect(uris).toContain(`draw://materials/${fileId}`);

    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("draw://materials/{id}");
  });

  it("draw://deck is a side-effect-free snapshot with pool and timer state", async () => {
    const db = await testDb();
    const peekId = (
      await callTool("create_task", { title: "Deck peek", categoryId: 3, effortMinutes: 5 })
    ).json<TaskJson>().id;

    const res = await client.readResource({ uri: "draw://deck" });
    const deck = JSON.parse((res.contents[0] as { text: string }).text) as {
      poolSize: number;
      maxDrawEffort: number;
      candidates: Array<{ id: number; title: string; weight: number; probability: number }>;
      runningTimer: unknown;
    };
    expect(deck.maxDrawEffort).toBe(30);
    expect(deck.poolSize).toBe(deck.candidates.length);
    const peek = deck.candidates.find((c) => c.id === peekId)!;
    expect(peek.title).toBe("Deck peek");
    expect(peek.weight).toBeGreaterThan(0);
    expect(deck.runningTimer).toBeNull();

    // Reading the deck drew nothing: no last_drawn_at stamp on the candidate.
    const row = db
      .prepare("SELECT last_drawn_at AS lastDrawnAt FROM tasks WHERE id = ?")
      .get(peekId) as { lastDrawnAt: string | null };
    expect(row.lastDrawnAt).toBeNull();
  });

  it("draw://gamification wraps the gamification state", async () => {
    const res = await client.readResource({ uri: "draw://gamification" });
    const state = JSON.parse((res.contents[0] as { text: string }).text) as {
      xp: number;
      level: number;
      achievements: unknown[];
    };
    expect(state.xp).toBeGreaterThan(0);
    expect(state.level).toBeGreaterThanOrEqual(1);
    expect(state.achievements.length).toBeGreaterThan(0);
  });

  it("draw://materials/{id} serves note text and file blobs", async () => {
    const note = await client.readResource({ uri: `draw://materials/${noteId}` });
    const noteContent = note.contents[0] as { mimeType?: string; text?: string };
    expect(noteContent.mimeType).toBe("text/plain");
    expect(noteContent.text).toContain("Focus on chapters 3-5");

    const file = await client.readResource({ uri: `draw://materials/${fileId}` });
    const fileContent = file.contents[0] as { mimeType?: string; blob?: string };
    expect(fileContent.mimeType).toBe("text/plain");
    expect(Buffer.from(fileContent.blob!, "base64").toString("utf-8")).toBe("hello world");

    await expect(client.readResource({ uri: "draw://materials/99999" })).rejects.toThrow(
      /not found/,
    );
  });
});

describe("API-down behavior", () => {
  it("maps ECONNREFUSED to an actionable error naming npm run dev", async () => {
    const { buildMcpServer } = await import("../../src/mcpServer.js");
    const { HttpApiClient } = await import("../../src/tools/httpApi.js");

    // Grab a port that nothing listens on.
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const downServer = buildMcpServer(new HttpApiClient(`http://127.0.0.1:${deadPort}`));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const downClient = new Client({ name: "vitest-down", version: "0.0.0" });
    await Promise.all([downServer.connect(st), downClient.connect(ct)]);

    const res = await downClient.callTool({ name: "list_tasks", arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("npm run dev");

    await expect(downClient.readResource({ uri: "draw://deck" })).rejects.toThrow(/npm run dev/);

    await downClient.close();
  });
});
