import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useCategories, useSettings } from "../hooks/useTasks";
import { useAiStatus, useRemoveApiKey, useSetApiKey } from "../hooks/useAi";
import { useGamification } from "../hooks/useGamification";
import { useImportBackup, type ImportSummary } from "../hooks/useBackup";
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

// Mon-first display order, JS getDay values (0=Sun..6=Sat) — the same
// convention as the stored setting and tasks.window_days.
const WEEKDAYS: { day: number; label: string }[] = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

function parseRestWeekdays(raw: string | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
  } catch {
    return [];
  }
}

function StreakSection() {
  const settings = useSettings();
  const gamification = useGamification();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (days: number[]) => api.patch("/api/settings", { streak_rest_weekdays: days }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      // Rest days change todayKind/streak immediately — keep the flame honest.
      qc.invalidateQueries({ queryKey: ["gamification"] });
    },
  });
  const current = parseRestWeekdays(settings.data?.streak_rest_weekdays);

  function toggle(day: number) {
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day].sort((a, b) => a - b);
    save.mutate(next);
  }

  const g = gamification.data;
  return (
    <section className="panel" style={{ display: "grid", gap: 12, marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Streak</h3>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 280 }}>Rest weekdays</span>
        <div role="group" aria-label="Rest weekdays" style={{ display: "flex", gap: 4 }}>
          {WEEKDAYS.map(({ day, label }) => {
            const active = current.includes(day);
            return (
              <button
                key={day}
                aria-pressed={active}
                disabled={settings.isPending || save.isPending}
                onClick={() => toggle(day)}
                style={{
                  padding: "4px 10px",
                  background: active ? "var(--accent)" : undefined,
                  color: active ? "#fff" : undefined,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <span style={{ color: "var(--text-dim)", fontSize: 13 }}>
          days that never break the streak — completing on one still counts
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 280 }}>Freezes banked</span>
        <span style={{ fontWeight: 700 }}>
          🧊 {g ? `${g.freezesBanked}/${g.freezeBankCap}` : "…"}
        </span>
        <span style={{ color: "var(--text-dim)", fontSize: 13 }}>
          earned every 7 completed streak days; one auto-covers a missed day
        </span>
      </div>
      {save.error && (
        <div style={{ color: "var(--danger)", fontSize: 13 }}>{save.error.message}</div>
      )}
    </section>
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

function BackupSection() {
  const importBackup = useImportBackup();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  // Destructive restore is gated twice: an explicit warning step (armed) plus
  // typing REPLACE — one confirm() is not enough for "deletes everything".
  const [armed, setArmed] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  function reset() {
    setFile(null);
    setArmed(false);
    setConfirmText("");
    if (fileInput.current) fileInput.current.value = "";
  }

  function restore() {
    if (!file || confirmText !== "REPLACE") return;
    importBackup.mutate(file, {
      onSuccess: (s) => {
        setSummary(s);
        reset();
      },
    });
  }

  return (
    <section className="panel" style={{ display: "grid", gap: 12, marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Backup</h3>
      <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13 }}>
        One zip archive with the complete database and all goal material files. The Claude API
        key is never included in backups — re-enter it after restoring on a new machine.
      </p>
      <div>
        <a href="/api/backup/export" style={{ color: "var(--accent)" }}>
          ⬇ Download backup
        </a>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          aria-label="Backup archive"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setArmed(false);
            setConfirmText("");
            setSummary(null);
            importBackup.reset();
          }}
          style={{ flex: 1, maxWidth: 380 }}
        />
        <button disabled={!file || armed} onClick={() => setArmed(true)}>
          Restore from backup
        </button>
      </div>
      {armed && (
        <div
          style={{
            border: "1px solid var(--danger)",
            borderRadius: 6,
            padding: 12,
            display: "grid",
            gap: 10,
          }}
        >
          <strong style={{ color: "var(--danger)" }}>
            Restoring replaces ALL current data.
          </strong>
          <p style={{ margin: 0, fontSize: 13 }}>
            Tasks, goals, materials, settings, history and the current draw are replaced with
            the backup&apos;s contents. Your current database is kept on disk as{" "}
            <code>app.db.bak</code> (and the material files as <code>files.bak</code>) in case
            you need to go back.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              aria-label="Type REPLACE to confirm"
              placeholder="Type REPLACE to confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              style={{ width: 220 }}
            />
            <button
              disabled={confirmText !== "REPLACE" || importBackup.isPending}
              onClick={restore}
            >
              {importBackup.isPending ? "Restoring…" : "Replace everything"}
            </button>
            <button disabled={importBackup.isPending} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {summary && (
        <p style={{ margin: 0, color: "var(--ok)" }}>
          ✓ Backup restored — {summary.tasks} tasks, {summary.goals} goals, {summary.materials}{" "}
          materials.
        </p>
      )}
      {importBackup.error && (
        <div style={{ color: "var(--danger)", fontSize: 13 }}>{importBackup.error.message}</div>
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
      qc.invalidateQueries({ queryKey: ["categories"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/categories/${category.id}`),
    onSuccess: () => {
      patch.reset();
      qc.invalidateQueries({ queryKey: ["categories"] });
    },
  });

  function commitRename() {
    setEditing(false);
    const trimmed = name.trim();
    if (cancelled.current || !trimmed || trimmed === category.name) {
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
            setName(category.name);
            setEditing(true);
          }}
        >
          {category.name}
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

      <StreakSection />

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

      <BackupSection />
    </div>
  );
}
