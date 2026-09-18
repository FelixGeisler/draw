import type { Category } from "../api/types";

export const ALL_PROJECTS_OPTION = "all-projects" as const;
export type ProjectOptionId = typeof ALL_PROJECTS_OPTION | `project-${number}`;

export interface ProjectOption {
  id: ProjectOptionId;
  name: string;
  color?: string;
  categoryId?: number;
}

export function projectOptionId(categoryId: number): ProjectOptionId {
  return `project-${categoryId}`;
}

/** All projects is the permanent clear action; matching projects retain API order. */
export function projectOptions(
  categories: readonly Category[],
  query: string,
): ProjectOption[] {
  const needle = query.trim().toLocaleLowerCase();
  const matching = needle
    ? categories.filter((category) => category.name.toLocaleLowerCase().includes(needle))
    : categories;

  return [
    { id: ALL_PROJECTS_OPTION, name: "All projects" },
    ...matching.map((category) => ({
      id: projectOptionId(category.id),
      name: category.name,
      color: category.color,
      categoryId: category.id,
    })),
  ];
}

export type ProjectPickerMove = "previous" | "next" | "first" | "last";

/** Clamp keyboard movement at the list ends instead of unexpectedly wrapping. */
export function moveProjectPickerActive(
  ids: readonly ProjectOptionId[],
  active: ProjectOptionId,
  move: ProjectPickerMove,
): ProjectOptionId {
  if (ids.length === 0) return ALL_PROJECTS_OPTION;
  if (move === "first") return ids[0];
  if (move === "last") return ids[ids.length - 1];

  const current = Math.max(0, ids.indexOf(active));
  const offset = move === "next" ? 1 : -1;
  return ids[Math.min(ids.length - 1, Math.max(0, current + offset))];
}
