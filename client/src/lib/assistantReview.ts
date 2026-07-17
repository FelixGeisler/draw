import type { StagedOp } from "../hooks/useAssistant";

// Pure review-state model for the Assistant page's staged-changes card (#31,
// ADR-37): per-draft inclusion + the two editable fields, the parent→child
// exclusion cascade, and the exact operations the apply commits — extracted
// here so the cascade rules are unit-testable without rendering.

/** Per-draft review state: inclusion plus the two editable fields. */
export interface RowEdit {
  included: boolean;
  title: string;
  effortMinutes: number | null;
}

export function seedEdits(ops: StagedOp[], prev: Record<string, RowEdit>): Record<string, RowEdit> {
  const next = { ...prev };
  for (const op of ops) {
    if (op.kind === "create_task") {
      next[op.draftId] ??= {
        included: true,
        title: op.task.title,
        effortMinutes: op.task.effortMinutes ?? null,
      };
    } else {
      for (const s of op.subtasks) {
        next[s.draftId] ??= { included: true, title: s.title, effortMinutes: s.effortMinutes ?? null };
      }
    }
  }
  return next;
}

/** Deselecting a parent draft deselects everything staged under it. */
export function cascadeExclusions(
  ops: StagedOp[],
  edits: Record<string, RowEdit>,
): Record<string, RowEdit> {
  const next = { ...edits };
  const excludedParents = new Set(
    ops
      .filter((op) => op.kind === "create_task" && !next[op.draftId]?.included)
      .map((op) => op.draftId),
  );
  for (const op of ops) {
    const parentRef = op.kind === "create_task" ? op.task.parentId : op.parentId;
    if (typeof parentRef !== "string" || !excludedParents.has(parentRef)) continue;
    if (op.kind === "create_task") {
      if (next[op.draftId]?.included) next[op.draftId] = { ...next[op.draftId], included: false };
      excludedParents.add(op.draftId); // one level deep, but stay safe
    } else {
      for (const s of op.subtasks) {
        if (next[s.draftId]?.included) next[s.draftId] = { ...next[s.draftId], included: false };
      }
    }
  }
  return next;
}

/**
 * The reviewed (edited, included) operations — exactly what apply commits.
 *
 * A parent draft drops out of the plan two ways: unchecked, or its title
 * cleared. Either way its children must drop WITH it — the server's
 * applyPlanError rejects any op referencing a draft parent that is not in
 * the list, and would 400 the whole apply. The checkbox path also cascades
 * through the edits (cascadeExclusions, for the visual state); this pass is
 * the structural guarantee covering both paths. Staging order puts parents
 * before children, so one forward pass suffices.
 */
export function buildOperations(ops: StagedOp[], edits: Record<string, RowEdit>): StagedOp[] {
  const included = (draftId: string) => edits[draftId]?.included ?? true;
  const applied = new Set<string>(); // create_task drafts that survived review
  const result: StagedOp[] = [];
  for (const op of ops) {
    if (op.kind === "create_task") {
      const e = edits[op.draftId];
      const parentDropped =
        typeof op.task.parentId === "string" && !applied.has(op.task.parentId);
      if (!included(op.draftId) || !e?.title.trim() || parentDropped) continue;
      applied.add(op.draftId);
      result.push({
        ...op,
        task: {
          ...op.task,
          title: e.title.trim(),
          // The minutes input can be cleared (null) — omit, don't send 0 (#84).
          effortMinutes:
            e.effortMinutes != null && e.effortMinutes > 0
              ? Math.round(e.effortMinutes)
              : undefined,
        },
      });
    } else {
      const parentIncluded = typeof op.parentId !== "string" || applied.has(op.parentId);
      if (!parentIncluded) continue;
      const subtasks = op.subtasks
        .filter((s) => included(s.draftId) && edits[s.draftId]?.title.trim())
        .map((s) => {
          const e = edits[s.draftId];
          return {
            ...s,
            title: e.title.trim(),
            effortMinutes:
              e.effortMinutes != null && e.effortMinutes > 0
                ? Math.round(e.effortMinutes)
                : undefined,
          };
        });
      if (subtasks.length > 0) result.push({ ...op, subtasks });
    }
  }
  return result;
}

export function countChanges(operations: StagedOp[]): number {
  return operations.reduce(
    (n, op) => n + (op.kind === "create_task" ? 1 : op.subtasks.length),
    0,
  );
}
