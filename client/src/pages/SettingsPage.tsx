import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useCategories, useSettings } from "../hooks/useTasks";
import { useAiStatus } from "../hooks/useAi";

function SettingInput({
  label,
  settingKey,
  value,
  hint,
}: {
  label: string;
  settingKey: string;
  value: string;
  hint?: string;
}) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (v: number) => api.patch("/api/settings", { [settingKey]: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ width: 280 }}>{label}</span>
      <input
        type="number"
        min={1}
        defaultValue={value}
        style={{ width: 90 }}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (v > 0 && String(v) !== value) save.mutate(v);
        }}
      />
      {hint && <span style={{ color: "var(--text-dim)", fontSize: 13 }}>{hint}</span>}
    </label>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const categories = useCategories();
  const aiStatus = useAiStatus();
  const qc = useQueryClient();
  const [newCat, setNewCat] = useState("");
  const [newColor, setNewColor] = useState("#4f8cff");

  const addCategory = useMutation({
    mutationFn: () => api.post("/api/categories", { name: newCat, color: newColor }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      setNewCat("");
    },
  });
  const deleteCategory = useMutation({
    mutationFn: (id: number) => api.delete(`/api/categories/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });

  return (
    <div className="content">
      <h1>Settings</h1>

      <section className="panel" style={{ display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0 }}>AI assistance</h3>
        {aiStatus.data?.configured ? (
          <p style={{ margin: 0, color: "var(--ok)" }}>
            ✓ Claude API key configured — model {aiStatus.data.model}
          </p>
        ) : (
          <p style={{ margin: 0, color: "var(--text-dim)" }}>
            Not configured. Add <code>ANTHROPIC_API_KEY=…</code> to <code>server/.env</code> and
            restart to enable AI task breakdown and backward planning. Everything else works
            without it.
          </p>
        )}
      </section>

      <section className="panel" style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>Draw tuning</h3>
        {settings.data && (
          <>
            <SettingInput
              label="Max effort for drawable tasks"
              settingKey="max_draw_effort"
              value={settings.data.max_draw_effort}
              hint="minutes — bigger tasks must be broken down"
            />
            <SettingInput
              label="Repeat-draw cooldown"
              settingKey="draw_cooldown_minutes"
              value={settings.data.draw_cooldown_minutes}
              hint="minutes — recently drawn cards become unlikely"
            />
            <SettingInput
              label="Daily goal (completions/day)"
              settingKey="daily_goal_completions"
              value={settings.data.daily_goal_completions}
              hint="keeps the streak flame lit"
            />
          </>
        )}
      </section>

      <section className="panel" style={{ display: "grid", gap: 8, marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>Categories</h3>
        {categories.data?.map((c) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="dot" style={{ background: c.color }} />
            <span style={{ flex: 1 }}>{c.name}</span>
            {!c.isDefault && (
              <button style={{ padding: "2px 8px" }} onClick={() => deleteCategory.mutate(c.id)}>
                ✕
              </button>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="New category"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            style={{ flex: 1 }}
          />
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            style={{ width: 48, padding: 2 }}
          />
          <button disabled={!newCat.trim()} onClick={() => addCategory.mutate()}>
            Add
          </button>
        </div>
        {(addCategory.error || deleteCategory.error) && (
          <div style={{ color: "var(--danger)", fontSize: 13 }}>
            {(addCategory.error ?? deleteCategory.error)?.message}
          </div>
        )}
      </section>
    </div>
  );
}
