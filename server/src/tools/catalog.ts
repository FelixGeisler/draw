import { z } from "zod";

/**
 * The domain-tool catalog: one vocabulary for every AI surface (issue #36,
 * ADR-19). This module is deliberately free of MCP and Anthropic imports —
 * the MCP server (src/mcpServer.ts) binds it with live HTTP executors, and
 * the in-app assistant (#31) will bind the same catalog to staged executors.
 *
 * Tools talk to the running HTTP API, never to the database: the domain
 * invariants (subtask 409, single running timer, draw side effects,
 * XP/achievements) live in the Express layer, so going through it keeps them
 * intact by construction. The input schemas exist for schema-guided tool
 * calling; the API stays the enforcement point.
 */

// ---------------------------------------------------------------------------
// API client abstraction — implemented with fetch in httpApi.ts.

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiClient {
  request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<ApiResponse>;
}

/** Thrown by ApiClient implementations when the API cannot be reached at all. */
export class ApiUnreachableError extends Error {
  constructor(baseUrl: string) {
    super(`Draw API unreachable at ${baseUrl}`);
    this.name = "ApiUnreachableError";
  }
}

export const API_DOWN_MESSAGE =
  "Draw's API server is not running — start it with `npm run dev` in the Draw checkout " +
  "(or set DRAW_API_URL if it listens somewhere other than http://127.0.0.1:3001).";

// ---------------------------------------------------------------------------
// Tool shapes (transport-agnostic — no MCP types).

export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

export interface ToolAnnotations {
  title: string;
  /** True only for tools that cannot write anything. */
  readOnlyHint: boolean;
  /**
   * Explicit false on every tool: nothing exposed here destroys data (no
   * delete tools exist at all; archiving is soft), and the MCP spec default
   * for an unspecified destructiveHint is true.
   */
  destructiveHint: boolean;
  idempotentHint?: boolean;
  /** Always false: the tools address the closed local Draw domain. */
  openWorldHint: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  execute: (api: ApiClient, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

type ArgsOf<Shape extends z.ZodRawShape> = z.output<z.ZodObject<Shape>>;

function defineTool<Shape extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  execute: (api: ApiClient, args: ArgsOf<Shape>) => Promise<ToolOutcome>;
}): ToolDef {
  return def as unknown as ToolDef;
}

// ---------------------------------------------------------------------------
// Shared schema fragments and helpers.

/** Impact is a literal 1–5 rating, not any number (ADR-4). */
const impactSchema = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
  .describe("Leverage toward the linked goal, 1 (low) to 5 (high). Only valid with goalId.");

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .describe("Calendar date as YYYY-MM-DD");

const idSchema = z.number().int().positive();

function query(params: Record<string, unknown>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (pairs.length === 0) return "";
  return "?" + pairs.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

function ok(payload: unknown): ToolOutcome {
  return { text: JSON.stringify(payload, null, 2) };
}

/**
 * Maps a non-2xx API response to a tool-error message. The one enriched case:
 * complete_task's 409 explains the breakdown invariant and points at the
 * tools that resolve it.
 */
export function httpErrorText(tool: string, status: number, body: unknown): string {
  const apiError =
    typeof (body as { error?: unknown })?.error === "string"
      ? ((body as { error: string }).error)
      : JSON.stringify(body);
  if (tool === "complete_task" && status === 409 && apiError.includes("complete all subtasks")) {
    return (
      `${apiError} (API responded 409). This task still has open subtasks — ` +
      "complete them first (list_tasks shows them under the parent), or use " +
      "create_subtasks if the remaining work needs further breakdown."
    );
  }
  return `${apiError} (API responded ${status})`;
}

/**
 * Post-creation warning for subtasks that exceed max_draw_effort: they are
 * created as requested (never silently clamped — the estimate is the user's
 * or the material's data), but they will not be drawable until split.
 */
export function oversizedSubtaskWarning(
  subtasks: Array<{ title: string; effortMinutes?: number }>,
  maxDrawEffort: number,
): string | null {
  const oversized = subtasks.filter(
    (s) => s.effortMinutes !== undefined && s.effortMinutes > maxDrawEffort,
  );
  if (oversized.length === 0) return null;
  const names = oversized.map((s) => `"${s.title}" (${s.effortMinutes} min)`).join(", ");
  return (
    `${oversized.length} subtask(s) exceed max_draw_effort (${maxDrawEffort} min) and will not ` +
    `be drawable: ${names}. Split each into smaller subtasks instead of shrinking the estimate — ` +
    "the stated effort must never be clamped."
  );
}

async function call(
  api: ApiClient,
  tool: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ ok: true; body: unknown } | { ok: false; outcome: ToolOutcome }> {
  const res = await api.request(method, path, body);
  if (res.status >= 200 && res.status < 300) return { ok: true, body: res.body };
  return { ok: false, outcome: { isError: true, text: httpErrorText(tool, res.status, res.body) } };
}

// ---------------------------------------------------------------------------
// The tools.

const listTasks = defineTool({
  name: "list_tasks",
  description:
    "List Draw's tasks (roots with their subtasks nested as `subtasks`). Defaults to open " +
    "tasks; filter by status, categoryId, or goalId. Tasks with open subtasks are containers — " +
    "they cannot be completed or drawn until their subtasks are done.",
  inputSchema: {
    status: z.enum(["open", "done", "archived", "all"]).optional().describe("Default: open"),
    categoryId: idSchema.optional(),
    goalId: idSchema.optional(),
  },
  annotations: {
    title: "List tasks",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api, args) => {
    const res = await call(api, "list_tasks", "GET", `/api/tasks${query(args)}`);
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const createTask = defineTool({
  name: "create_task",
  description:
    "Create a task. categoryId is required (see list_categories). A task only enters the " +
    "drawable deck once effortMinutes is set and is at most max_draw_effort (see get_settings) — " +
    "bigger work should be created as a parent and broken down with create_subtasks. " +
    "impact (1–5) is only accepted together with goalId: it rates leverage toward that goal " +
    "(ADR-4). recurEveryDays makes it a recurring chore whose due date advances on completion.",
  inputSchema: {
    title: z.string().min(1),
    categoryId: idSchema.describe("Required — list_categories shows the options"),
    description: z.string().optional(),
    goalId: idSchema.optional().describe("Link to a goal (list_goals)"),
    impact: impactSchema.optional(),
    effortMinutes: z.number().int().positive().optional(),
    dueDate: dateSchema.optional(),
    recurEveryDays: z.number().int().positive().optional(),
    parentId: idSchema
      .optional()
      .describe("Create as a subtask of this task (prefer create_subtasks for batches)"),
  },
  annotations: {
    title: "Create task",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api, args) => {
    if (args.impact !== undefined && args.goalId === undefined) {
      return {
        isError: true,
        text:
          "impact is only meaningful for goal-linked tasks (ADR-4): pass goalId together with " +
          "impact, or omit impact — goal-less tasks use the neutral default. list_goals shows " +
          "the available goals.",
      };
    }
    const res = await call(api, "create_task", "POST", "/api/tasks", args);
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const updateTask = defineTool({
  name: "update_task",
  description:
    "Update fields of a task. Idempotent. status may be set to 'archived' (soft archive — the " +
    "task leaves every list but is not deleted) or back to 'open' (reopening a done task undoes " +
    "its latest completion so XP stays honest). To mark a task done, use complete_task instead — " +
    "it runs the XP/achievements/recurrence path.",
  inputSchema: {
    id: idSchema,
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    categoryId: idSchema.optional(),
    goalId: idSchema
      .nullable()
      .optional()
      .describe("Set null to unlink; subtasks follow their parent's goal"),
    impact: impactSchema.optional(),
    effortMinutes: z.number().int().positive().nullable().optional(),
    dueDate: dateSchema.nullable().optional(),
    recurEveryDays: z.number().int().positive().nullable().optional(),
    status: z
      .enum(["open", "archived"])
      .optional()
      .describe("'archived' = soft archive, 'open' = un-archive or reopen (undoes the completion)"),
  },
  annotations: {
    title: "Update task",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute: async (api, { id, ...fields }) => {
    const res = await call(api, "update_task", "PATCH", `/api/tasks/${id}`, fields);
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const completeTask = defineTool({
  name: "complete_task",
  description:
    "Mark a task done. Awards XP (relayed as xpAwarded, with levelUp and newAchievements), " +
    "closes the task's own running timer, and — for recurring tasks — keeps the task open and " +
    "advances its due date (recurring: true in the result). Fails with an explanation if the " +
    "task still has open subtasks.",
  inputSchema: { id: idSchema },
  annotations: {
    title: "Complete task",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api, { id }) => {
    const res = await call(api, "complete_task", "PATCH", `/api/tasks/${id}`, { status: "done" });
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const createSubtasks = defineTool({
  name: "create_subtasks",
  description:
    "Break a task down: create several subtasks under a parent in one atomic batch. Subtasks " +
    "inherit the parent's category and goal. The breakdown rule: every leaf must have " +
    "effortMinutes of at most max_draw_effort (see get_settings) to be drawable — split large " +
    "items into more subtasks, NEVER shrink an estimate to fit. Oversized subtasks are still " +
    "created but the result carries a warning. Use description for provenance, e.g. " +
    "'Exercise 7 · 8 pts · ~45 min · exam.pdf'.",
  inputSchema: {
    parentId: idSchema,
    subtasks: z
      .array(
        z.object({
          title: z.string().min(1),
          description: z.string().optional(),
          effortMinutes: z.number().int().positive().optional(),
          impact: impactSchema.optional(),
        }),
      )
      .min(1),
  },
  annotations: {
    title: "Create subtasks",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api, { parentId, subtasks }) => {
    const res = await call(api, "create_subtasks", "POST", `/api/tasks/${parentId}/subtasks`, {
      subtasks,
    });
    if (!res.ok) return res.outcome;
    // The warning needs max_draw_effort; if settings are unreadable the
    // created subtasks are still reported without it.
    let warning: string | null = null;
    try {
      const settings = await api.request("GET", "/api/settings");
      const max = Number((settings.body as Record<string, string>)?.max_draw_effort);
      if (Number.isFinite(max)) warning = oversizedSubtaskWarning(subtasks, max);
    } catch {
      warning = null;
    }
    return ok(warning ? { created: res.body, warning } : { created: res.body });
  },
});

const drawCard = defineTool({
  name: "draw_card",
  description:
    "Draw the next card from the deck — the answer to \"what should I do right now?\". Picks a " +
    "weighted-random drawable task (open leaf, estimated, within max_draw_effort, not snoozed or " +
    "blocked), favoring high-impact, low-effort, urgent, stale tasks. NOT read-only: it stamps " +
    "the task's last_drawn_at (dampening quick redraws) and can unlock achievements. If the deck " +
    "is empty the result says why: no_ready_tasks (nothing open and ready) or all_too_big " +
    "(everything needs an estimate or a create_subtasks breakdown).",
  inputSchema: {
    categoryId: idSchema.optional().describe("Only draw from this category"),
    goalId: idSchema.optional().describe("Only draw from this goal"),
  },
  annotations: {
    title: "Draw a card",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api, args) => {
    const res = await call(api, "draw_card", "POST", "/api/draw", args);
    if (!res.ok) return res.outcome;
    const body = res.body as { task: unknown; reason?: string };
    if (!body.task) {
      const hint =
        body.reason === "all_too_big"
          ? "Open tasks exist, but each is unestimated or exceeds max_draw_effort — pick one and " +
            "break it down with create_subtasks (split, never clamp)."
          : "No open task is ready to draw — create_task something small, or check list_tasks " +
            "for snoozed/blocked cards that come back on their own.";
      return ok({ ...body, hint });
    }
    return ok(body);
  },
});

const startTimer = defineTool({
  name: "start_timer",
  description:
    "Start tracking time on a task. Only one timer runs at a time: starting a new one closes " +
    "any previously running entry (single-timer invariant).",
  inputSchema: { taskId: idSchema },
  annotations: {
    title: "Start timer",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api, { taskId }) => {
    const res = await call(api, "start_timer", "POST", `/api/tasks/${taskId}/timer/start`);
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const stopTimer = defineTool({
  name: "stop_timer",
  description: "Stop the currently running timer. Errors if no timer is running.",
  inputSchema: {},
  annotations: {
    title: "Stop timer",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api) => {
    const res = await call(api, "stop_timer", "POST", "/api/timer/stop");
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const getStats = defineTool({
  name: "get_stats",
  description:
    "Time and completion statistics for a date range (default: the last 7 days): tracked " +
    "minutes by category and impact, completions, estimate accuracy, and the weekly leverage " +
    "grade. Dates are inclusive.",
  inputSchema: {
    from: dateSchema.optional(),
    to: dateSchema.optional(),
  },
  annotations: {
    title: "Get statistics",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api, args) => {
    const res = await call(api, "get_stats", "GET", `/api/stats${query(args)}`);
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const listGoals = defineTool({
  name: "list_goals",
  description:
    "List goals with task/material counts. Defaults to active goals; status may be 'active', " +
    "'achieved', 'dropped', or 'all'. Goals are what impact ratings point at (ADR-4).",
  inputSchema: {
    status: z.enum(["active", "achieved", "dropped", "all"]).optional().describe("Default: active"),
  },
  annotations: {
    title: "List goals",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api, args) => {
    const res = await call(api, "list_goals", "GET", `/api/goals${query(args)}`);
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const listMaterials = defineTool({
  name: "list_materials",
  description:
    "List the materials attached to a goal (uploaded PDFs/notes: lectures, past exams, " +
    "syllabi) — metadata only, including each material's id. Read the content via the " +
    "draw://materials/{id} resource.",
  inputSchema: { goalId: idSchema },
  annotations: {
    title: "List goal materials",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api, { goalId }) => {
    const res = await call(api, "list_materials", "GET", `/api/goals/${goalId}/materials`);
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const listCategories = defineTool({
  name: "list_categories",
  description:
    "List the task categories. Every task needs a categoryId from this list.",
  inputSchema: {},
  annotations: {
    title: "List categories",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api) => {
    const res = await call(api, "list_categories", "GET", "/api/categories");
    return res.ok ? ok(res.body) : res.outcome;
  },
});

const getSettings = defineTool({
  name: "get_settings",
  description:
    "Read Draw's settings (values are strings): max_draw_effort (minutes — the drawability " +
    "ceiling that create_subtasks breakdowns must respect), draw_cooldown_minutes, and " +
    "daily_goal_completions. Never contains the API key.",
  inputSchema: {},
  annotations: {
    title: "Get settings",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execute: async (api) => {
    const res = await call(api, "get_settings", "GET", "/api/settings");
    return res.ok ? ok(res.body) : res.outcome;
  },
});

/**
 * The complete tool set. Deliberately absent: every delete (destructive ops
 * are omitted from this surface entirely) and key management (PUT/DELETE
 * /api/ai/key is never exposed).
 */
export const TOOLS: ToolDef[] = [
  listTasks,
  createTask,
  updateTask,
  completeTask,
  createSubtasks,
  drawCard,
  startTimer,
  stopTimer,
  getStats,
  listGoals,
  listMaterials,
  listCategories,
  getSettings,
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Validate args and run a tool, mapping transport-level failures to friendly
 * tool errors. This is THE tool boundary — every binding (MCP now, #31's
 * staged executors later) goes through it.
 */
export async function executeTool(
  name: string,
  api: ApiClient,
  args: unknown,
): Promise<ToolOutcome> {
  const def = TOOL_MAP.get(name);
  if (!def) return { isError: true, text: `unknown tool: ${name}` };
  const parsed = z.object(def.inputSchema).safeParse(args ?? {});
  if (!parsed.success) {
    return { isError: true, text: `invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` };
  }
  try {
    return await def.execute(api, parsed.data as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ApiUnreachableError) return { isError: true, text: API_DOWN_MESSAGE };
    return {
      isError: true,
      text: `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
