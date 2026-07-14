import { Router } from "express";
import { db } from "../db.js";

export const goalsRouter = Router();

const GOAL_SELECT = `
  SELECT g.id, g.title, g.outcome, g.target_date AS targetDate, g.status, g.created_at AS createdAt,
         (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status != 'archived') AS taskCount,
         (SELECT COUNT(*) FROM tasks t WHERE t.goal_id = g.id AND t.status = 'done') AS doneCount,
         (SELECT COUNT(*) FROM materials m WHERE m.goal_id = g.id) AS materialCount
  FROM goals g`;

function getGoal(id: number) {
  return db.prepare(`${GOAL_SELECT} WHERE g.id = ?`).get(id);
}

goalsRouter.get("/", (req, res) => {
  const status = (req.query.status as string) || "active";
  const where = status === "all" ? "" : "WHERE g.status = ?";
  const params = status === "all" ? [] : [status];
  res.json(db.prepare(`${GOAL_SELECT} ${where} ORDER BY g.created_at DESC`).all(...params));
});

goalsRouter.post("/", (req, res) => {
  const { title, outcome, targetDate } = req.body ?? {};
  if (!title?.trim()) return res.status(400).json({ error: "title is required" });
  const r = db
    .prepare("INSERT INTO goals (title, outcome, target_date, created_at) VALUES (?, ?, ?, ?)")
    .run(title.trim(), outcome ?? null, targetDate ?? null, new Date().toISOString());
  res.status(201).json(getGoal(Number(r.lastInsertRowid)));
});

goalsRouter.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const fields: Record<string, string> = {
    title: "title",
    outcome: "outcome",
    targetDate: "target_date",
    status: "status",
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(fields)) {
    if (key in body) {
      sets.push(`${column} = ?`);
      params.push(body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "nothing to update" });
  const r = db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  if (r.changes === 0) return res.status(404).json({ error: "goal not found" });
  res.json(getGoal(id));
});

goalsRouter.delete("/:id", (req, res) => {
  const r = db.prepare("DELETE FROM goals WHERE id = ?").run(Number(req.params.id));
  if (r.changes === 0) return res.status(404).json({ error: "goal not found" });
  res.json({ ok: true });
});
