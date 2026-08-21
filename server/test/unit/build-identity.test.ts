import { afterEach, describe, expect, it } from "vitest";
import {
  appVersion,
  normalizeBuildChannel,
  normalizeBuildSha,
  updateStatus,
} from "../../src/services/updateService.js";

const ORIGINAL_CHANNEL = process.env.DRAW_BUILD_CHANNEL;
const ORIGINAL_SHA = process.env.DRAW_BUILD_SHA;
const LOWER_SHA = "0123456789abcdef0123456789abcdef01234567";
const UPPER_SHA = LOWER_SHA.toUpperCase();

afterEach(() => {
  if (ORIGINAL_CHANNEL === undefined) delete process.env.DRAW_BUILD_CHANNEL;
  else process.env.DRAW_BUILD_CHANNEL = ORIGINAL_CHANNEL;
  if (ORIGINAL_SHA === undefined) delete process.env.DRAW_BUILD_SHA;
  else process.env.DRAW_BUILD_SHA = ORIGINAL_SHA;
});

describe("build channel normalization", () => {
  it.each<[string | undefined, string]>([
    [undefined, "local"],
    ["", "local"],
    ["   \t", "local"],
    ["stable", "stable"],
    [" edge ", "edge"],
    ["local", "local"],
    ["preview", "local"],
    ["Stable", "local"],
    ["EDGE", "local"],
  ])("normalizes %j to %s", (input, expected) => {
    expect(normalizeBuildChannel(input)).toBe(expected);
  });
});

describe("build SHA normalization", () => {
  it.each<[string | undefined, string | null]>([
    [undefined, null],
    ["", null],
    ["   \t", null],
    [LOWER_SHA, LOWER_SHA],
    [` ${UPPER_SHA} `, LOWER_SHA],
    ["g".repeat(40), null],
    ["a".repeat(39), null],
    ["a".repeat(41), null],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeBuildSha(input)).toBe(expected);
  });
});

describe("build identity", () => {
  it("uses the normalized channel and full SHA when one is valid", () => {
    process.env.DRAW_BUILD_CHANNEL = " edge ";
    process.env.DRAW_BUILD_SHA = UPPER_SHA;
    expect(updateStatus()).toMatchObject({
      buildChannel: "edge",
      buildSha: LOWER_SHA,
      buildIdentity: `edge:${LOWER_SHA}`,
    });
  });

  it("falls back to the current package version for ordinary local defaults", () => {
    delete process.env.DRAW_BUILD_CHANNEL;
    delete process.env.DRAW_BUILD_SHA;
    expect(updateStatus()).toMatchObject({
      buildChannel: "local",
      buildSha: null,
      buildIdentity: `local:version-${appVersion()}`,
    });
  });
});
