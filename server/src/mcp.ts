import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolvePassword } from "./config.js";
import { buildMcpServer } from "./mcpServer.js";
import { HttpApiClient } from "./tools/httpApi.js";

// Draw's MCP server (issue #36, ADR-19): a thin stdio adapter that exposes
// the domain operations to MCP clients (Claude Code, Claude Desktop). It
// talks HTTP to the running local API — `npm run dev` must be up — and needs
// no ANTHROPIC_API_KEY: the intelligence is the MCP client's.
//
// Protocol hygiene: stdout is the JSON-RPC channel. Nothing in this process
// may console.log — diagnostics go to stderr.

const baseUrl =
  process.env.DRAW_API_URL ?? `http://127.0.0.1:${Number(process.env.API_PORT) || 3001}`;

// Against a password-protected instance (#190, ADR-50) the shared secret
// rides along as a header. It comes from THIS process's env — dotenv above
// loads server/.env (npm -w runs with cwd server/), the same file the server
// reads — never from the committed .mcp.json.
const server = buildMcpServer(new HttpApiClient(baseUrl, resolvePassword()));

// When the client disconnects (stdin closes), exit instead of lingering.
// Deferred a tick so libuv finishes tearing the stdio handles down first.
process.stdin.on("close", () => setImmediate(() => process.exit(0)));

await server.connect(new StdioServerTransport());
console.error(`[draw-mcp] ready (API: ${baseUrl})`);
