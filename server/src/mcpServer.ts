import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { API_DOWN_MESSAGE, ApiUnreachableError, TOOLS, executeTool } from "./tools/catalog.js";
import type { HttpApiClient } from "./tools/httpApi.js";

/**
 * Binds the shared tool catalog (src/tools/catalog.ts) to an MCP server with
 * live HTTP executors, plus the read-heavy state as MCP resources (issue #36,
 * ADR-19). This module never touches the database — every read and write
 * goes through the running HTTP API, which is where the domain invariants
 * live. Kept separate from the stdio entrypoint (src/mcp.ts) so integration
 * tests can bind it to an in-memory transport.
 */

interface MaterialMeta {
  id: number;
  goalId: number;
  kind: "file" | "note";
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  noteText: string | null;
}

export function buildMcpServer(api: HttpApiClient): McpServer {
  const server = new McpServer({ name: "draw", version: "0.1.0" });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.annotations.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        const outcome = await executeTool(tool.name, api, args ?? {});
        return {
          content: [{ type: "text" as const, text: outcome.text }],
          isError: outcome.isError === true,
        };
      },
    );
  }

  /** GET a JSON API response or throw a resource-read error. */
  async function getJson<T>(path: string): Promise<T> {
    let res;
    try {
      res = await api.request("GET", path);
    } catch (err) {
      throw err instanceof ApiUnreachableError ? new Error(API_DOWN_MESSAGE) : err;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GET ${path} failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return res.body as T;
  }

  async function allMaterials(): Promise<Array<MaterialMeta & { goalTitle: string }>> {
    const goals = await getJson<Array<{ id: number; title: string }>>("/api/goals?status=all");
    const result: Array<MaterialMeta & { goalTitle: string }> = [];
    for (const goal of goals) {
      const materials = await getJson<MaterialMeta[]>(`/api/goals/${goal.id}/materials`);
      result.push(...materials.map((m) => ({ ...m, goalTitle: goal.title })));
    }
    return result;
  }

  server.registerResource(
    "deck",
    "draw://deck",
    {
      title: "Drawable deck",
      description:
        "Snapshot of the drawable pool: candidates with impact/effort/due-date/weight, pool " +
        "size, max_draw_effort, and the currently running timer. Reading it has no side " +
        "effects — draw_card is the verb that actually draws.",
      mimeType: "application/json",
    },
    async (uri) => {
      const pool = await getJson<Record<string, unknown>>("/api/draw/pool");
      const runningTimer = await getJson<unknown>("/api/timer/current");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ...pool, runningTimer }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "gamification",
    "draw://gamification",
    {
      title: "Gamification state",
      description: "XP, level, streak, daily goal, today's completions, and achievements.",
      mimeType: "application/json",
    },
    async (uri) => {
      const state = await getJson<unknown>("/api/gamification");
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(state, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    "materials",
    new ResourceTemplate("draw://materials/{id}", {
      list: async () => ({
        resources: (await allMaterials()).map((m) => ({
          uri: `draw://materials/${m.id}`,
          name: m.kind === "file" ? (m.filename ?? `material-${m.id}`) : `note-${m.id}`,
          description: `${m.kind} attached to goal "${m.goalTitle}"`,
          mimeType: m.kind === "file" ? (m.mimeType ?? undefined) : "text/plain",
        })),
      }),
    }),
    {
      title: "Goal materials",
      description:
        "Content of a goal material by id (list_materials shows ids): note text as text/plain, " +
        "uploaded files (PDF/txt/md) as a base64 blob.",
    },
    async (uri, variables) => {
      const id = Number(variables.id);
      const material = (await allMaterials()).find((m) => m.id === id);
      if (!material) throw new Error(`material ${variables.id} not found`);

      if (material.kind === "note") {
        return {
          contents: [{ uri: uri.href, mimeType: "text/plain", text: material.noteText ?? "" }],
        };
      }

      let download;
      try {
        download = await api.requestBinary(`/api/materials/${id}/download`);
      } catch (err) {
        throw err instanceof ApiUnreachableError ? new Error(API_DOWN_MESSAGE) : err;
      }
      if (download.status !== 200) {
        throw new Error(`material file ${id} could not be downloaded (${download.status})`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: material.mimeType ?? download.contentType ?? "application/octet-stream",
            blob: Buffer.from(download.bytes).toString("base64"),
          },
        ],
      };
    },
  );

  return server;
}
