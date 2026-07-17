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
