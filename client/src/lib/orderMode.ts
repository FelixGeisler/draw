import type { Task } from "../api/types";

/**
 * Seed for the AI breakdown's "Do in order" toggle (#67). Accepting an AI
 * breakdown always sends an explicit orderMode, so seeding from the model's
 * `orderMatters` judgment alone could silently flip an already-sequential
 * parent back to parallel on a re-breakdown (or an explicitly-parallel one
 * to sequential). A parent that was broken down before therefore keeps its
 * persisted mode; the model's judgment only pre-sets parents without an
 * existing mode. The user has the last word via the checkbox either way.
 */
export function seedInOrder(
  orderMatters: boolean,
  existingOrderMode?: Task["subtaskOrderMode"],
): boolean {
  return existingOrderMode != null ? existingOrderMode === "sequential" : orderMatters;
}
