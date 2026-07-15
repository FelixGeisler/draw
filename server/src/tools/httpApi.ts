import { ApiUnreachableError, type ApiClient, type ApiResponse } from "./catalog.js";

/**
 * Live ApiClient for the tool catalog: plain fetch against the local Draw
 * API (loopback only — arc42 section 2). No MCP or Anthropic imports here
 * either; the MCP binding lives in src/mcpServer.ts.
 */
export class HttpApiClient implements ApiClient {
  constructor(readonly baseUrl: string) {}

  async request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<ApiResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      // fetch only rejects on network-level failures (ECONNREFUSED & co) —
      // HTTP error statuses resolve normally.
      throw new ApiUnreachableError(this.baseUrl);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body (should not happen for /api/*) — pass the raw text on
    }
    return { status: res.status, body: parsed };
  }

  /** Binary GET for material downloads (draw://materials/{id} file blobs). */
  async requestBinary(
    path: string,
  ): Promise<{ status: number; bytes: Uint8Array; contentType: string | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`);
    } catch {
      throw new ApiUnreachableError(this.baseUrl);
    }
    return {
      status: res.status,
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type"),
    };
  }
}
