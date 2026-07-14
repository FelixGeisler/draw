/**
 * Impact rates a task's leverage toward its goal, so TaskForm only shows the
 * star picker for goal-linked tasks. But goal-less tasks with impact != 3
 * exist (goal deletion sets goal_id NULL, subtask breakdown of goal-less
 * parents), and impact feeds the draw weight (impact²) and the stats buckets
 * for ALL tasks — so editing a goal-less task must not silently reset its
 * stored impact. Deliberately unlinking a goal does reset to the default:
 * the rating described leverage toward the goal that was just removed.
 */
export function resolveSubmittedImpact(
  selectedGoalId: number | "",
  pickedImpact: number,
  initial?: { goalId?: number | null; impact?: number },
): number {
  if (selectedGoalId !== "") return pickedImpact;
  if (initial?.goalId != null) return 3; // goal deliberately unlinked
  return initial?.impact ?? 3;
}
