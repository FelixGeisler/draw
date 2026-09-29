import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureDatabase } from "../databaseFixture.js";

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

  it("contains no environment-selected global fixture bridge in production source", () => {
    const offenders: string[] = [];
    for (const file of productionTypescript(sourceRoot)) {
      const source = fs.readFileSync(file, "utf8");
      if (
        source.includes("draw.test.database-fixture") ||
        source.includes("Symbol.for(") ||
        /NODE_ENV\s*===\s*["']test["']/.test(source) ||
        /globalThis\s*(?:\.|\[)/.test(source)
      ) offenders.push(path.relative(sourceRoot, file).replaceAll("\\", "/"));
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the test-only fixture adapter data-only", async () => {
    await import("../../src/db.js");
    const fixture = createFixtureDatabase();
    const hasNativeCapability = (value: unknown): boolean => {
      if (value === null || value === undefined || typeof value !== "object") return false;
      if ("database" in value) return true;
      return Object.values(value).some(hasNativeCapability);
    };

    expect(Object.keys(fixture).sort()).toEqual([
      "close", "exec", "inTransaction", "open", "pragma", "prepare", "transaction",
    ]);
    for (const member of ["backup", "database", "loadExtension", "name", "serialize", "unsafeMode"]) {
      expect(member in fixture).toBe(false);
    }
    expect(fixture.exec("CREATE TABLE fixture_boundary(value TEXT)")).toBeUndefined();

    const run = fixture.prepare("INSERT INTO fixture_boundary(value) VALUES (?)").run("one");
    expect(Object.getPrototypeOf(run)).toBe(Object.prototype);
    expect(hasNativeCapability(run)).toBe(false);

    const pragma = fixture.pragma("database_list");
    expect(Array.isArray(pragma)).toBe(true);
    expect(hasNativeCapability(pragma)).toBe(false);
    expect(Object.getPrototypeOf((pragma as object[])[0])).toBe(Object.prototype);

    const receivers: unknown[] = [];
    const transaction = fixture.transaction(function (this: unknown, value: string) {
      receivers.push(this);
      return fixture.prepare("SELECT ? AS value").get(value);
    });
    for (const [index, variant] of [
      transaction,
      transaction.deferred,
      transaction.immediate,
      transaction.exclusive,
    ].entries()) {
      const result = Reflect.apply(variant, { database: fixture }, [`mode-${index}`]);
      expect(result).toEqual({ value: `mode-${index}` });
      expect(hasNativeCapability(result)).toBe(false);
    }
    expect(receivers).toEqual([undefined, undefined, undefined, undefined]);
    expect(fixture.close()).toBeUndefined();
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
