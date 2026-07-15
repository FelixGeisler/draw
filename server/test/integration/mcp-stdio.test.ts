import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end over the real transport (issue #36): the API runs in-process on
// an ephemeral port (temp DATA_DIR via test/setup.ts), and the MCP server is
// spawned as a child process with the exact invocation the committed
// .mcp.json uses — `npm run -s mcp -w server` from the repo root. If anything
// but JSON-RPC frames appeared on stdout, the handshake would fail (protocol
// hygiene); if the npm invocation broke on Windows, this test would too.

let httpServer: Server;
let base: string;

beforeAll(async () => {
  const { startServer } = await import("../../src/server.js");
  httpServer = startServer(0);
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer?.close(resolve));
});

describe("MCP server over stdio (child process, .mcp.json invocation)", () => {
  it(
    "handshakes and round-trips list_tasks + create_task + draw_card",
    async () => {
      const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const transport = new StdioClientTransport({
        command: "npm",
        args: ["run", "-s", "mcp", "-w", "server"],
        cwd: repoRoot,
        env: { ...getDefaultEnvironment(), DRAW_API_URL: base },
      });
      const client = new Client({ name: "stdio-roundtrip", version: "0.0.0" });

      try {
        await client.connect(transport);

        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(
          expect.arrayContaining(["list_tasks", "create_task", "draw_card"]),
        );

        const empty = await client.callTool({ name: "list_tasks", arguments: {} });
        expect(empty.isError ?? false).toBe(false);
        expect(JSON.parse((empty.content as Array<{ text: string }>)[0].text)).toEqual([]);

        const created = await client.callTool({
          name: "create_task",
          arguments: { title: "Stdio card", categoryId: 1, effortMinutes: 10 },
        });
        expect(created.isError ?? false).toBe(false);
        const task = JSON.parse((created.content as Array<{ text: string }>)[0].text) as {
          id: number;
          title: string;
        };
        expect(task.title).toBe("Stdio card");

        const listed = await client.callTool({ name: "list_tasks", arguments: {} });
        const tasks = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as Array<{
          id: number;
        }>;
        expect(tasks.map((t) => t.id)).toContain(task.id);

        const drawn = await client.callTool({ name: "draw_card", arguments: {} });
        expect(drawn.isError ?? false).toBe(false);
        const draw = JSON.parse((drawn.content as Array<{ text: string }>)[0].text) as {
          task: { id: number };
          poolSize: number;
        };
        expect(draw.task.id).toBe(task.id);
        expect(draw.poolSize).toBe(1);
      } finally {
        await client.close();
      }
    },
    120_000,
  );
});
