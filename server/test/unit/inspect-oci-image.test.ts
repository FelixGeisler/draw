import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error JavaScript module has no declaration file.
import { runCli } from "../../../scripts/inspect-oci-image.mjs";

function harness(overrides: Record<string, unknown> = {}) {
  let stdout = "";
  let stderr = "";
  const signals = new EventEmitter();
  const transport = vi.fn(async () => { throw new Error("test transport stop"); });
  return {
    input: {
      argv: ["--image", "ghcr.io/felixgeisler/draw:edge"],
      env: {},
      stdout: { write(value: string) { stdout += value; } },
      stderr: { write(value: string) { stderr += value; } },
      transport,
      signals,
      ...overrides,
    },
    transport,
    output: () => ({ stdout, stderr }),
  };
}

describe("inspect-oci-image CLI input contract", () => {
  it("exports only the import-safe runner", async () => {
    // @ts-expect-error JavaScript module has no declaration file.
    const module = await import("../../../scripts/inspect-oci-image.mjs");
    expect(Object.keys(module)).toEqual(["runCli"]);
  });

  it.each([
    [],
    ["--image"],
    ["--image", "ghcr.io/felixgeisler/draw"],
    ["--image", "ghcr.io/felixgeisler/draw:"],
    ["--image", "https://ghcr.io/felixgeisler/draw:edge"],
    ["--image", "user@ghcr.io/felixgeisler/draw:edge"],
    ["--image", "ghcr.io:443/felixgeisler/draw:edge"],
    ["--image", "example.com/felixgeisler/draw:edge"],
    ["--image", "ghcr.io/FelixGeisler/draw:edge"],
    ["--image", "ghcr.io/felixgeisler/draw@sha256:" + "a".repeat(64)],
    ["--image", "ghcr.io/felixgeisler/draw:-bad"],
    ["--image", "ghcr.io/felixgeisler/draw:bad/tag"],
    ["--expected-revision", "a".repeat(40), "--image", "ghcr.io/felixgeisler/draw:edge"],
    ["--image", "ghcr.io/felixgeisler/draw:edge", "--expected-revision"],
    ["--image", "ghcr.io/felixgeisler/draw:edge", "--expected-revision", "A".repeat(40)],
    ["--image", "ghcr.io/felixgeisler/draw:edge", "--expected-revision", "a".repeat(39)],
    ["--image", "ghcr.io/felixgeisler/draw:edge", "--unknown", "x"],
    ["--image", "ghcr.io/felixgeisler/draw:edge", "--image", "ghcr.io/felixgeisler/draw:other"],
  ] as string[][])("rejects malformed syntax or values before network: %j", async (argv) => {
    const test = harness({ argv });
    await expect(runCli(test.input as any)).resolves.toBe(2);
    expect(test.transport).not.toHaveBeenCalled();
    expect(test.output().stdout).toBe("");
    expect(test.output().stderr).toMatch(/\n$/);
    expect(Buffer.byteLength(test.output().stderr)).toBeLessThanOrEqual(512);
  });

  it.each(["A", "_", "a.b-c_D", "a".repeat(128)])("accepts case-sensitive valid tag %s", async (tag) => {
    const test = harness({ argv: ["--image", `ghcr.io/felixgeisler/draw:${tag}`] });
    await expect(runCli(test.input as any)).resolves.toBe(1);
    expect(test.transport).toHaveBeenCalledTimes(1);
  });

  it("rejects a 129-byte tag before network", async () => {
    const test = harness({ argv: ["--image", `ghcr.io/felixgeisler/draw:${"a".repeat(129)}`] });
    await expect(runCli(test.input as any)).resolves.toBe(2);
    expect(test.transport).not.toHaveBeenCalled();
  });

  it.each([
    { OCI_REGISTRY_USERNAME: "user" },
    { OCI_REGISTRY_PASSWORD: "password" },
    { OCI_REGISTRY_USERNAME: "", OCI_REGISTRY_PASSWORD: "password" },
    { OCI_REGISTRY_USERNAME: "user", OCI_REGISTRY_PASSWORD: "" },
    { OCI_REGISTRY_USERNAME: "user name", OCI_REGISTRY_PASSWORD: "password" },
    { OCI_REGISTRY_USERNAME: "user", OCI_REGISTRY_PASSWORD: "pass\nword" },
    { OCI_REGISTRY_USERNAME: "usér", OCI_REGISTRY_PASSWORD: "password" },
    { OCI_REGISTRY_USERNAME: "user:name", OCI_REGISTRY_PASSWORD: "password" },
    { OCI_REGISTRY_USERNAME: "\u001f", OCI_REGISTRY_PASSWORD: "password" },
    { OCI_REGISTRY_USERNAME: "user", OCI_REGISTRY_PASSWORD: "\u007f" },
  ])("rejects invalid credential setup before network: %j", async (env) => {
    const test = harness({ env });
    await expect(runCli(test.input as any)).resolves.toBe(2);
    expect(test.transport).not.toHaveBeenCalled();
    expect(test.output().stdout).toBe("");
    expect(Buffer.byteLength(test.output().stderr)).toBeLessThanOrEqual(512);
  });

  it.each([
    {},
    { OCI_REGISTRY_USERNAME: "!", OCI_REGISTRY_PASSWORD: "~" },
    { OCI_REGISTRY_USERNAME: "user", OCI_REGISTRY_PASSWORD: "pass:word" },
  ])("accepts absent or visible-ASCII credential pairs: %j", async (env) => {
    const test = harness({ env });
    await expect(runCli(test.input as any)).resolves.toBe(1);
    expect(test.transport).toHaveBeenCalledTimes(1);
    expect(test.output()).toEqual({ stdout: "", stderr: "inspection failed: request or image validation failed\n" });
  });
});
