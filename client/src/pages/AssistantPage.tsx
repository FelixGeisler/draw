import { useMemo, useRef, useState } from "react";
import { useAiStatus } from "../hooks/useAi";
import { useGoals, useMaterials } from "../hooks/useGoals";
import {
  useAgentApply,
  useAgentEstimate,
  useAgentMessage,
  type StagedOp,
  type AgentTurnUsage,
} from "../hooks/useAssistant";
import { MaterialPicker } from "../components/AiSuggestionPanel";
import {
  buildOperations,
  cascadeExclusions,
  countChanges,
  seedEdits,
  type RowEdit,
} from "../lib/assistantReview";

// The Assistant page (#31, ADR-37): a conversation whose write tools stage a
// DRAFT changeset — the review card below the transcript is the sole write
// path (ADR-14). Conversation state lives in this component on purpose: it is
// scratch, a reload starts fresh (matching the server's in-memory sessions).
// The review-state model (inclusion cascade, apply plan) is pure and lives in
// lib/assistantReview.ts.

interface TranscriptEntry {
  role: "user" | "assistant" | "notice";
  text: string;
  usage?: AgentTurnUsage;
}

function costLine(usage: AgentTurnUsage): string {
  const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens;
  return `${tokens.toLocaleString()} tokens (${usage.outputTokens.toLocaleString()} out) ≈ $${usage.costUsd.toFixed(3)}`;
}

function aiErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message === "ai_not_configured"
    ? "Claude AI is not configured — add your API key in Settings."
    : message;
}

export function AssistantPage() {
  const aiStatus = useAiStatus();
  const goals = useGoals();
  const estimate = useAgentEstimate();
  const send = useAgentMessage();
  const apply = useAgentApply();

  const [goalId, setGoalId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ops, setOps] = useState<StagedOp[]>([]);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [input, setInput] = useState("");
  // First-send estimate gate: the priced message waiting for confirmation.
  const [gated, setGated] = useState<{ message: string; inputTokens: number; estimatedUsd: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const materials = useMaterials(goalId ?? -1);
  const materialList = goalId != null ? (materials.data ?? []) : [];

  const draftTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const op of ops) {
      if (op.kind === "create_task") titles.set(op.draftId, edits[op.draftId]?.title ?? op.task.title);
    }
    return titles;
  }, [ops, edits]);

  const operations = buildOperations(ops, edits);
  const changeCount = countChanges(operations);

  if (aiStatus.data && !aiStatus.data.configured) {
    return (
      <div className="content">
        <h1>Assistant</h1>
        <p style={{ color: "var(--text-dim)" }}>
          Claude AI is not configured — add your API key in Settings to chat with the assistant.
        </p>
      </div>
    );
  }

  function pushEntries(...entries: TranscriptEntry[]) {
    setTranscript((prev) => [...prev, ...entries]);
    // Keep the newest exchange visible.
    setTimeout(() => transcriptEnd.current?.scrollIntoView({ block: "nearest" }), 0);
  }

  async function deliver(message: string) {
    setError(null);
    pushEntries({ role: "user", text: message });
    try {
      const result = await send.mutateAsync({
        ...(sessionId
          ? { sessionId }
          : { goalId: goalId ?? undefined, materialIds: [...selected] }),
        message,
      });
      setSessionId(result.sessionId);
      setOps(result.changeset.ops);
      setEdits((prev) => seedEdits(result.changeset.ops, prev));
      pushEntries({
        role: "assistant",
        text: result.reply || "(no reply text — see the staged changes below)",
        usage: result.usage,
      });
    } catch (e) {
      // A lost session (server restart) is recoverable: the next send starts
      // a fresh conversation instead of failing forever.
      if ((e as { status?: number }).status === 404) setSessionId(null);
      setError(aiErrorMessage(e));
    }
  }

  async function onSend() {
    const message = input.trim();
    if (!message || send.isPending || estimate.isPending) return;
    if (sessionId) {
      setInput("");
      await deliver(message);
      return;
    }
    // First send: price it, then ask for confirmation (the estimate-gate
    // pattern of every AI surface — materials can make this call expensive).
    setError(null);
    try {
      const priced = await estimate.mutateAsync({
        goalId: goalId ?? undefined,
        materialIds: [...selected],
        message,
      });
      setGated({ message, ...priced });
    } catch (e) {
      setError(aiErrorMessage(e));
    }
  }

  async function onConfirmFirst() {
    if (!gated) return;
    const { message } = gated;
    setGated(null);
    setInput("");
    await deliver(message);
  }

  async function onApply() {
    if (changeCount === 0 || apply.isPending) return;
    setError(null);
    try {
      const result = await apply.mutateAsync({ sessionId: sessionId ?? undefined, operations });
      const createdCount = result.created.reduce((n, c) => n + c.taskIds.length, 0);
      setOps([]);
      setEdits({});
      pushEntries({
        role: "notice",
        text: `✅ Applied — ${createdCount} task${createdCount === 1 ? "" : "s"} created. Find them on the Tasks page.`,
      });
    } catch (e) {
      setError(aiErrorMessage(e));
    }
  }

  function updateEdit(draftId: string, patch: Partial<RowEdit>) {
    setEdits((prev) => {
      const next = { ...prev, [draftId]: { ...prev[draftId], ...patch } };
      return "included" in patch ? cascadeExclusions(ops, next) : next;
    });
  }

  const busy = send.isPending || estimate.isPending;

  function reviewRow(
    draftId: string,
    opts: { indent?: boolean; suffix?: React.ReactNode; impact?: number },
  ) {
    const e = edits[draftId];
    if (!e) return null;
    return (
      <div
        key={draftId}
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginLeft: opts.indent ? 26 : 0,
          opacity: e.included ? 1 : 0.45,
        }}
      >
        <input
          type="checkbox"
          checked={e.included}
          title={`Include ${draftId}`}
          onChange={(ev) => updateEdit(draftId, { included: ev.target.checked })}
        />
        <input
          value={e.title}
          onChange={(ev) => updateEdit(draftId, { title: ev.target.value })}
          style={{ flex: 1, fontSize: opts.indent ? 13 : 14 }}
          title={`Title ${draftId}`}
        />
        <input
          type="number"
          min={1}
          value={e.effortMinutes ?? ""}
          onChange={(ev) =>
            updateEdit(draftId, {
              effortMinutes: ev.target.value === "" ? null : Number(ev.target.value),
            })
          }
          style={{ width: 66 }}
          title={`Minutes ${draftId}`}
        />
        {opts.impact != null && (
          <span title={`Impact ${opts.impact}/5`} style={{ color: "var(--warn)", fontSize: 12 }}>
            {"★".repeat(opts.impact)}
          </span>
        )}
        {opts.suffix}
      </div>
    );
  }

  return (
    <div className="content" style={{ display: "grid", gap: 12, alignContent: "start" }}>
      <h1>✨ Assistant</h1>
      <p style={{ margin: 0, color: "var(--text-dim)", fontSize: 13 }}>
        Chat about your plans — the assistant reads your live tasks and goals, and proposes new
        tasks as <strong>drafts</strong>. Nothing is created until you review and apply the changes
        below. Conversations are not saved.
      </p>

      {!sessionId && transcript.length === 0 && (
        <div className="panel" style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span style={{ color: "var(--text-dim)" }}>
              Ground the conversation in a goal (optional — enables materials as context):
            </span>
            <select
              value={goalId ?? ""}
              title="Goal for this conversation"
              onChange={(e) => {
                setGoalId(e.target.value ? Number(e.target.value) : null);
                setSelected(new Set());
              }}
            >
              <option value="">No goal — general planning</option>
              {(goals.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  🎯 {g.title}
                </option>
              ))}
            </select>
          </label>
          <MaterialPicker
            materials={materialList}
            selected={selected}
            onToggle={(id) =>
              setSelected((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          />
        </div>
      )}

      {transcript.length > 0 && (
        <div className="panel" style={{ display: "grid", gap: 10, maxHeight: "45vh", overflowY: "auto" }}>
          {transcript.map((entry, i) =>
            entry.role === "notice" ? (
              <div key={i} style={{ fontSize: 13, color: "var(--ok)" }}>
                {entry.text}
              </div>
            ) : (
              <div key={i} style={{ display: "grid", gap: 2 }}>
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                  {entry.role === "user" ? "You" : "Assistant"}
                </div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{entry.text}</div>
                {entry.usage && (
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }} title="Actual cost of this turn">
                    {costLine(entry.usage)}
                  </div>
                )}
              </div>
            ),
          )}
          {busy && <div style={{ fontSize: 13, color: "var(--text-dim)" }}>Thinking…</div>}
          <div ref={transcriptEnd} />
        </div>
      )}

      {ops.length > 0 && (
        <div className="panel" style={{ display: "grid", gap: 8, borderColor: "var(--accent)" }}>
          <strong>Staged changes — review before anything is written</strong>
          <div style={{ display: "grid", gap: 8, maxHeight: "40vh", overflowY: "auto" }}>
            {ops.map((op) =>
              op.kind === "create_task" ? (
                reviewRow(op.draftId, {
                  impact: op.task.impact,
                  suffix:
                    typeof op.task.parentId === "string" ? (
                      <span className="chip" style={{ fontSize: 11 }}>
                        under {draftTitles.get(op.task.parentId) ?? op.task.parentId}
                      </span>
                    ) : op.task.parentId != null ? (
                      <span className="chip" style={{ fontSize: 11 }}>subtask of #{op.task.parentId}</span>
                    ) : undefined,
                })
              ) : (
                <div key={op.draftId} style={{ display: "grid", gap: 4 }}>
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    Subtasks under{" "}
                    {typeof op.parentId === "string"
                      ? `"${draftTitles.get(op.parentId) ?? op.parentId}"`
                      : `task #${op.parentId}`}
                    :
                  </div>
                  {op.subtasks.map((s) => reviewRow(s.draftId, { indent: true, impact: s.impact }))}
                </div>
              ),
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ flex: 1, fontSize: 12, color: "var(--text-dim)" }}>
              Unchecked rows and rows with an empty title are skipped; dropping a draft parent
              drops its subtasks.
            </span>
            <button
              className="primary"
              onClick={onApply}
              disabled={apply.isPending || changeCount === 0}
            >
              {apply.isPending ? "Applying…" : `Apply ${changeCount} change${changeCount === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      {gated ? (
        <div className="panel" style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
          <span>
            First message: ~{gated.inputTokens.toLocaleString()} input tokens ≈ $
            {gated.estimatedUsd.toFixed(3)}
          </span>
          <button className="primary" onClick={onConfirmFirst} disabled={send.isPending}>
            {send.isPending ? "Thinking…" : "Send"}
          </button>
          <button onClick={() => setGated(null)}>Cancel</button>
        </div>
      ) : (
        <form
          style={{ display: "flex", gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void onSend();
          }}
        >
          <textarea
            rows={2}
            placeholder='e.g. "Plan my week around the exam — small steps, highest leverage first"'
            title="Message to the assistant"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
            style={{ flex: 1, fontSize: 14, resize: "vertical" }}
          />
          <button className="primary" type="submit" disabled={busy || !input.trim()}>
            {busy ? "…" : sessionId ? "Send" : "Estimate & send"}
          </button>
        </form>
      )}

      {error && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
          {error}
        </div>
      )}
    </div>
  );
}
