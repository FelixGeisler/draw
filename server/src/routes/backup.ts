import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
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
// Multer 2.3.0 supports fieldArrayIndexLimit, but @types/multer 2.2.0 does not
// yet declare it. Keep the compatibility addition local to this limits object.
const uploadLimits: NonNullable<multer.Options["limits"]> & {
  fieldArrayIndexLimit: number;
} = {
  fileSize: 1024 * 1024 * 1024,
  fieldArrayIndexLimit: 0,
};

const upload = multer({
  dest: path.join(dataDir, "backup-uploads"),
  limits: uploadLimits,
});

function backupUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (error: unknown) => {
    if (
      error instanceof multer.MulterError &&
      String(error.code) === "LIMIT_FIELD_ARRAY_INDEX"
    ) {
      res.status(400).json({ error: "invalid multipart field name" });
      return;
    }
    next(error);
  });
}

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

backupRouter.post("/import", backupUpload, (req, res) => {
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
