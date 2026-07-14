import type express from "express";

/**
 * The temp DATA_DIR is set by test/setup.ts before any import touches
 * src/db.ts — one fresh database per test file (forked pool).
 */
export async function freshApp(): Promise<express.Express> {
  const { createApp } = await import("../src/app.js");
  return createApp();
}

/** Direct DB access for seeding/asserting (same instance the app uses). */
export async function testDb() {
  const { db } = await import("../src/db.js");
  return db;
}
