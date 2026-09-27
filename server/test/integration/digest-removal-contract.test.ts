import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function filesUnder(relative: string): string[] {
  const root = path.join(repoRoot, relative);
  const visit = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? visit(absolute) : [path.relative(repoRoot, absolute).replaceAll("\\", "/")];
  });
  return visit(root);
}

function filesContaining(files: string[], expression: RegExp): string[] {
  return files.filter((file) => expression.test(fs.readFileSync(path.join(repoRoot, file), "utf8"))).sort();
}

describe("atomic deadline-to-digest removal contract", () => {
  const runtime = [
    ...filesUnder("server/src"),
    ...filesUnder("client/src"),
    ...filesUnder("client/public"),
  ];

  it("has no runnable reminder modules, aliases, payloads, lead API or Push-named landing", () => {
    expect(filesContaining(runtime, /deadlineScheduler|deadlineEvaluator|deadlineEventId|pushLanding|Push landing/)).toEqual([]);
    expect(filesContaining(filesUnder("e2e"), /pushLanding|Push landing/)).toEqual([]);
    expect(filesContaining(runtime, /kind\s*:\s*["']deadline["']/)).toEqual([]);
    expect(filesContaining(runtime, /leadDays/)).toEqual([]);
  });

  it("limits legacy persistence names to migration validation and sanitation boundaries", () => {
    expect(filesContaining(runtime, /deadline_reminder_claims/)).toEqual([
      "server/src/db.ts",
      "server/src/schemaV20.ts",
      "server/src/schemaV21.ts",
      "server/src/services/backupService.ts",
    ]);
    expect(filesContaining(runtime, /push_lead_days/)).toEqual([
      "server/src/db.ts",
      "server/src/schemaV20.ts",
      "server/src/schemaV21.ts",
    ]);
  });

  it("pins current documentation to v21 digest language and ADR-73", () => {
    const active = [
      "docs/modules/ROOT/pages/05_building_block_view.adoc",
      "docs/modules/ROOT/pages/06_runtime_view.adoc",
      "docs/modules/ROOT/pages/07_deployment_view.adoc",
      "docs/modules/ROOT/pages/08_crosscutting_concepts.adoc",
      "docs/modules/ROOT/pages/10_quality_requirements.adoc",
    ];
    expect(filesContaining(active, /deadline_reminder_claims|push_lead_days|leadDays|kind:["']deadline["']/)).toEqual([]);
    const decisions = fs.readFileSync(
      path.join(repoRoot, "docs/modules/ROOT/pages/09_architecture_decisions.adoc"),
      "utf8",
    );
    expect(decisions).toContain("== ADR-73: One bounded morning digest atomically replaces automatic per-item reminders");
    expect(decisions).toContain("this ADR supersedes ADR-72");
  });
});
