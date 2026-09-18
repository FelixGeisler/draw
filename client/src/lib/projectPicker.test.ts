import { describe, expect, it } from "vitest";
import type { Category } from "../api/types";
import {
  ALL_PROJECTS_OPTION,
  moveProjectPickerActive,
  projectOptionId,
  projectOptions,
} from "./projectPicker";

const categories: Category[] = [
  { id: 8, name: "Home Projects", color: "#123456", isDefault: 0 },
  { id: 3, name: "Deep Work", color: "#abcdef", isDefault: 0 },
  { id: 12, name: "Errands", color: "#654321", isDefault: 0 },
];

describe("project picker options", () => {
  it("keeps All projects first and preserves API order", () => {
    expect(projectOptions(categories, "").map((option) => option.name)).toEqual([
      "All projects",
      "Home Projects",
      "Deep Work",
      "Errands",
    ]);
  });

  it("matches a trimmed, case-insensitive name substring without hiding All projects", () => {
    expect(projectOptions(categories, "  PROj  ").map((option) => option.name)).toEqual([
      "All projects",
      "Home Projects",
    ]);
    expect(projectOptions(categories, "missing").map((option) => option.name)).toEqual([
      "All projects",
    ]);
  });
});

describe("project picker keyboard movement", () => {
  const ids = [ALL_PROJECTS_OPTION, projectOptionId(8), projectOptionId(3)] as const;

  it("moves in visible order and clamps at either end", () => {
    expect(moveProjectPickerActive(ids, ALL_PROJECTS_OPTION, "next")).toBe(projectOptionId(8));
    expect(moveProjectPickerActive(ids, projectOptionId(8), "next")).toBe(projectOptionId(3));
    expect(moveProjectPickerActive(ids, projectOptionId(3), "next")).toBe(projectOptionId(3));
    expect(moveProjectPickerActive(ids, ALL_PROJECTS_OPTION, "previous")).toBe(
      ALL_PROJECTS_OPTION,
    );
  });

  it("moves directly to the first or last visible option", () => {
    expect(moveProjectPickerActive(ids, projectOptionId(8), "first")).toBe(ALL_PROJECTS_OPTION);
    expect(moveProjectPickerActive(ids, ALL_PROJECTS_OPTION, "last")).toBe(projectOptionId(3));
  });
});
