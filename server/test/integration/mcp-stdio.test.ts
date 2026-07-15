import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
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
// .mcp.json uses — `npm run -s mcp -w server` from the repo root. If the npm
// invocation broke on Windows, this test would too. Note the SDK client does
// NOT prove stdout hygiene — its reader skips unparseable lines instead of
// failing — so a second test below captures the child's raw stdout with a
// plain pipe and asserts every line is a JSON-RPC frame (#67).

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

  it(
    "emits nothing but JSON-RPC frames on raw stdout (protocol hygiene)",
    async () => {
      // A plain child_process pipe, no SDK in between: dotenv preloads, a
      // stray console.log, or a dep that logs on import would all land here
      // byte-for-byte, where the SDK client would silently skip them.
      const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
      const options = {
        cwd: repoRoot,
        env: { ...process.env, DRAW_API_URL: base },
        stdio: ["pipe", "pipe", "ignore"] as ["pipe", "pipe", "ignore"],
      };
      // npm is npm.cmd on Windows — it needs a shell to launch, and with a
      // shell the whole command goes as ONE string (an args array under
      // shell:true is concatenated unescaped — DEP0190).
      const child =
        process.platform === "win32"
          ? spawn("npm run -s mcp -w server", { ...options, shell: true })
          : spawn("npm", ["run", "-s", "mcp", "-w", "server"], options);
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      let stdout = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => (stdout += chunk));

      try {
        // Hand-rolled handshake + tools/list over newline-delimited JSON-RPC.
        const send = (msg: Record<string, unknown>) =>
          child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
        send({
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw-stdout-probe", version: "0.0.0" },
          },
        });
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/list" });

        // Wait until the tools/list response line arrived complete.
        const frames = () =>
          stdout
            .split(/\r?\n/)
            .filter((line) => line.trim() !== "")
            .flatMap((line) => {
              try {
                return [JSON.parse(line) as { jsonrpc?: string; id?: number; result?: unknown }];
              } catch {
                return [];
              }
            });
        const deadline = Date.now() + 90_000;
        while (!frames().some((f) => f.id === 2) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        // mcp.ts exits on stdin close; kill() stays as the backstop.
        child.stdin!.end();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
        child.kill();
      }

      // The raw assertion: every non-empty stdout line parses as a JSON-RPC
      // 2.0 frame — nothing else ever appeared on the channel.
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
      expect(lines.length).toBeGreaterThanOrEqual(2); // initialize + tools/list
      for (const line of lines) {
        const frame = JSON.parse(line) as { jsonrpc?: string };
        expect(frame.jsonrpc).toBe("2.0");
      }
      // And the exchange was a real one: the id:2 frame lists the catalog.
      const toolsList = lines
        .map((line) => JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } })
        .find((f) => f.id === 2);
      expect(toolsList?.result?.tools?.map((t) => t.name)).toContain("list_tasks");
    },
    120_000,
  );
});
