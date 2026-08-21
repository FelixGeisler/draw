import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_NOTICE_KEY,
  consumeUpdateNotice,
  formatUpdateNotice,
  parseUpdateNotice,
  serializeUpdateNotice,
  shouldReloadAfterApply,
  type UpdateNotice,
} from "./updateNotice";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const shaNotice: UpdateNotice = {
  v: 1,
  kind: "sha",
  buildChannel: "edge",
  buildSha: SHA,
};
const packageNotice: UpdateNotice = {
  v: 1,
  kind: "package",
  buildChannel: "stable",
  current: "1.2.3-rc.1",
};

describe("UPDATE_NOTICE_KEY", () => {
  it("is namespaced and tab-scoped by its sessionStorage caller", () => {
    expect(UPDATE_NOTICE_KEY).toBe("draw.updateNotice");
  });
});

describe("serializeUpdateNotice / parseUpdateNotice", () => {
  it("writes and accepts only the exact versioned SHA shape", () => {
    const raw = serializeUpdateNotice(shaNotice);
    expect(raw).toBe(
      '{"v":1,"kind":"sha","buildChannel":"edge","buildSha":"0123456789abcdef0123456789abcdef01234567"}',
    );
    expect(parseUpdateNotice(raw)).toEqual(shaNotice);
  });

  it("writes and accepts only the exact versioned package fallback shape", () => {
    const raw = serializeUpdateNotice(packageNotice);
    expect(raw).toBe(
      '{"v":1,"kind":"package","buildChannel":"stable","current":"1.2.3-rc.1"}',
    );
    expect(parseUpdateNotice(raw)).toEqual(packageNotice);
  });

  it("accepts every approved lower-case channel", () => {
    for (const buildChannel of ["stable", "edge", "local"] as const) {
      expect(
        parseUpdateNotice(JSON.stringify({ ...shaNotice, buildChannel })),
      ).toEqual({ ...shaNotice, buildChannel });
    }
  });

  it("rejects absent, blank, invalid JSON, legacy, and non-object values", () => {
    for (const raw of [
      null,
      "",
      "   ",
      "1.2.3",
      "v1.2.3",
      "{",
      "null",
      "true",
      "[]",
      JSON.stringify([shaNotice]),
    ]) {
      expect(parseUpdateNotice(raw)).toBeNull();
    }
  });

  it("rejects missing or extra keys and wrong discriminants or types", () => {
    const invalid = [
      { v: 1, kind: "sha", buildChannel: "edge" },
      { ...shaNotice, extra: true },
      { v: 1, kind: "package", buildChannel: "stable" },
      { ...packageNotice, extra: true },
      { ...shaNotice, v: "1" },
      { ...shaNotice, kind: "SHA" },
      { ...shaNotice, buildChannel: 1 },
      { ...shaNotice, buildSha: null },
      { ...packageNotice, current: 123 },
    ];
    for (const value of invalid) {
      expect(parseUpdateNotice(JSON.stringify(value))).toBeNull();
    }
  });

  it("rejects wrong-case channels and invalid SHA values", () => {
    for (const value of [
      { ...shaNotice, buildChannel: "Edge" },
      { ...shaNotice, buildChannel: "EDGE" },
      { ...shaNotice, buildChannel: "beta" },
      { ...shaNotice, buildSha: "" },
      { ...shaNotice, buildSha: "0123456789abcdef0123456789abcdef0123456" },
      { ...shaNotice, buildSha: "0123456789abcdef0123456789abcdef012345678" },
      { ...shaNotice, buildSha: "0123456789ABCDEF0123456789ABCDEF01234567" },
      { ...shaNotice, buildSha: "g123456789abcdef0123456789abcdef01234567" },
      { ...shaNotice, buildSha: ` ${SHA}` },
    ]) {
      expect(parseUpdateNotice(JSON.stringify(value))).toBeNull();
    }
  });

  it("rejects blank, trimmed, v-prefixed, incomplete, and invalid package versions", () => {
    for (const current of [
      "",
      " ",
      " 1.2.3",
      "1.2.3 ",
      "v1.2.3",
      "1.2",
      "1.2.3.4",
      "01.2.x",
      "1.2.3-",
      "1.2.3-rc..1",
      "1.2.3+build",
    ]) {
      expect(parseUpdateNotice(JSON.stringify({ ...packageNotice, current }))).toBeNull();
    }
  });
});

describe("formatUpdateNotice", () => {
  it("shortens a lower-case SHA only in the exact notice message", () => {
    expect(formatUpdateNotice(shaNotice)).toBe("Updated to edge build 0123456789ab");
    expect(shaNotice.buildSha).toHaveLength(40);
  });

  it("formats the exact package fallback message", () => {
    expect(formatUpdateNotice(packageNotice)).toBe("Updated to Draw 1.2.3-rc.1 (stable build)");
  });
});

describe("consumeUpdateNotice", () => {
  it("reads once, removes once, and returns a valid message once", () => {
    let raw: string | null = serializeUpdateNotice(shaNotice);
    const storage = {
      getItem: vi.fn(() => raw),
      removeItem: vi.fn(() => {
        raw = null;
      }),
    };

    expect(consumeUpdateNotice(storage)).toBe("Updated to edge build 0123456789ab");
    expect(consumeUpdateNotice(storage)).toBeNull();
    expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
  });

  it("silently removes every present malformed or legacy value", () => {
    for (const raw of ["1.2.3", "{", "{}", JSON.stringify({ ...shaNotice, extra: true })]) {
      const storage = {
        getItem: vi.fn(() => raw),
        removeItem: vi.fn(),
      };
      expect(consumeUpdateNotice(storage)).toBeNull();
      expect(storage.getItem).toHaveBeenCalledOnce();
      expect(storage.removeItem).toHaveBeenCalledOnce();
    }
  });

  it("does not remove an absent value", () => {
    const storage = { getItem: vi.fn(() => null), removeItem: vi.fn() };
    expect(consumeUpdateNotice(storage)).toBeNull();
    expect(storage.getItem).toHaveBeenCalledOnce();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("is silent when reading or removing storage fails", () => {
    const readFailure = {
      getItem: vi.fn(() => {
        throw new Error("disabled");
      }),
      removeItem: vi.fn(),
    };
    expect(consumeUpdateNotice(readFailure)).toBeNull();
    expect(readFailure.removeItem).not.toHaveBeenCalled();

    const removalFailure = {
      getItem: vi.fn(() => serializeUpdateNotice(packageNotice)),
      removeItem: vi.fn(() => {
        throw new Error("disabled");
      }),
    };
    expect(consumeUpdateNotice(removalFailure)).toBeNull();
    expect(removalFailure.removeItem).toHaveBeenCalledOnce();
  });
});

describe("shouldReloadAfterApply", () => {
  it("reloads for a changed canonical identity even when the package version is unchanged", () => {
    expect(shouldReloadAfterApply("edge:aaaaaaaa", "edge:bbbbbbbb")).toBe(true);
  });

  it("does not reload for an unchanged identity", () => {
    expect(shouldReloadAfterApply("edge:aaaaaaaa", "edge:aaaaaaaa")).toBe(false);
  });

  it("does not reload for a null or failed poll result", () => {
    expect(shouldReloadAfterApply("edge:aaaaaaaa", null)).toBe(false);
  });
});
