import Anthropic, { toFile } from "@anthropic-ai/sdk";
import fs from "node:fs";
import { db } from "../db.js";

/**
 * Anthropic Files API for goal materials (#92, ADR-35).
 *
 * A goal's PDF is uploaded ONCE and referenced by file id from then on,
 * instead of re-sending the whole base64 payload with every AI call (section
 * 11 R5). This module owns the id and nothing else: block assembly and the
 * retry-once policy live in aiService, which is the only caller.
 *
 * The id is a CACHE, never identity (ADR-35). It names a file inside the
 * Anthropic account behind the *current* API key, so it can go stale for
 * reasons this app cannot observe: the key was swapped for another account's,
 * a backup was restored on a different machine (#61 — the archive carries the
 * material rows AND the PDFs, but Anthropic-side state cannot travel with
 * them), or the file expired server-side. Nothing here treats a stored id as
 * proof the file exists; the PDF under files/ stays the source of truth and
 * can always rebuild the request.
 */

/**
 * Beta header gating the Files API. Required on BOTH the upload and every
 * messages call that references a returned id. count_tokens never references
 * one: the endpoint REJECTS file sources outright (#138), so the token guard
 * counts a base64 substitute and needs no beta.
 *
 * Verified against the installed @anthropic-ai/sdk (0.111), not assumed: the
 * GA `DocumentBlockParam.source` union is base64/text/content/url only — the
 * `{type: "file", file_id}` source exists solely as `BetaFileDocumentSource`.
 * That is why aiService talks to `client.beta.messages.*` at all.
 */
export const FILES_BETA = "files-api-2025-04-14";

/** The columns this module needs; `MaterialRow` in aiService is a superset. */
export interface UploadableMaterial {
  id: number;
  filename: string | null;
  anthropic_file_id: string | null;
}

/**
 * The one Files-API operation this app performs, narrowed to a plain function
 * so the cache policy below is testable without the SDK or a network. The
 * repo's other AI tests mock whole service modules (card-art); here the seam
 * is an argument instead, because the logic under test lives *inside*
 * aiService's own module graph.
 */
export type PdfUploader = (filePath: string, filename: string) => Promise<string>;

/** The real uploader. `betas` is explicit — the header is not optional here. */
export function sdkUploader(client: Anthropic): PdfUploader {
  return async (filePath, filename) => {
    const uploaded = await client.beta.files.upload({
      file: await toFile(fs.createReadStream(filePath), filename, { type: "application/pdf" }),
      betas: [FILES_BETA],
    });
    return uploaded.id;
  };
}

/**
 * The material's file id, uploading once on first AI use.
 *
 * Upload is lazy — deliberately NOT done when the user adds the material:
 * most materials never reach an AI call, and at upload time there may be no
 * API key at all (degraded mode is the default state of a fresh install).
 *
 * Returns null when no id can be had — no key, or the upload failed. Callers
 * fall back to base64, so the Files API can never be the reason an AI feature
 * breaks: a quota error, an outage, or the beta being withdrawn costs
 * bandwidth, not function. A failed upload is not remembered, so the next
 * call simply tries again.
 */
export async function ensureFileId(
  m: UploadableMaterial,
  filePath: string,
  upload: PdfUploader | null,
): Promise<string | null> {
  if (m.anthropic_file_id) return m.anthropic_file_id;
  if (!upload) return null;
  try {
    const id = await upload(filePath, m.filename ?? "material.pdf");
    db.prepare("UPDATE materials SET anthropic_file_id = ? WHERE id = ?").run(id, m.id);
    return id;
  } catch {
    return null;
  }
}

/**
 * Drop the cached ids for these materials: Anthropic rejected one, so every
 * id in the batch is suspect (they were uploaded under the same key, and the
 * usual causes — restored backup, swapped key — invalidate all of them at
 * once). The next assembly re-uploads from disk.
 */
export function invalidateFileIds(materialIds: number[]) {
  if (materialIds.length === 0) return;
  const placeholders = materialIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE materials SET anthropic_file_id = NULL WHERE id IN (${placeholders})`,
  ).run(...materialIds);
}

/**
 * Drop every cached id. Called when the API key changes (routes/ai.ts): the
 * ids belong to the account behind the OLD key, so under a new one they are
 * at best useless and at worst point at a stranger's file. The lazy 404 path
 * would heal this eventually — this just makes the invalidation immediate and
 * total, which is what "the id is a cache scoped to the key" actually means.
 */
export function invalidateAllFileIds() {
  db.prepare("UPDATE materials SET anthropic_file_id = NULL WHERE anthropic_file_id IS NOT NULL").run();
}
