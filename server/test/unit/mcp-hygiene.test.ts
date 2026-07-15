import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Issue #36 acceptance: the MCP layer must never open the database itself —
// every read/write goes through the HTTP API where the domain invariants
// live — and must never write to stdout (the JSON-RPC channel).

const srcDir = fileURLToPath(new URL("../../src", import.meta.url));

const MCP_FILES = [
  "mcp.ts",
  "mcpServer.ts",
  path.join("tools", "catalog.ts"),
  path.join("tools", "httpApi.ts"),
];

describe("MCP layer hygiene", () => {
  for (const file of MCP_FILES) {
    const content = fs.readFileSync(path.join(srcDir, file), "utf-8");

    it(`${file} never imports the database`, () => {
      expect(content).not.toMatch(/["'][^"']*\bdb\.js["']/);
      expect(content).not.toContain("better-sqlite3");
    });

    it(`${file} never writes to stdout (console.log)`, () => {
      expect(content).not.toMatch(/\bconsole\.log\(/);
      expect(content).not.toMatch(/\bprocess\.stdout\.write\(/);
    });
  }

  it("the MCP entrypoint and bindings exist where documented", () => {
    for (const file of MCP_FILES) {
      expect(fs.existsSync(path.join(srcDir, file))).toBe(true);
    }
  });
});

// The SDK-free catalog contract (#31, ADR-19): the tool catalog and its HTTP
// binding stay importable without the MCP or Anthropic SDKs, so the in-app
// assistant can bind the same catalog to staged executors. mcp.ts and
// mcpServer.ts legitimately import the MCP SDK; the tools/ files never may.
const SDK_FREE_FILES = [path.join("tools", "catalog.ts"), path.join("tools", "httpApi.ts")];

describe("tool catalog stays SDK-free (one catalog, two bindings)", () => {
  for (const file of SDK_FREE_FILES) {
    const content = fs.readFileSync(path.join(srcDir, file), "utf-8");

    it(`${file} never imports @modelcontextprotocol or @anthropic-ai`, () => {
      expect(content).not.toContain("@modelcontextprotocol");
      expect(content).not.toContain("@anthropic-ai");
    });
  }
});
