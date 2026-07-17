import { z } from "zod";
import { evenSplit, MAX_PARTS_PER_ITEM } from "./aiPostprocess.js";

/**
 * The assistant's staging engine (#31, ADR-37) — PURE: no DB, no SDK, no
 * Express. During the tool loop the write tools never touch the database;
 * they validate against this draft changeset (plus an injected lookup
 * context) and hand back synthetic draft ids. The user reviews the changeset
 * in the chat panel and applies it in ONE transaction (agentService), which
 * resolves draft parents to real ids through the same route cores the HTTP
 * endpoints use (services/taskWrites.ts).
 *
 * Split-don't-clamp (#28's policy, reused): a staged SUBTASK whose effort
 * exceeds max_draw_effort is split into near-equal parts that preserve the
 * total — whether it was staged via create_subtasks (at stage time, so the
 * review shows the rows that will actually be created, and again defensively
 * at apply time because the reviewer can edit efforts) or via create_task
 * with a parentId (at stage time; apply then creates the parts verbatim like
 * POST /api/tasks would). A ROOT task is never split (an unestimated or
 * oversized root is a legal container-to-be); the tool result tells the
 * model to stage a breakdown under its draft id instead.
 */

// ---------------------------------------------------------------------------
// Draft ids

export const DRAFT_ID_RE = /^draft-\d+$/;

export function isDraftId(value: unknown): value is string {
  return typeof value === "string" && DRAFT_ID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Changeset shapes (also the wire shape the client reviews and sends back)

const draftIdSchema = z.string().regex(DRAFT_ID_RE);
const idSchema = z.number().int().positive();
const impactSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
/** A real task id, or the draft id of a task staged earlier in the changeset. */
const parentRefSchema = z.union([idSchema, draftIdSchema]);

export const stagedTaskInputSchema = z.object({
  title: z.string().min(1),
  categoryId: idSchema,
  description: z.string().optional(),
  goalId: idSchema.optional(),
  impact: impactSchema.optional(),
  effortMinutes: z.number().int().positive().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  recurEveryDays: z.number().int().positive().optional(),
  windowDays: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
  parentId: parentRefSchema.optional(),
});

export const stagedSubtaskSchema = z.object({
  draftId: draftIdSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  effortMinutes: z.number().int().positive().optional(),
  impact: impactSchema.optional(),
});

export const createTaskOpSchema = z.object({
  kind: z.literal("create_task"),
  draftId: draftIdSchema,
  task: stagedTaskInputSchema,
});

export const createSubtasksOpSchema = z.object({
  kind: z.literal("create_subtasks"),
  draftId: draftIdSchema,
  parentId: parentRefSchema,
  subtasks: z.array(stagedSubtaskSchema).min(1),
});

export const stagedOpSchema = z.discriminatedUnion("kind", [
  createTaskOpSchema,
  createSubtasksOpSchema,
]);

/** POST /api/ai/agent/apply body: the reviewed (possibly edited) operations. */
export const applyBodySchema = z.object({
  sessionId: z.string().optional(),
  /**
   * The changeset version the message turn handed out (#143). Apply consumes
   * that version; a retry carrying a consumed version answers 409 with the
   * original mapping instead of duplicating. Keyed by version on purpose:
   * the operations here are the REVIEWED ops (edits, exclusions) and may
   * legitimately differ from what was staged, so equality of operations can
   * never identify "the same changeset".
   */
  changesetVersion: z.number().int().positive().optional(),
  operations: z.array(stagedOpSchema).min(1),
});

export type StagedTaskInput = z.output<typeof stagedTaskInputSchema>;
export type StagedSubtask = z.output<typeof stagedSubtaskSchema>;
export type CreateTaskOp = z.output<typeof createTaskOpSchema>;
export type CreateSubtasksOp = z.output<typeof createSubtasksOpSchema>;
export type StagedOp = z.output<typeof stagedOpSchema>;

export interface Changeset {
  /** Monotonic counter minting draft-N ids, unique across the session. */
  nextDraft: number;
  ops: StagedOp[];
}

export function createChangeset(): Changeset {
  return { nextDraft: 1, ops: [] };
}

function mintDraftId(cs: Changeset): string {
  return `draft-${cs.nextDraft++}`;
}

// ---------------------------------------------------------------------------
// Stage-time validation context — injected so the engine stays pure; the
// service binds these to real DB lookups, tests to fixtures.

export interface StagingContext {
  categoryExists(id: number): boolean;
  goalExists(id: number): boolean;
  /** null when no task with that id exists. */
  taskInfo(id: number): { isSubtask: boolean; archived: boolean } | null;
  maxDrawEffort: number;
}

export interface StageOutcome {
  text: string;
  isError?: boolean;
}

/** The staged create_task op a draft parent ref must point at. */
function findDraftTask(cs: Changeset, draftId: string): CreateTaskOp | undefined {
  return cs.ops.find(
    (op): op is CreateTaskOp => op.kind === "create_task" && op.draftId === draftId,
  );
}

/**
 * Validate a parent reference (real id or draft id) for staging under it.
 * Mirrors the route guards the apply step will re-run authoritatively
 * (ADR-16 one level, archived parents take no children) so the model learns
 * about a bad reference immediately, not at apply time.
 */
function parentRefError(cs: Changeset, ref: number | string, ctx: StagingContext): string | null {
  if (typeof ref === "number") {
    const info = ctx.taskInfo(ref);
    if (!info) return `parent task ${ref} not found — use list_tasks to check ids`;
    if (info.isSubtask) {
      return (
        `task ${ref} is itself a subtask — breakdowns are one level deep (ADR-16); ` +
        "stage the steps under its root parent instead"
      );
    }
    if (info.archived) {
      return `task ${ref} is archived and cannot take subtasks — pick an open parent`;
    }
    return null;
  }
  const draft = findDraftTask(cs, ref);
  if (!draft) {
    return (
      `${ref} does not reference a task staged in this conversation — ` +
      "use the draftId returned by a previous create_task call"
    );
  }
  if (draft.task.parentId != null) {
    return (
      `${ref} is itself a staged subtask — breakdowns are one level deep (ADR-16); ` +
      "stage the steps under its root draft instead"
    );
  }
  return null;
}

/**
 * Stage one task (the catalog's create_task, bound to the draft changeset).
 * `args` is already schema-validated. Mutates the changeset on success.
 */
export function stageCreateTask(
  cs: Changeset,
  args: StagedTaskInput,
  ctx: StagingContext,
): StageOutcome {
  if (!ctx.categoryExists(args.categoryId)) {
    return {
      isError: true,
      text: `category ${args.categoryId} not found — call list_categories for the valid ids`,
    };
  }
  if (args.goalId != null && !ctx.goalExists(args.goalId)) {
    return { isError: true, text: `goal ${args.goalId} not found — call list_goals for the valid ids` };
  }
  if (args.parentId != null) {
    const refError = parentRefError(cs, args.parentId, ctx);
    if (refError) return { isError: true, text: refError };
  }
  // ADR-4 pre-check so the model corrects course now instead of the user
  // hitting the 400 at apply. The apply step re-runs the authoritative gate.
  if (args.impact != null && args.impact !== 3 && args.goalId == null && args.parentId == null) {
    return {
      isError: true,
      text:
        "impact is only meaningful for goal-linked tasks (ADR-4): set a goalId together with " +
        "a non-neutral impact, or omit impact",
    };
  }
  // Split-don't-clamp for PARENTED creates (#28's policy, aligned with
  // create_subtasks): a create_task with a parentId stages a LEAF — an
  // oversized one would be undrawable, and it cannot be fixed by a breakdown
  // because subtask drafts take no children (ADR-16). Split it into sibling
  // part rows under the same parent, preserving the stated total. A ROOT
  // task is never split — an oversized root is a legal container-to-be
  // (warned below, pointing at create_subtasks).
  if (args.parentId != null && args.effortMinutes != null && args.effortMinutes > ctx.maxDrawEffort) {
    const { rows } = expandOversizedSubtasks([args], ctx.maxDrawEffort);
    const parts = rows.map(({ splitFrom: _s, ...task }) => {
      const draftId = mintDraftId(cs);
      cs.ops.push({ kind: "create_task", draftId, task });
      return { draftId, title: task.title, effortMinutes: task.effortMinutes };
    });
    return {
      text: JSON.stringify({
        staged: true,
        parts,
        note: "DRAFT ONLY — nothing is saved until the user reviews and applies the changeset.",
        warnings: [
          `effortMinutes ${args.effortMinutes} exceeds max_draw_effort (${ctx.maxDrawEffort} min) and ` +
            "this draft has a parent: it was split into sibling steps under that parent, preserving " +
            "the stated total (split, never clamp). Subtask drafts cannot take their own breakdowns " +
            "(ADR-16) — stage any further steps under the root parent.",
        ],
      }),
    };
  }

  const draftId = mintDraftId(cs);
  cs.ops.push({ kind: "create_task", draftId, task: args });
  const warnings: string[] = [];
  if (args.effortMinutes != null && args.effortMinutes > ctx.maxDrawEffort) {
    warnings.push(
      `effortMinutes ${args.effortMinutes} exceeds max_draw_effort (${ctx.maxDrawEffort}): the task ` +
        "will not be drawable as-is. Stage create_subtasks under this draft id to break it down — " +
        "split the work, never shrink the estimate.",
    );
  }
  return {
    text: JSON.stringify({
      staged: true,
      draftId,
      note: "DRAFT ONLY — nothing is saved until the user reviews and applies the changeset.",
      ...(warnings.length > 0 ? { warnings } : {}),
    }),
  };
}

/**
 * Split-don't-clamp expansion for staged subtasks (#28's policy): every row
 * with effortMinutes above `maxEffort` becomes ceil(minutes / maxEffort)
 * near-equal parts preserving the total, capped at MAX_PARTS_PER_ITEM parts
 * (a pathological effort keeps oversized parts rather than losing minutes).
 * Rows within the limit pass through untouched. Pure; shared by stage time
 * (so the review shows the real rows) and apply time (the reviewer may have
 * edited an effort upward).
 */
export function expandOversizedSubtasks<T extends { title: string; effortMinutes?: number }>(
  subtasks: T[],
  maxEffort: number,
): { rows: (T & { splitFrom?: string })[]; splitCount: number } {
  const rows: (T & { splitFrom?: string })[] = [];
  let splitCount = 0;
  for (const s of subtasks) {
    if (s.effortMinutes == null || s.effortMinutes <= maxEffort) {
      rows.push(s);
      continue;
    }
    splitCount++;
    const count = Math.min(Math.ceil(s.effortMinutes / maxEffort), MAX_PARTS_PER_ITEM);
    evenSplit(s.effortMinutes, count).forEach((minutes, i) => {
      rows.push({
        ...s,
        title: `${s.title} (part ${i + 1}/${count})`,
        effortMinutes: minutes,
        splitFrom: s.title,
      });
    });
  }
  return { rows, splitCount };
}

export interface StageSubtasksArgs {
  parentId: number | string;
  subtasks: { title: string; description?: string; effortMinutes?: number; impact?: 1 | 2 | 3 | 4 | 5 }[];
}

/**
 * Stage a batch of subtasks under a real task or an earlier draft. Oversized
 * rows are split here so the review card shows exactly the rows apply will
 * create. Mutates the changeset on success.
 */
export function stageCreateSubtasks(
  cs: Changeset,
  args: StageSubtasksArgs,
  ctx: StagingContext,
): StageOutcome {
  const refError = parentRefError(cs, args.parentId, ctx);
  if (refError) return { isError: true, text: refError };

  const { rows, splitCount } = expandOversizedSubtasks(args.subtasks, ctx.maxDrawEffort);
  const opDraftId = mintDraftId(cs);
  const staged: StagedSubtask[] = rows.map((r) => ({
    draftId: mintDraftId(cs),
    title: r.title,
    ...(r.description != null ? { description: r.description } : {}),
    ...(r.effortMinutes != null ? { effortMinutes: r.effortMinutes } : {}),
    ...(r.impact != null ? { impact: r.impact } : {}),
  }));
  cs.ops.push({ kind: "create_subtasks", draftId: opDraftId, parentId: args.parentId, subtasks: staged });
  return {
    text: JSON.stringify({
      staged: true,
      draftId: opDraftId,
      subtasks: staged.map((s) => ({ draftId: s.draftId, title: s.title, effortMinutes: s.effortMinutes })),
      note: "DRAFT ONLY — nothing is saved until the user reviews and applies the changeset.",
      ...(splitCount > 0
        ? {
            warnings: [
              `${splitCount} subtask(s) exceeded max_draw_effort (${ctx.maxDrawEffort} min) and were ` +
                "split into parts preserving the stated total (split, never clamp).",
            ],
          }
        : {}),
    }),
  };
}

// ---------------------------------------------------------------------------
// Apply-plan validation (pure half of the apply step)

/**
 * Structural validation of the reviewed operations before any write: draft
 * ids must be unique, and every draft parent reference must point at a
 * create_task op EARLIER in the list (apply resolves parents in order).
 * Returns the 400 message or null.
 */
export function applyPlanError(operations: StagedOp[]): string | null {
  const seen = new Set<string>();
  const taskDrafts = new Set<string>();
  for (const op of operations) {
    if (seen.has(op.draftId)) return `duplicate draftId ${op.draftId}`;
    seen.add(op.draftId);
    const parentRef = op.kind === "create_task" ? op.task.parentId : op.parentId;
    if (isDraftId(parentRef) && !taskDrafts.has(parentRef)) {
      return (
        `${op.draftId} references draft parent ${parentRef}, which is not a create_task ` +
        "operation earlier in the list — a deselected parent deselects its subtasks"
      );
    }
    if (op.kind === "create_subtasks") {
      for (const s of op.subtasks) {
        if (seen.has(s.draftId)) return `duplicate draftId ${s.draftId}`;
        seen.add(s.draftId);
      }
    } else {
      taskDrafts.add(op.draftId);
    }
  }
  return null;
}
