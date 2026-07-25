import { describe, expect, it } from "vitest";
import { DEFAULT_HOST, resolveApiPort, resolveHost } from "../../src/config.js";

// Explicit env objects throughout — the resolvers must not fall back to the
// ambient process.env of the test runner.

describe("resolveHost", () => {
  it("defaults to loopback when HOST is unset", () => {
    expect(resolveHost({})).toBe("127.0.0.1");
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("honors an explicit HOST", () => {
    expect(resolveHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveHost({ HOST: "192.168.0.42" })).toBe("192.168.0.42");
  });

  it("treats empty or whitespace HOST as unset", () => {
    expect(resolveHost({ HOST: "" })).toBe(DEFAULT_HOST);
    expect(resolveHost({ HOST: "   " })).toBe(DEFAULT_HOST);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveHost({ HOST: " 0.0.0.0 " })).toBe("0.0.0.0");
  });
});

describe("resolveApiPort", () => {
  it("defaults to 3001", () => {
    expect(resolveApiPort({})).toBe(3001);
  });

  it("honors API_PORT", () => {
    expect(resolveApiPort({ API_PORT: "3101" })).toBe(3101);
  });

  it("falls back on a non-numeric API_PORT", () => {
    expect(resolveApiPort({ API_PORT: "not-a-port" })).toBe(3001);
    expect(resolveApiPort({ API_PORT: "" })).toBe(3001);
  });

  it("ignores PORT — dev tooling injects it", () => {
    expect(resolveApiPort({ PORT: "9999" })).toBe(3001);
  });
});
