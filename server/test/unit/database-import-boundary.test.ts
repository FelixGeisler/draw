import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../src", import.meta.url));

function productionTypescript(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypescript(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("production native-binding boundary", () => {
  it("allows runtime better-sqlite3 imports only in db.ts and staged backup code", () => {
    const runtimeImporters: string[] = [];
    for (const file of productionTypescript(sourceRoot)) {
      const source = fs.readFileSync(file, "utf8");
      const runtimeImport = /^import\s+(?!type\b)[^;\n]+from\s+["']better-sqlite3["']/m.test(source);
      const dynamicImport = /(?:import\s*\(\s*|require\s*\(\s*)["']better-sqlite3["']/.test(source);
      if (runtimeImport || dynamicImport) runtimeImporters.push(path.relative(sourceRoot, file).replaceAll("\\", "/"));
    }
    expect(runtimeImporters.sort()).toEqual(["db.ts", "services/backupService.ts"]);
  });

  it("keeps explicit ordinary seams on SafeDatabase rather than native Database", () => {
    for (const relative of [
      "prod.ts",
      "push/service.ts",
      "push/digestScheduler.ts",
      "push/digestEvaluator.ts",
      "services/dailyOverviewService.ts",
      "services/fixedSlots.ts",
    ]) {
      const source = fs.readFileSync(path.join(sourceRoot, relative), "utf8");
      expect(source, relative).not.toMatch(/import\s+type\s+Database\s+from\s+["']better-sqlite3["']/);
      expect(source, relative).toContain("SafeDatabase");
    }
  });
});
