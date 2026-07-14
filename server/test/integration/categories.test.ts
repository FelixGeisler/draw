import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type express from "express";
import { freshApp } from "../helpers.js";

let app: express.Express;
beforeAll(async () => {
  app = await freshApp();
});

describe("category management", () => {
  it("lists the seeded defaults", async () => {
    const res = await request(app).get("/api/categories").expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((c: { name: string }) => c.name)).toEqual([
      "Work",
      "Study",
      "Household",
    ]);
    expect(res.body[0].isDefault).toBe(1);
  });

  it("creates a category and rejects duplicates", async () => {
    const created = await request(app)
      .post("/api/categories")
      .send({ name: "Fitness", color: "#ff5533" })
      .expect(201);
    expect(created.body).toMatchObject({ name: "Fitness", color: "#ff5533", isDefault: 0 });

    await request(app).post("/api/categories").send({ name: "Fitness" }).expect(409);
  });

  it("renames a category", async () => {
    const res = await request(app)
      .patch("/api/categories/4")
      .send({ name: "Health" })
      .expect(200);
    expect(res.body).toMatchObject({ id: 4, name: "Health", color: "#ff5533" });
  });

  it("recolors a category without touching the name", async () => {
    const res = await request(app)
      .patch("/api/categories/4")
      .send({ color: "#00aa88" })
      .expect(200);
    expect(res.body).toMatchObject({ id: 4, name: "Health", color: "#00aa88" });
  });

  it("rejects a rename to an existing name with 409 and keeps the original", async () => {
    await request(app).patch("/api/categories/4").send({ name: "Work" }).expect(409);

    const list = await request(app).get("/api/categories").expect(200);
    expect(list.body.find((c: { id: number }) => c.id === 4).name).toBe("Health");
  });

  it("rejects an empty patch and an unknown id", async () => {
    await request(app).patch("/api/categories/4").send({}).expect(400);
    await request(app).patch("/api/categories/999").send({ name: "Ghost" }).expect(404);
    await request(app).delete("/api/categories/999").expect(404);
  });

  it("refuses to delete a category that has tasks (409)", async () => {
    const task = (
      await request(app).post("/api/tasks").send({ title: "Report", categoryId: 1 })
    ).body;

    const res = await request(app).delete("/api/categories/1").expect(409);
    expect(res.body.error).toMatch(/has tasks/);

    // Clean up so later deletions are only blocked by the last-category guard.
    await request(app).delete(`/api/tasks/${task.id}`).expect(200);
  });

  it("deletes default categories once they are task-free", async () => {
    await request(app).delete("/api/categories/2").expect(200); // Study, is_default = 1
    await request(app).delete("/api/categories/3").expect(200); // Household, is_default = 1
    await request(app).delete("/api/categories/4").expect(200); // Health

    const list = await request(app).get("/api/categories").expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe("Work");
  });

  it("refuses to delete the last remaining category (409)", async () => {
    const res = await request(app).delete("/api/categories/1").expect(409);
    expect(res.body.error).toMatch(/last category/);

    const list = await request(app).get("/api/categories").expect(200);
    expect(list.body).toHaveLength(1);
  });
});
