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
  dueDate: string | null;
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
});

describe("complete_task invariants", () => {
  it("relays the subtask 409 as a tool error suggesting create_subtasks", async () => {
    const res = await callTool("complete_task", { id: parentId });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("complete all subtasks first");
    expect(res.text).toContain("create_subtasks");
  });

  it("awards the same XP as the REST path (parity twins)", async () => {
    const twinA = (await callTool("create_task", { title: "Twin A", categoryId: 1, effortMinutes: 15 })).json<TaskJson>();
    const twinB = (await callTool("create_task", { title: "Twin B", categoryId: 1, effortMinutes: 15 })).json<TaskJson>();

    const viaMcp = (await callTool("complete_task", { id: twinA.id })).json<{
      xpAwarded: number;
      newAchievements: string[];
      recurring: boolean;
      levelUp: boolean;
    }>();
    const viaRest = (await restJson("PATCH", `/api/tasks/${twinB.id}`, { status: "done" })) as {
      xpAwarded: number;
    };

    expect(viaMcp.xpAwarded).toBe(15); // round(15 * 3/3), no drawn bonus
    expect(viaMcp.xpAwarded).toBe(viaRest.xpAwarded);
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
