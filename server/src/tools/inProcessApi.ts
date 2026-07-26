import http from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { PASSWORD_HEADER } from "../auth.js";
import { ApiUnreachableError, type ApiClient, type ApiResponse } from "./catalog.js";

/**
 * ApiClient for the in-app assistant's READ tools (#31, ADR-37): dispatches
 * against THIS process's own Express app over a private loopback listener.
 * The catalog's contract is HTTP against the local API (ADR-19 — the domain
 * invariants and the derived read payloads live in the route layer, so going
 * through it keeps them intact by construction), but the assistant cannot
 * assume the public API_PORT is known or even bound (integration tests run
 * the app under supertest without listening). So the client lazily binds its
 * own ephemeral 127.0.0.1 port on the same app instance — literally the same
 * code path the web UI uses, reachable in every environment, never exposed
 * beyond loopback, and unref()ed so it cannot hold the process open.
 *
 * `password` (#190, ADR-50): when the app runs behind the password gate,
 * these self-requests must carry the shared secret too — the gate cannot
 * tell the app's own loopback listener from a stranger's socket. createApp()
 * passes the same secret it mounted the gate with.
 */
export class InProcessApiClient implements ApiClient {
  private server?: http.Server;
  private baseUrl?: Promise<string>;

  constructor(
    private readonly app: express.Express,
    private readonly password?: string,
  ) {}

  private ensure(): Promise<string> {
    if (!this.baseUrl) {
      this.baseUrl = new Promise((resolve, reject) => {
        const server = http.createServer(this.app);
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.unref();
          this.server = server;
          const { port } = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${port}`);
        });
      });
    }
    return this.baseUrl;
  }

  async request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<ApiResponse> {
    const base = await this.ensure();
    const headers = {
      ...(this.password ? { [PASSWORD_HEADER]: this.password } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    };
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiUnreachableError(base);
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

  /** Test hygiene: closes the private listener (idempotent). */
  close(): void {
    this.server?.close();
    this.server = undefined;
    this.baseUrl = undefined;
  }
}
