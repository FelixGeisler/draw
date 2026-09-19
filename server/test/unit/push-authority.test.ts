import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import webPush from "web-push";
import {
  AUTHORITY_FILE,
  PushLifecycle,
  RESET_MARKER,
  RESTORE_MARKER,
  REVOKE_MARKER,
  validateAuthorityDocument,
  type AuthorityDocument,
} from "../../src/push/authority.js";

const roots: string[] = [];
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "draw-push-authority-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

function lifecycle(dataDir: string, password?: string, fault?: (point: string) => void) {
  let deletes = 0;
  const instance = new PushLifecycle({
    dataDir,
    password,
    deleteSubscriptions: () => {
      deletes += 1;
    },
    fault,
  });
  return { instance, deletes: () => deletes };
}

function authority(dataDir: string): AuthorityDocument {
  return JSON.parse(fs.readFileSync(path.join(dataDir, AUTHORITY_FILE), "utf8")) as AuthorityDocument;
}

function validDocument(): AuthorityDocument {
  const keys = webPush.generateVAPIDKeys();
  return {
    version: 1,
    generation: crypto.randomBytes(16).toString("base64url"),
    vapid: keys,
    password: { kind: "none" },
  };
}

describe("production Push authority", () => {
  it("creates a closed, canonical v1 document and reuses it for the same effective password", () => {
    const dataDir = root();
    const first = lifecycle(dataDir, "påssword");
    expect(first.instance.snapshot()).toMatchObject({ available: true, reason: null });
    expect(first.deletes()).toBe(1); // missing authority always takes the reset sequence
    const stored = authority(dataDir);
    expect(() => validateAuthorityDocument(stored)).not.toThrow();
    expect(Object.keys(stored).sort()).toEqual(["generation", "password", "vapid", "version"]);
    expect(JSON.stringify(stored)).not.toContain("påssword");
    expect(fs.statSync(path.join(dataDir, AUTHORITY_FILE)).size).toBeLessThanOrEqual(8192);

    const second = lifecycle(dataDir, "påssword");
    expect(second.deletes()).toBe(0);
    expect(second.instance.snapshot().generation).toBe(stored.generation);
  });

  it("uses only already-resolved UTF-8 bytes and rotates for effective add/change/removal", () => {
    const dataDir = root();
    const absent = lifecycle(dataDir, undefined).instance.snapshot().generation;
    // Unset, empty and whitespace-only all arrive from resolvePassword as undefined.
    expect(lifecycle(dataDir, undefined).instance.snapshot().generation).toBe(absent);

    const outerWhitespaceResolved = lifecycle(dataDir, "secret").instance.snapshot().generation;
    expect(outerWhitespaceResolved).not.toBe(absent);
    // Different raw spellings that resolve to the same value are deliberately
    // indistinguishable at this boundary.
    expect(lifecycle(dataDir, "secret").instance.snapshot().generation).toBe(outerWhitespaceResolved);

    const composed = lifecycle(dataDir, "é").instance.snapshot().generation;
    const decomposed = lifecycle(dataDir, "e\u0301").instance.snapshot().generation;
    expect(decomposed).not.toBe(composed);
    const removed = lifecycle(dataDir, undefined).instance.snapshot().generation;
    expect(removed).not.toBe(decomposed);
  });

  it("rejects zero/out-of-range scalars, off-curve points, mismatched pairs and unknown fields", () => {
    const base = validDocument();
    expect(() => validateAuthorityDocument(base)).not.toThrow();

    expect(() =>
      validateAuthorityDocument({
        ...base,
        vapid: { ...base.vapid, privateKey: Buffer.alloc(32).toString("base64url") },
      }),
    ).toThrow();
    expect(() =>
      validateAuthorityDocument({
        ...base,
        vapid: { ...base.vapid, publicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0xff)]).toString("base64url") },
      }),
    ).toThrow();
    const other = validDocument();
    expect(() =>
      validateAuthorityDocument({ ...base, vapid: { publicKey: other.vapid.publicKey, privateKey: base.vapid.privateKey } }),
    ).toThrow(/mismatch/);
    expect(() => validateAuthorityDocument({ ...base, extra: true })).toThrow();
  });

  it("never overwrites malformed ordinary authority, but a valid recovery marker authorizes rotation", () => {
    const dataDir = root();
    lifecycle(dataDir);
    const authorityPath = path.join(dataDir, AUTHORITY_FILE);
    const malformed = Buffer.from('{"version":1,"private":"CANARY"}');
    fs.writeFileSync(authorityPath, malformed);

    const ordinary = lifecycle(dataDir);
    expect(ordinary.instance.snapshot()).toEqual({
      available: false,
      reason: "authority-unavailable",
      publicVapidKey: null,
      generation: null,
    });
    expect(fs.readFileSync(authorityPath).equals(malformed)).toBe(true);
    expect(ordinary.deletes()).toBe(0);

    fs.writeFileSync(path.join(dataDir, RESET_MARKER), Buffer.alloc(0));
    const recovered = lifecycle(dataDir);
    expect(recovered.instance.snapshot().available).toBe(true);
    expect(recovered.deletes()).toBe(1);
    expect(fs.existsSync(path.join(dataDir, RESET_MARKER))).toBe(false);
    expect(() => validateAuthorityDocument(authority(dataDir))).not.toThrow();
  });

  it("rejects symlink authority and recovery-marker targets without following them", () => {
    const dataDir = root();
    const outside = path.join(root(), "outside-canary");
    fs.writeFileSync(outside, "DO-NOT-OVERWRITE");
    try {
      fs.symlinkSync(outside, path.join(dataDir, AUTHORITY_FILE), "file");
      const linkedAuthority = lifecycle(dataDir);
      expect(linkedAuthority.instance.snapshot().reason).toBe("authority-unavailable");
      expect(fs.readFileSync(outside, "utf8")).toBe("DO-NOT-OVERWRITE");
      fs.rmSync(path.join(dataDir, AUTHORITY_FILE));
      fs.symlinkSync(outside, path.join(dataDir, RESET_MARKER), "file");
      const linkedMarker = lifecycle(dataDir);
      expect(linkedMarker.instance.snapshot().reason).toBe("recovery-pending");
      expect(fs.readFileSync(outside, "utf8")).toBe("DO-NOT-OVERWRITE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  it("combines any reset+restore+revoke marker subset into one conservative clear/rotation and rejects malformed markers", () => {
    const dataDir = root();
    const original = lifecycle(dataDir).instance.snapshot().generation;
    fs.writeFileSync(path.join(dataDir, RESET_MARKER), Buffer.alloc(0));
    fs.writeFileSync(path.join(dataDir, RESTORE_MARKER), Buffer.alloc(0));
    fs.writeFileSync(path.join(dataDir, REVOKE_MARKER), Buffer.alloc(0));
    const recovered = lifecycle(dataDir);
    expect(recovered.deletes()).toBe(1);
    expect(recovered.instance.snapshot().generation).not.toBe(original);
    expect(fs.existsSync(path.join(dataDir, RESET_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, REVOKE_MARKER))).toBe(false);

    fs.mkdirSync(path.join(dataDir, RESET_MARKER));
    const failed = lifecycle(dataDir);
    expect(failed.instance.snapshot().reason).toBe("recovery-pending");
    expect(fs.statSync(path.join(dataDir, RESET_MARKER)).isDirectory()).toBe(true);
  });

  it("fails closed at generation/temp/write/fsync/rename/reset crash points; directory fsync alone is tolerated", () => {
    for (const point of ["generation", "temp-create", "write", "file-fsync", "rename", "subscriptions-delete"]) {
      const dataDir = root();
      const failed = lifecycle(dataDir, undefined, (at) => {
        if (at === point) throw new Error(`synthetic ${point}`);
      });
      expect(failed.instance.snapshot().available).toBe(false);
      expect([
        "authority-unavailable",
        "recovery-pending",
      ]).toContain(failed.instance.snapshot().reason);
    }

    const dataDir = root();
    const tolerated = lifecycle(dataDir, undefined, (at) => {
      if (at === "directory-fsync") throw new Error("synthetic unsupported directory fsync");
    });
    expect(tolerated.instance.snapshot().available).toBe(true);
  });

  it("keeps every reset and restore crash boundary fail-closed and boot-recoverable", () => {
    for (const point of [
      "reset-after-marker",
      "reset-after-invalidate",
      "reset-after-delete",
      "reset-after-install",
      "marker-remove",
    ]) {
      const dataDir = root();
      let activePoint: string | undefined;
      const running = new PushLifecycle({
        dataDir,
        deleteSubscriptions: () => {},
        fault: (at) => {
          if (at === activePoint) throw new Error(`synthetic ${point}`);
        },
      });
      activePoint = point;
      expect(() => running.reset()).toThrow(/synthetic/);
      expect(running.snapshot().reason).toBe("recovery-pending");
      expect(fs.existsSync(path.join(dataDir, RESET_MARKER))).toBe(true);
      activePoint = undefined;
      expect(lifecycle(dataDir).instance.snapshot().available).toBe(true);
    }

    for (const point of ["restore-after-invalidate", "restore-after-marker"]) {
      const dataDir = root();
      let activePoint: string | undefined;
      const running = new PushLifecycle({
        dataDir,
        deleteSubscriptions: () => {},
        fault: (at) => {
          if (at === activePoint) throw new Error(`synthetic ${point}`);
        },
      });
      const original = running.snapshot();
      activePoint = point;
      expect(() => running.beginRestore()).toThrow(/synthetic/);
      expect(running.snapshot()).toEqual(original);
      expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(false);
    }

    for (const point of ["restore-finalize-after-delete", "restore-finalize-after-install", "marker-remove"]) {
      const dataDir = root();
      let activePoint: string | undefined;
      const running = new PushLifecycle({
        dataDir,
        deleteSubscriptions: () => {},
        fault: (at) => {
          if (at === activePoint) throw new Error(`synthetic ${point}`);
        },
      });
      running.beginRestore();
      activePoint = point;
      expect(() => running.completeRestore()).toThrow(/synthetic/);
      expect(running.snapshot().reason).toBe("recovery-pending");
      expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(true);
      activePoint = undefined;
      expect(lifecycle(dataDir).instance.snapshot().available).toBe(true);
    }
  });

  it("revoke preserves state before delete and fails closed without row restoration after delete", () => {
    for (const point of ["generation", "revoke-after-marker", "revoke-after-invalidate", "subscriptions-delete"]) {
      const dataDir = root();
      let activePoint: string | undefined;
      let deletes = 0;
      const running = new PushLifecycle({
        dataDir,
        deleteSubscriptions: () => { deletes += 1; },
        fault: (at) => { if (at === activePoint) throw new Error(`synthetic ${point}`); },
      });
      const before = running.snapshot();
      const beforeDeletes = deletes;
      activePoint = point;
      expect(() => running.revokeAll()).toThrow(/synthetic/);
      expect(running.snapshot()).toEqual(before);
      expect(deletes).toBe(beforeDeletes);
      expect(fs.existsSync(path.join(dataDir, REVOKE_MARKER))).toBe(false);
    }

    for (const point of ["revoke-after-delete", "revoke-install", "revoke-after-install", "marker-remove"]) {
      const dataDir = root();
      let activePoint: string | undefined;
      let deletes = 0;
      const running = new PushLifecycle({
        dataDir,
        deleteSubscriptions: () => { deletes += 1; },
        fault: (at) => { if (at === activePoint) throw new Error(`synthetic ${point}`); },
      });
      const beforeDeletes = deletes;
      activePoint = point;
      expect(() => running.revokeAll()).toThrow(/synthetic/);
      expect(deletes).toBe(beforeDeletes + 1);
      expect(running.snapshot().reason).toBe("recovery-pending");
      expect(fs.existsSync(path.join(dataDir, REVOKE_MARKER))).toBe(true);
      activePoint = undefined;
      expect(lifecycle(dataDir).instance.snapshot().available).toBe(true);
      expect(fs.existsSync(path.join(dataDir, REVOKE_MARKER))).toBe(false);
    }
  });

  it("restore abort resumes old generation; finalization failure leaves a boot-recoverable marker", () => {
    const dataDir = root();
    const running = lifecycle(dataDir).instance;
    const original = running.snapshot().generation;
    running.beginRestore();
    expect(running.snapshot().reason).toBe("recovery-pending");
    running.abortRestore();
    expect(running.snapshot().generation).toBe(original);
    expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(false);

    let failDelete = false;
    const crashing = new PushLifecycle({
      dataDir,
      deleteSubscriptions: () => {
        if (failDelete) throw new Error("synthetic post-commit failure");
      },
    });
    crashing.beginRestore();
    failDelete = true;
    expect(() => crashing.completeRestore()).toThrow(/synthetic/);
    expect(crashing.snapshot().reason).toBe("recovery-pending");
    expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(true);

    const boot = lifecycle(dataDir);
    expect(boot.instance.snapshot().available).toBe(true);
    expect(boot.deletes()).toBe(1);
    expect(fs.existsSync(path.join(dataDir, RESTORE_MARKER))).toBe(false);
  });
});
