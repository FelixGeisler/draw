import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import type express from "express";
import { createApp } from "../../src/app.js";
import { parseForestQueryTarget } from "../../src/routes/forest.js";
import { freshApp, testDb } from "../helpers.js";

let app: express.Express;
let taskId: number;

beforeAll(async () => {
  app = await freshApp();
});

beforeEach(async () => {
  const database = await testDb();
  database.prepare("DELETE FROM tasks").run();
  taskId = Number(database.prepare(
    "INSERT INTO tasks(title,category_id,created_at) VALUES ('forest fixture',1,'2026-01-01T00:00:00.000Z')",
  ).run().lastInsertRowid);
  database.close();
});

function insertRows(
  database: Awaited<ReturnType<typeof testDb>>,
  count: number,
  reason: "done" | "stop" = "done",
): number[] {
  const ids: number[] = [];
  const insert = database.prepare(
    `INSERT INTO time_entries(task_id,started_at,ended_at,end_reason)
     VALUES (?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.001Z',?)`,
  );
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      ids.push(Number(insert.run(taskId, reason).lastInsertRowid));
    }
  })();
  return ids;
}

async function rawRequest(
  server: Server,
  method: string,
  target: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: "127.0.0.1", port, method, path: target, headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const invalidPaths = [
  "/api/forest?beforeId=",
  "/api/forest?beforeId=0",
  "/api/forest?beforeId=-1",
  "/api/forest?beforeId=+1",
  "/api/forest?beforeId=01",
  "/api/forest?beforeId=1.0",
  "/api/forest?beforeId=1e2",
  "/api/forest?beforeId=%31",
  "/api/forest?beforeId=%201",
  "/api/forest?beforeId=9007199254740992",
  "/api/forest?beforeId=1234567890123456&beforeId=1",
  "/api/forest?other=1",
  "/api/forest?beforeId=1&",
  "/api/forest/?beforeId=1",
];

describe("GET /api/forest request contract", () => {
  it("accepts only the exact bodyless GET grammar and never writes on rejection", async () => {
    const database = await testDb();
    insertRows(database, 1);
    const before = database.prepare("SELECT COUNT(*) AS n FROM time_entries").get();
    database.close();

    for (const target of invalidPaths) {
      const response = await request(app).get(target);
      expect(response.status, target).toBe(400);
      expect(response.body, target).toEqual({ error: "invalid-forest-request" });
      expect(response.headers["cache-control"], target).toBe("no-store");
    }
    expect(parseForestQueryTarget("/api/forest?")).toBeUndefined();
    const prefix = "/api/forest?unknown=";
    const atLimit = `${prefix}${"x".repeat(2_048 - Buffer.byteLength(prefix))}`;
    const oversized = `${atLimit}x`;
    expect(Buffer.byteLength(atLimit)).toBe(2_048);
    expect(Buffer.byteLength(oversized)).toBe(2_049);
    expect((await request(app).get(atLimit)).body).toEqual({ error: "invalid-forest-request" });
    expect((await request(app).get(oversized)).body).toEqual({ error: "invalid-forest-request" });
    expect((await request(app).get("/api/forest?beforeId=9007199254740991")).status).toBe(200);

    for (const method of ["post", "put", "patch", "delete"] as const) {
      const response = await request(app)[method]("/api/forest");
      expect(response.status, method).toBe(400);
      expect(response.body, method).toEqual({ error: "invalid-forest-request" });
    }
    const contentLength = await request(app).get("/api/forest").set("Content-Length", "0");
    expect(contentLength.status).toBe(400);
    expect(contentLength.body).toEqual({ error: "invalid-forest-request" });

    const afterDb = await testDb();
    expect(afterDb.prepare("SELECT COUNT(*) AS n FROM time_entries").get()).toEqual(before);
    afterDb.close();
  });

  it("rejects blank raw query and transfer framing, with exact wire bodies", async () => {
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const blank = await rawRequest(server, "GET", "/api/forest?");
      expect(blank.status).toBe(400);
      expect(blank.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(blank.body)).toEqual({ error: "invalid-forest-request" });
      const chunked = await rawRequest(server, "GET", "/api/forest", {
        "Transfer-Encoding": "chunked",
      });
      expect(chunked.status).toBe(400);
      expect(chunked.headers["cache-control"]).toBe("no-store");
      expect(JSON.parse(chunked.body)).toEqual({ error: "invalid-forest-request" });
      expect(parseForestQueryTarget("/api/forest?beforeId=é")).toBeUndefined();
      const encodedNonAscii = await request(app).get("/api/forest?beforeId=é");
      expect(encodedNonAscii.status).toBe(400);
      expect(encodedNonAscii.body).toEqual({ error: "invalid-forest-request" });
      const head = await rawRequest(server, "HEAD", "/api/forest");
      expect(head.status).toBe(400);
      expect(head.headers["cache-control"]).toBe("no-store");
      expect(head.body).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("returns authenticated HEAD as 400 with no body", async () => {
    const response = await request(app).head("/api/forest");
    expect(response.status).toBe(400);
    expect(response.text).toBeUndefined();
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("keeps authentication precedence for malformed and HEAD requests", async () => {
    const protectedApp = createApp({ password: "forest-secret" });
    expect((await request(protectedApp).get("/api/forest?bad=1")).status).toBe(401);
    expect((await request(protectedApp).head("/api/forest")).status).toBe(401);
    const malformed = await request(protectedApp)
      .get("/api/forest?bad=1")
      .set("x-draw-password", "forest-secret");
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "invalid-forest-request" });
    const head = await request(protectedApp)
      .head("/api/forest")
      .set("x-draw-password", "forest-secret");
    expect(head.status).toBe(400);
    expect(head.text).toBeUndefined();
  });
});

describe("GET /api/forest bounded feed", () => {
  it("publishes exact trees, timestamp boundaries and zero-duration sessions", async () => {
    const database = await testDb();
    const insert = database.prepare(
      "INSERT INTO time_entries(task_id,started_at,ended_at,end_reason) VALUES (?,?,?,?)",
    );
    const first = Number(insert.run(
      taskId,
      "0001-01-01T00:00:00.000Z",
      "0001-01-01T00:00:00.000Z",
      "done",
    ).lastInsertRowid);
    const second = Number(insert.run(
      taskId,
      "9999-12-31T23:59:59.999Z",
      "9999-12-31T23:59:59.999Z",
      "stop",
    ).lastInsertRowid);
    database.prepare(
      "INSERT INTO time_entries(task_id,started_at,ended_at) VALUES (?,?,?)",
    ).run(taskId, "2020-01-01T00:00:00.000Z", "2020-01-01T00:01:00.000Z");
    database.prepare(
      "INSERT INTO time_entries(task_id,started_at) VALUES (?,?)",
    ).run(taskId, "2026-01-01T00:00:00.000Z");
    database.close();

    const response = await request(app).get("/api/forest").expect(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      trees: [
        {
          id: second,
          startedAt: "9999-12-31T23:59:59.999Z",
          endedAt: "9999-12-31T23:59:59.999Z",
          endReason: "stop",
        },
        {
          id: first,
          startedAt: "0001-01-01T00:00:00.000Z",
          endedAt: "0001-01-01T00:00:00.000Z",
          endReason: "done",
        },
      ],
      nextBeforeId: null,
    });
  });

  it("admits the upper safe id boundary without rounding", async () => {
    const database = await testDb();
    database.prepare(
      "INSERT INTO time_entries(id,task_id,started_at,ended_at,end_reason) VALUES (?,?,?,?,?)",
    ).run(
      9_007_199_254_740_991,
      taskId,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.001Z",
      "done",
    );
    database.close();

    const response = await request(app).get("/api/forest").expect(200);
    expect(response.body.trees).toEqual([{
      id: 9_007_199_254_740_991,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.001Z",
      endReason: "done",
    }]);
    expect(response.body.nextBeforeId).toBeNull();
  });

  it("implements 99/100/101 lookahead, exclusive cursors, gaps and exhaustion", async () => {
    for (const count of [99, 100, 101]) {
      const database = await testDb();
      database.prepare("DELETE FROM time_entries").run();
      const ids = insertRows(database, count);
      if (count === 101) {
        database.prepare("DELETE FROM time_entries WHERE id=?").run(ids[40]);
        ids.splice(40, 1);
        ids.push(...insertRows(database, 1, "stop"));
      }
      database.close();

      const first = await request(app).get("/api/forest").expect(200);
      const expectedCount = Math.min(100, ids.length);
      expect(first.body.trees).toHaveLength(expectedCount);
      const expectedNext = ids.length > 100 ? first.body.trees[99].id : null;
      expect(first.body.nextBeforeId).toBe(expectedNext);
      expect(first.body.trees.map((tree: { id: number }) => tree.id)).toEqual(
        [...ids].sort((left, right) => right - left).slice(0, 100),
      );
      if (expectedNext !== null) {
        const second = await request(app).get(`/api/forest?beforeId=${expectedNext}`).expect(200);
        expect(second.body.trees.every((tree: { id: number }) => tree.id < expectedNext)).toBe(true);
        expect(second.body.nextBeforeId).toBeNull();
      }
    }
    const empty = await request(app).get("/api/forest?beforeId=1").expect(200);
    expect(empty.body).toEqual({ trees: [], nextBeforeId: null });
  });

  it("reads and validates only the selected 101-row keyset window", async () => {
    const database = await testDb();
    database.pragma("ignore_check_constraints=ON");
    const malformedId = Number(database.prepare(
      "INSERT INTO time_entries(task_id,started_at,ended_at,end_reason) VALUES (?,?,?,?)",
    ).run(taskId, "2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "done").lastInsertRowid);
    database.pragma("ignore_check_constraints=OFF");
    insertRows(database, 101);
    database.close();

    const first = await request(app).get("/api/forest").expect(200);
    expect(first.body.trees).toHaveLength(100);
    expect(first.body.nextBeforeId).toBe(first.body.trees[99].id);
    expect(first.body.trees.every((tree: { id: number }) => tree.id > malformedId)).toBe(true);

    const second = await request(app)
      .get(`/api/forest?beforeId=${first.body.nextBeforeId}`)
      .expect(500);
    expect(second.body).toEqual({ error: "forest-read-failed" });
  });

  it("fails the whole page on selected contract violations and actual database read errors", async () => {
    const database = await testDb();
    database.pragma("ignore_check_constraints=ON");
    database.prepare(
      "INSERT INTO time_entries(task_id,started_at,ended_at,end_reason) VALUES (?,?,?,?)",
    ).run(taskId, "2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "done");
    database.pragma("ignore_check_constraints=OFF");

    const contractFailure = await request(app).get("/api/forest");
    expect(contractFailure.status).toBe(500);
    expect(contractFailure.body).toEqual({ error: "forest-read-failed" });
    expect(contractFailure.headers["cache-control"]).toBe("no-store");

    database.exec("SAVEPOINT forest_read_failure; ALTER TABLE time_entries RENAME TO time_entries_unavailable");
    try {
      const readFailure = await request(app).get("/api/forest");
      expect(readFailure.status).toBe(500);
      expect(readFailure.body).toEqual({ error: "forest-read-failed" });
      expect(readFailure.headers["cache-control"]).toBe("no-store");
    } finally {
      database.exec("ROLLBACK TO forest_read_failure; RELEASE forest_read_failure");
      database.close();
    }
  });
});
