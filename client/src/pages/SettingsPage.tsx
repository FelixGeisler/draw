import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useCategories, useSettings } from "../hooks/useTasks";
import { useAiStatus, useRemoveApiKey, useSetApiKey } from "../hooks/useAi";
import { useGamification } from "../hooks/useGamification";
import { useImportBackup, type ImportSummary } from "../hooks/useBackup";
import {
  UPDATE_NOTICE_KEY,
  parseUpdateNotice,
  serializeUpdateNotice,
  shouldReloadAfterApply,
} from "../lib/updateNotice";
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
    // setting-row: the 280px label plus input plus hint overflow a phone, so
    // index.css wraps these rows inside the 640px query — an inline flexWrap
    // would have wrapped them on desktop too, where they have always been one
    // line (#193).
    <label className="setting-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
      <div className="setting-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 280 }}>Rest weekdays</span>
        {/* Seven day buttons at finger size need two lines on a phone. */}
        <div
          role="group"
          aria-label="Rest weekdays"
          className="setting-row"
          style={{ display: "flex", gap: 4 }}
        >
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
      <div className="setting-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
      <div className="setting-row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
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

/**
 * Outbound notifications (#235, ADR-67): an ntfy-compatible URL, write-only
 * like the API key — the server stores it privately and GET /api/notify
 * reports only a presence flag. The test button is the one send the user can
 * watch answer.
 */
function NotifySection() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["notify"],
    queryFn: () => api.get<{ configured: boolean }>("/api/notify"),
  });
  const [draft, setDraft] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (url: string) => api.put("/api/notify/url", { url }),
    onSuccess: () => {
      setDraft("");
      setTestResult(null);
      qc.invalidateQueries({ queryKey: ["notify"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete("/api/notify/url"),
    onSuccess: () => {
      setTestResult(null);
      qc.invalidateQueries({ queryKey: ["notify"] });
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; status?: number; error?: string }>("/api/notify/test", {}),
    onSuccess: (r) =>
      setTestResult(r.ok ? `Delivered (HTTP ${r.status})` : `Failed: ${r.error ?? `HTTP ${r.status}`}`),
  });

  const configured = status.data?.configured;
  return (
    <section className="panel" style={{ display: "grid", gap: 12, marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Notifications</h3>
      {configured ? (
        <p style={{ margin: 0, color: "var(--ok)" }} data-testid="notify-status">
          ✓ Webhook configured — unlocks, achieved goals and completed daily challenges will be
          posted there.
        </p>
      ) : (
        <p style={{ margin: 0, color: "var(--text-dim)" }} data-testid="notify-status">
          {/* Not "Not configured." — the AI section above owns that exact
              phrase and the ai-key E2E locates it page-wide (strict mode). */}
          No webhook configured. Enter an ntfy-compatible URL (e.g.{" "}
          <code>https://ntfy.sh/your-topic</code>) and Draw will POST a short message on every
          achievement unlock, achieved goal, and completed daily challenge.
        </p>
      )}
      <div className="setting-row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="url"
          aria-label="Notification URL"
          data-testid="notify-url-input"
          placeholder={configured ? "Replace URL (https://…)" : "https://ntfy.sh/your-topic"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) save.mutate(draft.trim());
          }}
          style={{ flex: 1, maxWidth: 380 }}
        />
        <button
          data-testid="notify-save"
          disabled={!draft.trim() || save.isPending}
          onClick={() => save.mutate(draft.trim())}
        >
          Save URL
        </button>
        {configured && (
          <>
            <button data-testid="notify-test" disabled={test.isPending} onClick={() => test.mutate()}>
              Send test
            </button>
            <button
              data-testid="notify-remove"
              title="Remove the stored URL — notifications turn off"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </button>
          </>
        )}
      </div>
      <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13 }}>
        Stored in the local database, never shown again after saving. Delivery is
        fire-and-forget — a dead endpoint never slows the app.
      </p>
      {testResult && (
        <div data-testid="notify-test-result" style={{ fontSize: 13 }}>
          {testResult}
        </div>
      )}
      {(save.error || remove.error) && (
        <div style={{ color: "var(--danger)", fontSize: 13 }}>
          {(save.error ?? remove.error)?.message}
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
      <div className="setting-row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          ref={fileInput}
          // The width lives in index.css, not inline: a file input cannot reflow
          // its internals, so on a phone it needs to own the row and shrink its
          // font — an inline max-width would outrank that rule (#193).
          className="backup-file"
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
          style={{ flex: 1 }}
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
          <div className="setting-row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
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

// GET /api/update payload — mirrors the server's UpdateStatus (Settings-only
// concern, so the type lives here like NotifySection's inline shapes).
interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: string | null;
  checkEnabled: boolean;
  applyConfigured: boolean;
}

/**
 * Updates over the air (#247, ADR-70): the running version, the default-on
 * daily release check, and a write-only apply trigger — one POST to a
 * user-configured Watchtower-style endpoint; Draw never touches Docker
 * itself. The trigger URL/token are managed exactly like the ntfy URL
 * (#235): saved write-only, presence flag on read. After "Update now" the
 * section polls GET /api/update every 3s (up to 5 minutes) and reloads once
 * the server reports a new version; a sessionStorage flag pays one
 * "Updated to X" line after that reload and is consumed.
 */
function UpdateSection() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ["update"],
    queryFn: () => api.get<UpdateStatus>("/api/update"),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [applyPhase, setApplyPhase] = useState<"idle" | "waiting" | "timeout">("idle");
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const pollTimer = useRef<number | null>(null);

  // Consume the post-reload notice: one "Updated to X" line, then the flag
  // is gone — a second reload shows nothing (no loops, no repeat toasts).
  // try/catch like every storage touch: a lost notice must never break the
  // app (the deckScope rule). An effect, not a state initializer: StrictMode
  // double-invokes initializers, and the second run would read the already-
  // removed key.
  useEffect(() => {
    try {
      const notice = parseUpdateNotice(sessionStorage.getItem(UPDATE_NOTICE_KEY));
      if (notice !== null) {
        sessionStorage.removeItem(UPDATE_NOTICE_KEY);
        setUpdatedTo(notice);
      }
    } catch {
      // storage disabled — nothing to announce
    }
  }, []);

  // The apply poll must not outlive the section.
  useEffect(
    () => () => {
      if (pollTimer.current !== null) clearInterval(pollTimer.current);
    },
    [],
  );

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch("/api/settings", { update_check_enabled: enabled ? "1" : "0" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["update"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const checkNow = useMutation({
    mutationFn: () => api.post<UpdateStatus>("/api/update/check", {}),
    onSuccess: (s) => {
      qc.setQueryData(["update"], s);
      setCheckResult(
        !s.checkEnabled
          ? "Automatic checks are off — turn the toggle on to check."
          : s.latest === null
            ? "Could not reach the release feed right now — it will quietly retry on the next scheduled check."
            : s.updateAvailable
              ? `A newer release is out: ${s.latest}.`
              : `You are on the latest release (${s.current}).`,
      );
    },
    // The server answers 200 even for a failed check; an error here is the
    // request itself failing — keep the same calm line, no error spam.
    onError: () =>
      setCheckResult(
        "Could not reach the release feed right now — it will quietly retry on the next scheduled check.",
      ),
  });

  const saveTrigger = useMutation({
    mutationFn: () =>
      api.put<{ configured: boolean }>("/api/update/trigger", {
        url: urlDraft.trim(),
        ...(tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
      }),
    onSuccess: () => {
      // Sent once, never read back — both fields clear on success (#235 shape).
      setUrlDraft("");
      setTokenDraft("");
      qc.invalidateQueries({ queryKey: ["update"] });
    },
  });
  const removeTrigger = useMutation({
    mutationFn: () => api.delete<{ configured: boolean }>("/api/update/trigger"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["update"] }),
  });

  function startPoll(startedCurrent: string) {
    const POLL_MS = 3_000;
    const BUDGET_MS = 5 * 60 * 1000;
    const startedAt = Date.now();
    if (pollTimer.current !== null) clearInterval(pollTimer.current);
    pollTimer.current = window.setInterval(async () => {
      let polled: string | null = null;
      try {
        polled = (await api.get<UpdateStatus>("/api/update")).current;
      } catch {
        polled = null; // container mid-restart — keep calm and keep polling
      }
      if (polled !== null && shouldReloadAfterApply(startedCurrent, polled)) {
        if (pollTimer.current !== null) clearInterval(pollTimer.current);
        pollTimer.current = null;
        try {
          sessionStorage.setItem(UPDATE_NOTICE_KEY, serializeUpdateNotice(polled));
        } catch {
          // the toast is lost, the update is not
        }
        // The #193 service worker serves the new bundle on this reload.
        location.reload();
        return;
      }
      if (Date.now() - startedAt >= BUDGET_MS) {
        if (pollTimer.current !== null) clearInterval(pollTimer.current);
        pollTimer.current = null;
        setApplyPhase("timeout");
      }
    }, POLL_MS);
  }

  const apply = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/api/update/apply", {}),
    onSuccess: () => {
      setApplyPhase("waiting");
      // status.data is present whenever the button rendered (it gates on it).
      startPoll(status.data?.current ?? "");
    },
  });

  const s = status.data;
  const configured = s?.applyConfigured ?? false;
  return (
    <section className="panel" style={{ display: "grid", gap: 12, marginTop: 16 }}>
      <h3 style={{ margin: 0 }}>Updates</h3>
      <div className="setting-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 280 }}>Running version</span>
        <span data-testid="update-current-version" style={{ fontWeight: 700 }}>
          {s ? `Draw ${s.current}` : "…"}
        </span>
      </div>
      {updatedTo && (
        <p style={{ margin: 0, color: "var(--ok)" }} data-testid="update-updated-notice">
          ✓ Updated to {updatedTo}.
        </p>
      )}
      <label className="setting-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 280 }}>Check for updates daily</span>
        <input
          type="checkbox"
          data-testid="update-check-toggle"
          checked={s?.checkEnabled ?? true}
          disabled={!s || toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        <span style={{ color: "var(--text-dim)", fontSize: 13 }}>
          one request per day to the GitHub release feed — off means no requests at all
        </span>
      </label>
      <div className="setting-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          data-testid="update-check-now"
          disabled={checkNow.isPending}
          onClick={() => checkNow.mutate()}
        >
          Check now
        </button>
        {checkResult && (
          <span data-testid="update-check-result" style={{ fontSize: 13 }}>
            {checkResult}
          </span>
        )}
      </div>
      {s?.updateAvailable && (
        <div
          data-testid="update-banner"
          style={{
            border: "1px solid var(--accent)",
            borderRadius: "var(--radius-md)",
            padding: 12,
            display: "grid",
            gap: 8,
          }}
        >
          <strong>Update available: {s.latest}</strong>
          {s.releaseUrl && (
            <a
              href={s.releaseUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              Release notes
            </a>
          )}
        </div>
      )}
      {configured ? (
        <p style={{ margin: 0, color: "var(--ok)" }} data-testid="update-trigger-status">
          ✓ Update trigger configured — “Update now” posts to it and your container platform
          swaps the image.
        </p>
      ) : (
        <p style={{ margin: 0, color: "var(--text-dim)" }} data-testid="update-trigger-status">
          No update trigger configured — updating stays a manual pull-and-restart. Point this
          at a Watchtower <code>http-api-update</code> endpoint (see the deployment guide,
          section 7.5) to update from right here.
        </p>
      )}
      {configured && (
        <div className="setting-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            data-testid="update-apply"
            disabled={apply.isPending || applyPhase === "waiting"}
            onClick={() => apply.mutate()}
          >
            Update now
          </button>
          {applyPhase === "waiting" && (
            <span style={{ color: "var(--text-dim)", fontSize: 13 }}>
              Update requested — waiting for the new version…
            </span>
          )}
          {applyPhase === "timeout" && (
            <span style={{ color: "var(--text-dim)", fontSize: 13 }}>
              Still waiting — the update may take a while longer.{" "}
              {s?.releaseUrl && (
                <a
                  href={s.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)" }}
                >
                  Release notes
                </a>
              )}
            </span>
          )}
        </div>
      )}
      <div className="setting-row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="url"
          aria-label="Update trigger URL"
          data-testid="update-trigger-url-input"
          placeholder={
            configured ? "Replace trigger URL (http://…)" : "http://watchtower:8080/v1/update"
          }
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          style={{ flex: 1, maxWidth: 380 }}
        />
        <input
          type="password"
          aria-label="Update trigger token"
          data-testid="update-trigger-token-input"
          placeholder="Bearer token (optional)"
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          style={{ width: 180 }}
        />
        <button
          data-testid="update-trigger-save"
          disabled={!urlDraft.trim() || saveTrigger.isPending}
          onClick={() => saveTrigger.mutate()}
        >
          Save trigger
        </button>
        {configured && (
          <button
            data-testid="update-trigger-remove"
            title="Remove the stored trigger URL and token — updating goes back to manual"
            disabled={removeTrigger.isPending}
            onClick={() => removeTrigger.mutate()}
          >
            Remove
          </button>
        )}
      </div>
      <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13 }}>
        Trigger URL and token are stored privately and never shown again after saving. Draw
        itself never touches Docker — updating is one POST to your trigger.
      </p>
      {(saveTrigger.error || removeTrigger.error || apply.error || toggle.error) && (
        <div style={{ color: "var(--danger)", fontSize: 13 }}>
          {(saveTrigger.error ?? removeTrigger.error ?? apply.error ?? toggle.error)?.message}
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
    <div className="setting-row" style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
          className="cat-name"
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

      <NotifySection />

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
            <SettingInput
              label="Hours between warm-up draws"
              settingKey="warmup_every_hours"
              value={settings.data.warmup_every_hours}
              hint="the 🔰 warm-up deals your smallest card, once per window"
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
        {/* setting-row, like the category rows above it: without it this row
            neither wraps on a phone nor drops its grid-item min-width: auto, so
            its three controls set a floor wider than a 360px screen (#193). */}
        <div className="setting-row" style={{ display: "flex", gap: 8 }}>
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

      <UpdateSection />
    </div>
  );
}
