import { Router } from "express";
import { db } from "../db.js";

export const timerRouter = Router();

const ENTRY_SELECT = `SELECT id, task_id AS taskId, started_at AS startedAt, ended_at AS endedAt FROM time_entries`;

function currentEntry() {
  return db.prepare(`${ENTRY_SELECT} WHERE ended_at IS NULL LIMIT 1`).get() as
    | { id: number; taskId: number; startedAt: string; endedAt: null }
    | undefined;
}

export function startTimer(taskId: number): { error?: string; status?: number } {
  const task = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(taskId) as
    | { id: number; status: string }
    | undefined;
  if (!task) return { error: "task not found", status: 404 };
  if (task.status !== "open") return { error: "task is not open", status: 409 };

  db.transaction(() => {
    db.prepare("UPDATE time_entries SET ended_at = ? WHERE ended_at IS NULL").run(
      new Date().toISOString(),
    );
    db.prepare("INSERT INTO time_entries (task_id, started_at) VALUES (?, ?)").run(
      taskId,
      new Date().toISOString(),
    );
  })();
  return {};
}

timerRouter.get("/current", (_req, res) => {
  const entry = currentEntry();
  if (!entry) return res.json(null);
  const task = db
    .prepare(
      `SELECT id, title, category_id AS categoryId, impact, effort_minutes AS effortMinutes,
              goal_id AS goalId, status FROM tasks WHERE id = ?`,
    )
    .get(entry.taskId);
  res.json({ entry, task });
});

timerRouter.post("/stop", (_req, res) => {
  const entry = currentEntry();
  if (!entry) return res.status(404).json({ error: "no running timer" });
  db.prepare("UPDATE time_entries SET ended_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    entry.id,
  );
  res.json(db.prepare(`${ENTRY_SELECT} WHERE id = ?`).get(entry.id));
});
