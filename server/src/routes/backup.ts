import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../db.js";
import {
  BackupError,
  createBackupArchive,
  exportFilename,
  importBackupArchive,
} from "../services/backupService.js";

export const backupRouter = Router();

// Uploads land inside DATA_DIR (same volume as the swap targets) but outside
// files/ — that directory is replaced mid-import. Cap far above any real
// archive; the per-material cap is 50 MB.
const upload = multer({
  dest: path.join(dataDir, "backup-uploads"),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

backupRouter.get("/export", (_req, res) => {
  let zipPath: string;
  try {
    zipPath = createBackupArchive();
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "backup export failed" });
  }
  res.download(zipPath, exportFilename(new Date()), () => {
    fs.rmSync(zipPath, { force: true });
  });
});

backupRouter.post("/import", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'backup file is required (multipart field "file")' });
  }
  try {
    res.json(importBackupArchive(req.file.path));
  } catch (e) {
    if (e instanceof BackupError) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: e instanceof Error ? e.message : "backup import failed" });
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
});
