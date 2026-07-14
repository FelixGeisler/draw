import { Router } from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, filesDir } from "../db.js";

export const goalMaterialsRouter = Router({ mergeParams: true });
export const materialsRouter = Router();

const ALLOWED_MIME = new Set(["application/pdf", "text/plain", "text/markdown"]);
const ALLOWED_EXT = new Set([".pdf", ".txt", ".md"]);
const MAX_FILE_MB = 50;

const upload = multer({
  storage: multer.diskStorage({
    destination: filesDir,
    filename: (_req, file, cb) => {
      const safeBase = path
        .basename(file.originalname)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(-80);
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeBase}`);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

const MATERIAL_SELECT = `
  SELECT id, goal_id AS goalId, kind, filename, mime_type AS mimeType,
         size_bytes AS sizeBytes, note_text AS noteText, created_at AS createdAt
  FROM materials`;

goalMaterialsRouter.get("/", (req, res) => {
  const goalId = Number((req.params as { id: string }).id);
  res.json(db.prepare(`${MATERIAL_SELECT} WHERE goal_id = ? ORDER BY created_at ASC`).all(goalId));
});

goalMaterialsRouter.post("/", upload.single("file"), (req, res) => {
  const goalId = Number((req.params as { id: string }).id);
  const goal = db.prepare("SELECT id FROM goals WHERE id = ?").get(goalId);
  if (!goal) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: "goal not found" });
  }

  if (req.file) {
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_MIME.has(req.file.mimetype) && !ALLOWED_EXT.has(ext)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "only PDF, .txt and .md files are supported" });
    }
    const r = db
      .prepare(
        `INSERT INTO materials (goal_id, kind, filename, stored_name, mime_type, size_bytes, created_at)
         VALUES (?, 'file', ?, ?, ?, ?, ?)`,
      )
      .run(
        goalId,
        req.file.originalname,
        path.basename(req.file.path),
        req.file.mimetype,
        req.file.size,
        new Date().toISOString(),
      );
    return res.status(201).json(db.prepare(`${MATERIAL_SELECT} WHERE id = ?`).get(r.lastInsertRowid));
  }

  const noteText = req.body?.noteText;
  if (!noteText?.trim()) {
    return res.status(400).json({ error: "provide a file or noteText" });
  }
  const r = db
    .prepare("INSERT INTO materials (goal_id, kind, note_text, created_at) VALUES (?, 'note', ?, ?)")
    .run(goalId, noteText.trim(), new Date().toISOString());
  res.status(201).json(db.prepare(`${MATERIAL_SELECT} WHERE id = ?`).get(r.lastInsertRowid));
});

function storedPath(id: number): { row?: { stored_name: string | null; filename: string | null; mime_type: string | null }; path?: string } {
  const row = db
    .prepare("SELECT stored_name, filename, mime_type FROM materials WHERE id = ? AND kind = 'file'")
    .get(id) as { stored_name: string | null; filename: string | null; mime_type: string | null } | undefined;
  if (!row?.stored_name) return {};
  // stored_name is server-generated, but resolve + verify anyway
  const full = path.resolve(filesDir, row.stored_name);
  if (!full.startsWith(path.resolve(filesDir))) return {};
  return { row, path: full };
}

materialsRouter.get("/:id/download", (req, res) => {
  const { row, path: full } = storedPath(Number(req.params.id));
  if (!row || !full || !fs.existsSync(full)) return res.status(404).json({ error: "file not found" });
  res.download(full, row.filename ?? "material");
});

materialsRouter.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  const { path: full } = storedPath(id);
  const r = db.prepare("DELETE FROM materials WHERE id = ?").run(id);
  if (r.changes === 0) return res.status(404).json({ error: "material not found" });
  if (full && fs.existsSync(full)) fs.unlinkSync(full);
  res.json({ ok: true });
});
