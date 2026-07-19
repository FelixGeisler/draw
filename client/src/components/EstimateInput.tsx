import type { Task } from "../api/types";
import { useUpdateTask } from "../hooks/useTasks";

/**
 * Inline Enter-to-save estimate for the triage strip's needs-estimate rows
 * (#151, formerly on the Capture page): type minutes, hit Enter, the task
 * re-classifies and leaves the strip — no edit form round-trip for the one
 * missing field.
 */
export function EstimateInput({ task }: { task: Task }) {
  const updateTask = useUpdateTask();
  return (
    <>
      <input
        type="number"
        min={1}
        placeholder="min"
        style={{ width: 70 }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Enter-keydown bypasses the form's `step` validation and the API
            // wants integer minutes (#84) — round at the send boundary.
            const v = Math.round(Number((e.target as HTMLInputElement).value));
            if (v > 0) updateTask.mutate({ id: task.id, effortMinutes: v });
          }
        }}
      />
      {/* A failed save must not leave the task silently stuck here. */}
      {updateTask.isError && (
        <span role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>
          {(updateTask.error as Error).message}
        </span>
      )}
    </>
  );
}
