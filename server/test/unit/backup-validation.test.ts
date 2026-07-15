import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildManifest,
  fileEntryTarget,
  MANIFEST_APP,
  validateManifest,
} from "../../src/services/backupService.js";

// Pure validation logic only — the archive round trip, the swap, and the
// migration path live in test/integration/backup.test.ts.

describe("validateManifest", () => {
  it("accepts exactly what buildManifest produces (export and import cannot drift apart)", () => {
    const manifest = buildManifest(
      7,
      { tasks: 3, goals: 1, materials: 2 },
      "2026-07-15T00:00:00.000Z",
    );
    expect(validateManifest(manifest)).toBeNull();
    // Survives the JSON round trip the zip performs.
    expect(validateManifest(JSON.parse(JSON.stringify(manifest)))).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(validateManifest(null)).toMatch(/not an object/);
    expect(validateManifest("draw-task-planner")).toMatch(/not an object/);
    expect(validateManifest(42)).toMatch(/not an object/);
    expect(validateManifest([MANIFEST_APP])).toMatch(/not an object/);
  });

  it("rejects a foreign or missing app marker", () => {
    expect(validateManifest({ userVersion: 7 })).toMatch(/not exported by this app/);
    expect(validateManifest({ app: "some-other-tool", userVersion: 7 })).toMatch(
      /not exported by this app/,
    );
  });

  it("rejects a missing, fractional, or pre-schema userVersion", () => {
    expect(validateManifest({ app: MANIFEST_APP })).toMatch(/userVersion/);
    expect(validateManifest({ app: MANIFEST_APP, userVersion: 1.5 })).toMatch(/userVersion/);
    expect(validateManifest({ app: MANIFEST_APP, userVersion: 0 })).toMatch(/userVersion/);
    expect(validateManifest({ app: MANIFEST_APP, userVersion: "7" })).toMatch(/userVersion/);
  });
});

describe("fileEntryTarget (zip-slip guard)", () => {
  // Absolute on every platform — CI runs Linux, development runs Windows, and
  // the guard must behave identically on both.
  const staging = path.resolve("staging-probe");

  it("maps files/ entries into the staging directory", () => {
    expect(fileEntryTarget("files/lecture.pdf", staging)).toBe(path.join(staging, "lecture.pdf"));
    expect(fileEntryTarget("files/nested/notes.txt", staging)).toBe(
      path.join(staging, "nested", "notes.txt"),
    );
  });

  it("rejects the bare directory entry", () => {
    expect(fileEntryTarget("files/", staging)).toBeNull();
  });

  it("rejects traversal out of the staging directory", () => {
    expect(fileEntryTarget("files/../evil.txt", staging)).toBeNull();
    expect(fileEntryTarget("files/../../evil.txt", staging)).toBeNull();
    expect(fileEntryTarget("files/..\\evil.txt", staging)).toBeNull();
    expect(fileEntryTarget("files/nested/../../evil.txt", staging)).toBeNull();
  });

  it("rejects absolute paths smuggled after the prefix", () => {
    expect(fileEntryTarget("files//etc/passwd", staging)).toBeNull();
    expect(fileEntryTarget("files/C:\\Windows\\evil.dll", staging)).toBeNull();
  });

  it("an entry resolving to the staging root itself is rejected", () => {
    expect(fileEntryTarget("files/.", staging)).toBeNull();
  });
});
