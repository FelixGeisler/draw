import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useCategories, useSettings } from "../hooks/useTasks";
import { useAiStatus, useRemoveApiKey, useSetApiKey } from "../hooks/useAi";
import type { Category } from "../api/types";

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

function AiKeySection() {
  const aiStatus = useAiStatus();
  const setKey = useSetApiKey();
  const removeKey = useRemoveApiKey();
  const [draft, setDraft] = useState("");

  function save() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    // The key is sent once and never read back — the input clears on success.
    setKey.mutate(trimmed, { onSuccess: () => setDraft("") });
  }

  const status = aiStatus.data;
  return (
    <section className="panel" style={{ display: "grid", gap: 12 }}>
      <h3 style={{ margin: 0 }}>AI assistance</h3>
      {status?.configured ? (
        <p style={{ margin: 0, color: "var(--ok)" }}>
          ✓ Claude API key configured — model {status.model}
          {status.keySource === "environment" && (
            <span style={{ color: "var(--text-dim)" }}>
              {" "}
              (from <code>ANTHROPIC_API_KEY</code> in <code>server/.env</code>)
            </span>
          )}
        </p>
      ) : (
        <p style={{ margin: 0, color: "var(--text-dim)" }}>
          Not configured. Enter your Claude API key below to enable AI task breakdown and
          backward planning — no restart needed. Everything else works without it.
        </p>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="password"
          aria-label="Claude API key"
          placeholder={status?.configured ? "Replace key (sk-ant-…)" : "sk-ant-…"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          style={{ flex: 1, maxWidth: 380 }}
        />
        <button disabled={!draft.trim() || setKey.isPending} onClick={save}>
          Save key
        </button>
        {status?.keySource === "database" && (
          <button
            title="Remove the stored API key"
            disabled={removeKey.isPending}
            onClick={() => removeKey.mutate()}
          >
            Remove key
          </button>
        )}
      </div>
      <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13 }}>
        Stored in the local database, never shown again after saving.
      </p>
      {(setKey.error || removeKey.error) && (
        <div style={{ color: "var(--danger)", fontSize: 13 }}>
          {(setKey.error ?? removeKey.error)?.message}
        </div>
      )}
    </section>
  );
}

function CategoryRow({ category }: { category: Category }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const cancelled = useRef(false);

  const patch = useMutation({
    mutationFn: (body: { name?: string; color?: string }) =>
      api.patch(`/api/categories/${category.id}`, body),
    onSuccess: () => {
      remove.reset(); // a stale delete error must not outlive a successful edit
      // Returned so the mutation stays pending until the refetch lands — the
      // row keeps showing the in-flight name below instead of flashing back
      // to the stale one while the round-trip completes.
      return qc.invalidateQueries({ queryKey: ["categories"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/categories/${category.id}`),
    onSuccess: () => {
      patch.reset();
      qc.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  // A rename shows immediately; until the server round-trip completes the row
  // would otherwise silently fall back to the stale name (and reads as a lost
  // edit — the exact race the E2E flake caught). On error it reverts.
  const shownName = (patch.isPending ? patch.variables?.name : undefined) ?? category.name;

  function commitRename() {
    setEditing(false);
    const trimmed = name.trim();
    if (cancelled.current || !trimmed || trimmed === shownName) {
      cancelled.current = false;
      setName(category.name);
      return;
    }
    patch.mutate({ name: trimmed }, { onError: () => setName(category.name) });
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <input
        type="color"
        title={`Change color of ${category.name}`}
        defaultValue={category.color}
        onBlur={(e) => {
          if (e.target.value !== category.color) patch.mutate({ color: e.target.value });
        }}
        style={{ width: 32, padding: 2 }}
      />
      {editing ? (
        <input
          autoFocus
          aria-label="Rename category"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
          style={{ flex: 1 }}
        />
      ) : (
        <span
          style={{ flex: 1, cursor: "pointer" }}
          title="Click to rename"
          onClick={() => {
            setName(shownName);
            setEditing(true);
          }}
        >
          {shownName}
        </span>
      )}
      <button
        style={{ padding: "2px 8px" }}
        title={`Delete ${category.name}`}
        onClick={() => remove.mutate()}
      >
        ✕
      </button>
      {(patch.error || remove.error) && (
        <span style={{ color: "var(--danger)", fontSize: 13 }}>
          {(patch.error ?? remove.error)?.message}
        </span>
      )}
    </div>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const categories = useCategories();
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

  return (
    <div className="content">
      <h1>Settings</h1>

      <AiKeySection />

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
          <CategoryRow key={c.id} category={c} />
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
        {addCategory.error && (
          <div style={{ color: "var(--danger)", fontSize: 13 }}>{addCategory.error.message}</div>
        )}
      </section>
    </div>
  );
}
