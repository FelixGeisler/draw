import { Router } from "express";
import { db } from "../db.js";

export const categoriesRouter = Router();

const SELECT = "SELECT id, name, color, is_default AS isDefault FROM categories";

categoriesRouter.get("/", (_req, res) => {
  res.json(db.prepare(`${SELECT} ORDER BY id`).all());
});

categoriesRouter.post("/", (req, res) => {
  const { name, color } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  try {
    const r = db
      .prepare("INSERT INTO categories (name, color) VALUES (?, ?)")
      .run(name.trim(), color || "#888888");
    res.status(201).json(db.prepare(`${SELECT} WHERE id = ?`).get(r.lastInsertRowid));
  } catch {
    res.status(409).json({ error: "a category with that name already exists" });
  }
});

categoriesRouter.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const { name, color } = req.body ?? {};
  const sets: string[] = [];
  const params: unknown[] = [];
  if (name?.trim()) {
    sets.push("name = ?");
    params.push(name.trim());
  }
  if (color) {
    sets.push("color = ?");
    params.push(color);
  }
  if (sets.length === 0) return res.status(400).json({ error: "nothing to update" });
  try {
    const r = db
      .prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params, id);
    if (r.changes === 0) return res.status(404).json({ error: "category not found" });
    res.json(db.prepare(`${SELECT} WHERE id = ?`).get(id));
  } catch {
    res.status(409).json({ error: "a category with that name already exists" });
  }
});

categoriesRouter.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id);
  if (!exists) return res.status(404).json({ error: "category not found" });
  const inUse = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE category_id = ?").get(id) as {
    n: number;
  };
  if (inUse.n > 0) {
    return res.status(409).json({ error: "category has tasks — move or delete them first" });
  }
  // TaskForm needs at least one category to exist — never delete the final one.
  const total = db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number };
  if (total.n <= 1) {
    return res.status(409).json({ error: "cannot delete the last category — at least one must remain" });
  }
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
  res.json({ ok: true });
});
