import type express from "express";

/**
 * The temp DATA_DIR is set by test/setup.ts before any import touches
 * src/db.ts — one fresh database per test file (forked pool).
 *
 * Every suite gets today's daily challenge PRE-PAID at 0 XP (#231): which
 * completion would otherwise trigger the +50 payout depends on what the
 * calendar day hashes to, so an exact-XP assertion could pass on complete-3
 * days and fail on drawn-2 days — the #219 green-some-days class of flake.
 * The neutralizer uses the product's own idempotency row (INSERT OR IGNORE
 * against UNIQUE(reason, ref)), not a behavior fork; a suite that WANTS the
 * payout (daily-challenge.test.ts) deletes its ledger rows and takes over.
 */
export async function freshApp(): Promise<express.Express> {
  const { createApp } = await import("../src/app.js");
  const app = createApp();
  const { db } = await import("../src/db.js");
  const { localDate } = await import("../src/services/localDay.js");
  db.prepare(
    "INSERT OR IGNORE INTO xp_ledger (amount, reason, ref, created_at) VALUES (0, 'challenge', ?, ?)",
  ).run(localDate(new Date()), new Date().toISOString());
  return app;
}

/** Direct DB access for seeding/asserting (same instance the app uses). */
export async function testDb() {
  const { db } = await import("../src/db.js");
  return db;
}

// ---------------------------------------------------------------------------
// Anthropic SDK mock strictness (#138)

/**
 * The SDK-level message the real count_tokens endpoint returns for a
 * file-source document block — observed live in #138. Mocked `countTokens`
 * implementations throw their suite's mocked `APIError(400, THIS)` when a
 * request carries one, so CI fails exactly where production would instead of
 * staying green on a request shape the API rejects (the mock-blindness class
 * of #133/#138).
 */
export const COUNT_TOKENS_FILE_SOURCE_ERROR =
  '400 {"type":"invalid_request_error","message":"File sources are not supported in the token counting endpoint."}';

/**
 * The first `{type: "file"}` document source inside a count_tokens request, or
 * null. Pure param inspection — the caller owns throwing its suite's mocked
 * APIError, because `mapSdkError`'s instanceof checks only match the class the
 * suite's own vi.mock factory installed.
 */
export function findFileSource(params: unknown): { file_id?: string } | null {
  const messages = (params as { messages?: { content?: unknown }[] } | undefined)?.messages ?? [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as {
      type?: string;
      source?: { type?: string; file_id?: string };
    }[]) {
      if (block?.type === "document" && block.source?.type === "file") return block.source;
    }
  }
  return null;
}
