import { afterEach, describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BackupError,
  buildManifest,
  fileEntryTarget,
  MANIFEST_APP,
  stageFileEntries,
  validateManifest,
} from "../../src/services/backupService.js";

// Validation and staging logic only — the archive round trip, the swap, and
// the migration path live in test/integration/backup.test.ts.

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

  it("rejects Windows reserved device names in any segment, case, or extension", () => {
    // fs on Windows fails (or hits the console device) for these — without
    // the guard, staging them 500s instead of 400ing.
    expect(fileEntryTarget("files/CON", staging)).toBeNull();
    expect(fileEntryTarget("files/aux.txt", staging)).toBeNull();
    expect(fileEntryTarget("files/nested/NUL.pdf", staging)).toBeNull();
    expect(fileEntryTarget("files/com1", staging)).toBeNull();
    expect(fileEntryTarget("files/LPT9/notes.txt", staging)).toBeNull();
    // Names merely starting with a device name are ordinary files.
    expect(fileEntryTarget("files/console.txt", staging)).not.toBeNull();
    expect(fileEntryTarget("files/aux2.pdf", staging)).not.toBeNull();
    expect(fileEntryTarget("files/com10", staging)).not.toBeNull();
  });
});

describe("stageFileEntries (backslash-separated archives)", () => {
  // Some Windows zip tools write `\` as the entry separator. adm-zip strips
  // backslashes when WRITING entries, so a hostile/foreign archive is forged
  // by binary-patching same-length entry names after the fact — reading
  // preserves the raw name, which is exactly what the importer sees. (Same
  // technique as the integration zip-slip test.)
  function forgeEntries(renames: Record<string, string>): AdmZip.IZipEntry[] {
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from("{}"));
    for (const original of Object.keys(renames)) {
      zip.addFile(original, Buffer.from(`payload of ${original}`));
    }
    const buf = zip.toBuffer();
    for (const [original, forged] of Object.entries(renames)) {
      if (original.length !== forged.length) throw new Error("forged name must keep its length");
      const needle = Buffer.from(original);
      const patch = Buffer.from(forged);
      let idx = buf.indexOf(needle);
      while (idx !== -1) {
        patch.copy(buf, idx);
        idx = buf.indexOf(needle, idx + 1);
      }
    }
    return new AdmZip(buf).getEntries();
  }

  const tmpRoots: string[] = [];
  function tmpRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "draw-stage-"));
    tmpRoots.push(root);
    return root;
  }
  afterEach(() => {
    for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("stages a legit backslash-separated entry instead of silently dropping it", () => {
    const entries = forgeEntries({ "files/q/lecture.pdf": "files\\q\\lecture.pdf" });
    // The forgery worked: the archive really carries a backslash entry name.
    expect(entries.map((e) => e.entryName)).toContain("files\\q\\lecture.pdf");

    const staging = path.join(tmpRoot(), "staged");
    stageFileEntries(entries, staging);
    expect(fs.readFileSync(path.join(staging, "q", "lecture.pdf"), "utf-8")).toBe(
      "payload of files/q/lecture.pdf",
    );
  });

  it("rejects a backslashed zip-slip attempt with a 400 — not a skip, not an escape", () => {
    const entries = forgeEntries({ "files/zz/evil.txt": "files\\..\\evil.txt" });
    expect(entries.map((e) => e.entryName)).toContain("files\\..\\evil.txt");

    const root = tmpRoot();
    const staging = path.join(root, "staged");
    let caught: unknown;
    try {
      stageFileEntries(entries, staging);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BackupError);
    expect((caught as BackupError).status).toBe(400);
    expect((caught as BackupError).message).toMatch(/unsafe file path/);
    // Nothing landed outside the staging directory.
    expect(fs.existsSync(path.join(root, "evil.txt"))).toBe(false);
  });

  it("skips non-files/ entries without touching them", () => {
    const staging = path.join(tmpRoot(), "staged");
    const entries = forgeEntries({ "files/a.txt": "files/a.txt" });
    stageFileEntries(entries, staging);
    expect(fs.readdirSync(staging)).toEqual(["a.txt"]); // manifest.json was not staged
  });
});
