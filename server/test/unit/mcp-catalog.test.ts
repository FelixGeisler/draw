import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  API_DOWN_MESSAGE,
  ApiUnreachableError,
  TOOLS,
  executeTool,
  httpErrorText,
  oversizedSubtaskWarning,
  type ApiClient,
  type ApiResponse,
} from "../../src/tools/catalog.js";

// Pure catalog tests: no MCP SDK, no network, no database.

function stubApi(
  handler?: (method: string, path: string, body?: unknown) => ApiResponse | undefined,
) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api: ApiClient = {
    async request(method, path, body) {
      calls.push({ method, path, body });
      const res = handler?.(method, path, body);
      if (!res) throw new Error(`unexpected API call: ${method} ${path}`);
      return res;
    },
  };
  return { api, calls };
}

function tool(name: string) {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} missing from catalog`);
  return def;
}

const EXPECTED_TOOLS = [
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
];

const READ_ONLY_TOOLS = [
  "get_settings",
  "get_stats",
  "list_categories",
  "list_goals",
  "list_materials",
  "list_tasks",
];

describe("tool catalog surface", () => {
  it("contains exactly the documented tool set", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("exposes no destructive verbs at all", () => {
    for (const t of TOOLS) {
      expect(t.name).not.toMatch(/delete|remove|purge/);
      expect(t.annotations.destructiveHint).toBe(false);
    }
  });

  it("annotates read tools read-only and write tools honestly", () => {
    for (const t of TOOLS) {
      expect(t.annotations.readOnlyHint).toBe(READ_ONLY_TOOLS.includes(t.name));
    }
    // draw_card writes (last_drawn_at, achievements) — it must not pose as a read.
    expect(tool("draw_card").annotations.readOnlyHint).toBe(false);
  });
});

describe("create_task input schema", () => {
  const schema = z.object(tool("create_task").inputSchema);
  const base = { title: "t", categoryId: 1 };

  it("accepts impact only as a literal 1–5", () => {
    for (const impact of [1, 2, 3, 4, 5]) {
      expect(schema.safeParse({ ...base, goalId: 1, impact }).success).toBe(true);
    }
    for (const impact of [0, 6, 2.5, "3", -1]) {
      expect(schema.safeParse({ ...base, goalId: 1, impact }).success).toBe(false);
    }
  });

  it("requires title and categoryId", () => {
    expect(schema.safeParse({ categoryId: 1 }).success).toBe(false);
    expect(schema.safeParse({ title: "t" }).success).toBe(false);
    expect(schema.safeParse(base).success).toBe(true);
  });

  it("takes dueDate only as YYYY-MM-DD", () => {
    expect(schema.safeParse({ ...base, dueDate: "2026-03-04" }).success).toBe(true);
    for (const dueDate of ["2026-3-4", "04.03.2026", "2026-03-04T10:00:00Z", "tomorrow"]) {
      expect(schema.safeParse({ ...base, dueDate }).success).toBe(false);
    }
  });
});

describe("update_task input schema", () => {
  const schema = z.object(tool("update_task").inputSchema);

  it("allows archived/open but never done — completion has its own tool", () => {
    expect(schema.safeParse({ id: 1, status: "archived" }).success).toBe(true);
    expect(schema.safeParse({ id: 1, status: "open" }).success).toBe(true);
    expect(schema.safeParse({ id: 1, status: "done" }).success).toBe(false);
  });
});

describe("goal-less impact rejection (ADR-4)", () => {
  // Since issue #65 the API enforces the gate on POST and PATCH alike, so the
  // catalog no longer duplicates the check — it must surface the API's 400
  // verbatim instead of swallowing or rephrasing it.
  it("surfaces the API's ADR-4 rejection as a tool error", async () => {
    const { api, calls } = stubApi((method, path) =>
      method === "POST" && path === "/api/tasks"
        ? {
            status: 400,
            body: { error: "impact is only meaningful for goal-linked tasks (ADR-4)" },
          }
        : undefined,
    );
    const outcome = await executeTool("create_task", api, {
      title: "Read chapter",
      categoryId: 1,
      impact: 4,
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/goal/i);
    expect(outcome.text).toContain("ADR-4");
    expect(calls).toHaveLength(1);
  });

  it("passes impact through when goalId is present", async () => {
    const { api, calls } = stubApi((method, path) =>
      method === "POST" && path === "/api/tasks" ? { status: 201, body: { id: 7 } } : undefined,
    );
    const outcome = await executeTool("create_task", api, {
      title: "Read chapter",
      categoryId: 1,
      goalId: 3,
      impact: 4,
    });
    expect(outcome.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ impact: 4, goalId: 3 });
  });
});

describe("HTTP-error → tool-error mapping", () => {
  it("enriches complete_task's subtask 409 with breakdown guidance", () => {
    const text = httpErrorText("complete_task", 409, { error: "complete all subtasks first" });
    expect(text).toContain("complete all subtasks first");
    expect(text).toContain("create_subtasks");
  });

  it("relays other API errors with their status", () => {
    const text = httpErrorText("update_task", 404, { error: "task not found" });
    expect(text).toContain("task not found");
    expect(text).toContain("404");
  });

  it("maps an unreachable API to the actionable npm-run-dev message", async () => {
    const api: ApiClient = {
      async request() {
        throw new ApiUnreachableError("http://127.0.0.1:3001");
      },
    };
    const outcome = await executeTool("list_tasks", api, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe(API_DOWN_MESSAGE);
    expect(outcome.text).toContain("npm run dev");
  });

  it("surfaces non-2xx responses as tool errors", async () => {
    const { api } = stubApi(() => ({ status: 409, body: { error: "task is not open" } }));
    const outcome = await executeTool("start_timer", api, { taskId: 1 });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("task is not open");
  });
});

describe("oversized-subtask warning helper", () => {
  it("stays silent when every subtask fits max_draw_effort", () => {
    expect(
      oversizedSubtaskWarning(
        [{ title: "a", effortMinutes: 30 }, { title: "b", effortMinutes: 5 }, { title: "c" }],
        30,
      ),
    ).toBeNull();
  });

  it("names max_draw_effort and the oversized subtasks — never clamps", () => {
    const warning = oversizedSubtaskWarning(
      [
        { title: "Mock exam", effortMinutes: 45 },
        { title: "Read ch1", effortMinutes: 20 },
      ],
      30,
    );
    expect(warning).toContain("max_draw_effort");
    expect(warning).toContain("30");
    expect(warning).toContain("Mock exam");
    expect(warning).not.toContain("Read ch1");
    expect(warning).toMatch(/split/i);
  });
});

describe("executeTool argument validation", () => {
  it("rejects invalid arguments without calling the API", async () => {
    const { api, calls } = stubApi();
    const outcome = await executeTool("complete_task", api, { id: "seven" });
    expect(outcome.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown tools", async () => {
    const { api } = stubApi();
    const outcome = await executeTool("delete_task", api, { id: 1 });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("unknown tool");
  });
});
