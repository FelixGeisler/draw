import { useState } from "react";
import type { Task } from "../api/types";
import { useUpdateTask } from "../hooks/useTasks";
import { useEstimationBias } from "../hooks/useEstimationBias";
import { estimateHint, hintText } from "../lib/estimationCoach";

/**
 * Inline Enter-to-save estimate for the triage strip's needs-estimate rows
 * (#151, formerly on the Capture page): type minutes, hit Enter, the task
 * re-classifies and leaves the strip — no edit form round-trip for the one
 * missing field.
 *
 * Since #232 the strip row gets the same estimation hint TaskForm has had
 * since #55, tap-to-apply included: this is where estimates are typed under
 * the least reflection, which is exactly where history is worth a whisper.
 * The field stays the authority — applying merely types the number, Enter
 * still saves, and the hint dismisses once applied (recomputing it off the
 * applied value would scale the bias again and chase its own tail).
 */
export function EstimateInput({ task, categoryName }: { task: Task; categoryName?: string }) {
  const updateTask = useUpdateTask();
  const bias = useEstimationBias();
  const [value, setValue] = useState("");
  const [appliedHint, setAppliedHint] = useState<number | null>(null);

  const rawHint = estimateHint(
    bias.data?.find((b) => b.categoryId === task.categoryId),
    value === "" ? null : Number(value),
  );
  const hint = appliedHint != null && value === String(appliedHint) ? null : rawHint;

  function save(minutes: number) {
    // Enter-keydown bypasses the form's `step` validation and the API
    // wants integer minutes (#84) — round at the send boundary.
    const v = Math.round(minutes);
    if (v > 0) updateTask.mutate({ id: task.id, effortMinutes: v });
  }

  return (
    <>
      <input
        type="number"
        min={1}
        placeholder="min"
        style={{ width: 70 }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save(Number(value));
        }}
      />
      {hint && (
        <span
          data-testid="estimate-hint"
          aria-live="polite"
          style={{ color: "var(--text-dim)", fontSize: 12 }}
        >
          {hintText(hint, categoryName ?? "")}{" "}
          <button
            type="button"
            data-testid="estimate-hint-apply"
            style={{ padding: "0 8px", fontSize: 12 }}
            onClick={() => {
              setValue(String(hint.suggestedMinutes));
              setAppliedHint(hint.suggestedMinutes);
            }}
          >
            use {hint.suggestedMinutes} min
          </button>
        </span>
      )}
      {/* A failed save must not leave the task silently stuck here. */}
      {updateTask.isError && (
        <span role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>
          {(updateTask.error as Error).message}
        </span>
      )}
    </>
  );
}
