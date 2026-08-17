import {
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Category, Goal, NewTask, Task } from "../api/types";
import { useCreateSubtasks, useDeleteTask, useSplitTask, useUpdateTask } from "../hooks/useTasks";
import { useAiStatus } from "../hooks/useAi";
import { classifyTask, isSnoozed } from "../lib/drawable";
import { sequentialLockedByRecurrence } from "../lib/orderMode";
import { offersMoveUnder, reparentTargets } from "../lib/reparent";
import { evenSplitPlan } from "../lib/splitPlan";
import { classifyDrop } from "../lib/taskDnd";
import { TaskDndContext } from "./TaskDnd";
import { TaskBadges } from "./TaskBadges";
import { EstimateInput } from "./EstimateInput";
import { SnoozeMenu } from "./SnoozeMenu";
import { TaskForm } from "./TaskForm";
import { SubtaskEditor } from "./SubtaskEditor";
import { AiBreakdownPanel } from "./AiSuggestionPanel";
import {
  ArrowRightIcon,
  ArrowUpIcon,
  BranchIcon,
  KebabIcon,
  MoonIcon,
  MoveUnderIcon,
  PencilIcon,
  ScissorsIcon,
  SunIcon,
  SwapIcon,
  TrashIcon,
} from "./icons";

interface Props {
  task: Task;
  categories: Category[];
  goals?: Goal[];
  maxEffort: number;
  depth?: number;
  /**
   * The parent's subtaskOrderMode when this row is a subtask (#66, ADR-23):
   * under a 'sequential' parent the edit form hides the recurrence field —
   * a recurring step would gate its siblings forever, and the API rejects it.
   */
  parentOrderMode?: Task["subtaskOrderMode"];
  /**
   * Every root task on the page (#100) — the "Move under…" picker's candidate
   * pool. Passed to root AND subtask rows since #167: a childless subtask now
   * offers "Move under…" too (it can move under a different open root), so its
   * row also needs the target pool. Its own parent is listed but disabled with
   * the ALREADY_UNDER_TARGET reason.
   */
  rootTasks?: Task[];
  /**
   * Triage strip only (#151): render the inline Enter-to-save minutes input
   * next to the badges, so a needs-estimate row can be resolved in place
   * without opening the edit form.
   */
  estimateInput?: boolean;
}

export function TaskRow({
  task,
  categories,
  goals,
  maxEffort,
  depth = 0,
  parentOrderMode,
  rootTasks,
  estimateInput,
}: Props) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const createSubtasks = useCreateSubtasks();
  const splitTask = useSplitTask();
  const aiStatus = useAiStatus();
  const [breakingDown, setBreakingDown] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [aiPanel, setAiPanel] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [snoozing, setSnoozing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [orderModeError, setOrderModeError] = useState<string | null>(null);
  const [movingUnder, setMovingUnder] = useState(false);
  const [moveTargetId, setMoveTargetId] = useState("");
  const [reparentError, setReparentError] = useState<string | null>(null);
  // Row-resolve fade (#244): a confirmed delete fades the row out while the
  // DELETE round-trips — the refetch removes it for real (no optimistic
  // update, ADR-43 spirit). Scoped to delete only: a completed row STAYS
  // in the list under "show done", so a leave-fade there would strand a
  // visible row at opacity 0.
  const [leaving, setLeaving] = useState(false);

  const category = categories.find((c) => c.id === task.categoryId);
  const hasSubtasks = (task.subtasks?.length ?? 0) > 0;
  const done = task.status === "done";
  const snoozed = !done && isSnoozed(task);
  // Recurring × sequential guard (#66, ADR-23): a recurring subtask locks the
  // switch to 'do in order' — on the flip button and in both breakdown editors.
  const sequentialLocked = sequentialLockedByRecurrence(task.subtasks, task.subtaskOrderMode);
  // Reparent targets (#100): shared rule source with the drag-and-drop (#101)
  // — offersMoveUnder is the same childless gate classifyDrop routes on. Any
  // CHILDLESS task offers it now (#167): a root, or a subtask moving under a
  // different parent. offersMoveUnder already excludes containers (a task with
  // subtasks cannot become a subtask itself, ADR-16), so no extra !hasSubtasks
  // guard is needed here.
  const moveTargets =
    !done && offersMoveUnder(task) && rootTasks ? reparentTargets(task, rootTasks) : [];
  // Split-in-place (#108): where root rows show Break down, an open subtask
  // offers Split — a subtask cannot be broken down further (ADR-16), so it is
  // replaced by its parts as siblings.
  //
  // No longer scoped to too-big rows (#209). That gate had no counterpart in
  // the domain (routes/tasks.ts says so outright) and left a whole class of
  // task with no way to decompose at all: every QUEUED row is a subtask, so
  // "I can't break this down" was the common reading. The remaining
  // conditions all mirror something the endpoint actually rejects — archived
  // and done (400 "only an open subtask can be split") and recurring (400,
  // no part could carry the recurrence) — so the button no longer promises
  // anything the accept will refuse.
  //
  // An estimate IS still required, and that one is a UI judgement: the editor
  // pre-fills an even split, which divides a total. With no estimate there is
  // nothing to divide, and the row is already in the triage strip asking for
  // one. Too-big implies estimated, so this stays a superset of the old gate.
  const splittable =
    !done &&
    task.status !== "archived" &&
    task.parentId != null &&
    task.recurEveryDays == null &&
    task.effortMinutes != null;
  const splitBecauseTooBig = splittable && classifyTask(task, maxEffort) === "too-big";

  // Drag-and-drop (#101): context only exists on the Tasks page. During a
  // drag every row derives its own verdict from the same classifyDrop the
  // drop handler uses — eligible rows glow for the whole drag, the hovered
  // blocked row names its rule, everything else stays inert.
  const dnd = useContext(TaskDndContext);
  const dragVerdict = dnd?.dragging ? classifyDrop(dnd.dragging, { type: "row", task }) : null;
  const isDropOver = dnd?.overKey === `row:${task.id}`;
  const eligibleTarget = dragVerdict?.kind === "nest" && dragVerdict.blockReason == null;
  const dropBlockReason =
    isDropOver && dragVerdict?.kind === "nest" ? dragVerdict.blockReason : null;
  const dndClass = [
    dnd?.dragging?.id === task.id ? "dnd-source" : "",
    eligibleTarget ? "dnd-eligible" : "",
    eligibleTarget && isDropOver ? "dnd-over" : "",
    dropBlockReason ? "dnd-blocked" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Reorder gap zones (#157): thin drop lines between this parent's subtask
  // rows (and after the last), shown ONLY while dragging one of THIS parent's
  // open subtasks — reorder stays within one breakdown, and roots get none
  // (dragging a root leaves parentId null, so this never lights up for them).
  const showSubtaskGaps =
    !!dnd?.dragging && dnd.dragging.parentId === task.id && dnd.dragging.status === "open";
  // The dragged row's two flanking gaps (directly above it and directly below
  // it) are no-op drops — landing a task where it already sits (#157 review).
  // Suppress them so neither lights up on hover nor fires a wasted reorder;
  // gaps have zero footprint, so dropping two never shifts the rows. -1 when
  // not dragging one of these siblings.
  const draggingIdx = showSubtaskGaps
    ? (task.subtasks?.findIndex((s) => s.id === dnd!.dragging!.id) ?? -1)
    : -1;
  const flanksDragged = (i: number) => draggingIdx >= 0 && (i === draggingIdx || i === draggingIdx + 1);
  const draggedIsLast = draggingIdx >= 0 && draggingIdx === (task.subtasks?.length ?? 0) - 1;

  function snooze(patch: { deferredUntil?: string; blocked?: boolean }) {
    updateTask.mutate({ id: task.id, ...patch });
    setSnoozing(false);
  }

  async function saveEdit(patch: NewTask) {
    await updateTask.mutateAsync({ id: task.id, ...patch });
    setEditing(false);
  }

  async function reparent(parentId: number | null) {
    setReparentError(null);
    try {
      await updateTask.mutateAsync({ id: task.id, parentId });
      setMovingUnder(false);
      setMoveTargetId("");
    } catch (e) {
      // Server 400s (validation matrix) surface inline as the backstop, like
      // the order-mode flip does.
      setReparentError((e as Error).message);
    }
  }

  return (
    <div style={{ marginLeft: depth * 24 }}>
      {editing ? (
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <TaskForm
            key={task.id}
            categories={categories}
            // Subtasks follow their parent's goal — no goal select for them.
            goals={task.parentId == null ? goals : undefined}
            initial={task}
            autoFocus
            submitLabel="Save"
            // No recurrence on steps of an in-order breakdown (#66, ADR-23).
            hideRecur={parentOrderMode === "sequential"}
            onSubmit={saveEdit}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
      <div
        // Rows outside a DnD context (the triage strip, #151) are not drop
        // targets — without the attribute the hit-test skips them entirely.
        data-dnd-row={dnd ? task.id : undefined}
        // Palette landing hook (#243): TasksPage scrolls-and-flashes the row
        // the palette opened by this id — subtask rows carry it too via the
        // recursion below.
        data-task-id={task.id}
        // task-row lets the phone breakpoint wrap the action buttons onto
        // their own line (index.css, #193) — desktop keeps one line. The gap
        // lives in that stylesheet too: inline, it would beat the phone
        // block's tighter row-gap. The done-dim opacity moved to the .done
        // class (#244) so the .row-leave fade can win the cascade — an
        // inline opacity would beat both.
        className={["task-row", done ? "done" : "", leaving ? "row-leave" : "", dndClass]
          .filter(Boolean)
          .join(" ")}
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {/* Pointer-only by design (aria-hidden, not focusable): the drag is
            an alternative input, the #100 buttons stay the keyboard path.
            Living outside the row's buttons, it never fights their clicks. */}
        {dnd && !done && (
          <span
            className="dnd-handle"
            // Wording constraint: getByTitle matches SUBSTRINGS case-insensitively,
            // so this tooltip must not contain another control's title verbatim —
            // "Promote to top-level" here made the spec anchors resolve 2 elements.
            title="Drag to reorganize (keyboard: reparent via the row menu, promote via the row actions)"
            aria-hidden="true"
            onPointerDown={(e) => dnd.startDrag(task, e)}
            // Touch drags (#193): a long-press on the handle must start the
            // pointer drag, not Android's text-selection context menu.
            onContextMenu={(e) => e.preventDefault()}
          >
            ⠿
          </span>
        )}
        <input
          type="checkbox"
          checked={done}
          title={task.hasOpenChildren ? "Complete all subtasks first" : done ? "Reopen" : "Complete"}
          onChange={() =>
            updateTask.mutate({ id: task.id, status: done ? "open" : "done" })
          }
        />
        {hasSubtasks && (
          <button
            onClick={() => setExpanded((e) => !e)}
            style={{ padding: "0 6px", border: "none", background: "none" }}
            // Glyph-free accessible names (#249): without a label the caret's
            // name IS the triangle glyph — announced as "black down-pointing
            // small triangle".
            aria-label={expanded ? "Collapse subtasks" : "Expand subtasks"}
            aria-expanded={expanded}
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
        {/* minWidth (#213): the title always had the row's slack (flex: 1),
            but flex-shrink let a badge-heavy row crush it to min-content —
            one word per line. The floor flips who yields: past it the badges
            wrap onto a second line inside their own span instead. ~11em, not
            px, so it tracks the row's type size.
            One line, always (#244): the title owns the row — it ellipsises
            instead of ever wrapping, at any width down to the phone. It must
            stay a DIRECT child of .task-row: ~20 specs resolve the row as
            getByText(title).locator(".."). The title attribute keeps an
            elided title readable in place (native tooltip) — the one-line
            rule removed the wrapping that used to do that job. */}
        <span
          title={task.title}
          style={{
            textDecoration: done ? "line-through" : "none",
            flex: 1,
            minWidth: "11em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {category && depth === 0 && (
            <span className="dot" style={{ background: category.color, marginRight: 8 }} />
          )}
          {task.title}
        </span>
        {/* Subtasks follow their parent's goal (#76) — repeating the parent's
            goal chip on every step would be noise, so only root rows get it. */}
        <TaskBadges task={task} goals={task.parentId == null ? goals : undefined} />
        {estimateInput && !done && <EstimateInput task={task} categoryName={category?.name} />}
        {/* Action cluster (#244): every secondary control is an SVG icon
            button in .row-actions — on pointer devices hidden at rest and
            revealed by .task-row:hover / :focus-within, on touch devices
            always visible. The reveal is OPACITY ONLY (index.css): the
            buttons stay tabbable, measurable and clickable while visually
            hidden, which is what keeps keyboard users and Playwright's
            hover-first clicks working. Accessible names stay the old
            labels; where a spec selects by the title attribute (Edit,
            Promote) the title survives verbatim. */}
        <span className="row-actions">
          {snoozed ? (
            // Wake = deferredUntil now, not null (ADR-17): the retained value
            // becomes the wake timestamp, so staleness counts from here.
            <button
              className="icon-btn"
              onClick={() => snooze({ deferredUntil: new Date().toISOString(), blocked: false })}
              aria-label="Wake"
              title="Put this task back in the deck"
            >
              <SunIcon />
            </button>
          ) : (
            !done && (
              <button
                className="icon-btn"
                onClick={() => setSnoozing((s) => !s)}
                aria-label="Snooze"
                title="Take this task out of the deck"
              >
                <MoonIcon />
              </button>
            )
          )}
          {/* Sequential subtask mode (#23): flip "do in order" after the fact.
              Held-back siblings wear the ⏳ queued chip via TaskBadges. A
              recurring subtask locks the switch to sequential (#66, ADR-23);
              the server 400 is still surfaced below as a backstop (e.g. an
              archived recurring subtask is not in this list but blocks too).
              Glyph-free accessible names (#249): the icon carries the arrow,
              the name never does — sequential-subtasks.spec selects by exactly
              these names, and design-foundation.spec gates pictographs out of
              every accessible name in the action cluster. */}
          {!done && hasSubtasks && (
            <button
              className="icon-btn"
              disabled={sequentialLocked}
              onClick={async () => {
                setOrderModeError(null);
                try {
                  await updateTask.mutateAsync({
                    id: task.id,
                    subtaskOrderMode:
                      task.subtaskOrderMode === "sequential" ? "parallel" : "sequential",
                  });
                } catch (e) {
                  setOrderModeError((e as Error).message);
                }
              }}
              aria-label={task.subtaskOrderMode === "sequential" ? "Enforce step order" : "Any order"}
              title={
                sequentialLocked
                  ? "Cannot draw in order: a recurring subtask never closes and would gate the steps behind it forever — remove its recurrence first"
                  : task.subtaskOrderMode === "sequential"
                    ? "Subtasks are drawn in the listed order — click to allow them in any sequence"
                    : "Subtasks are drawn in any sequence — click to enforce the listed order"
              }
            >
              {task.subtaskOrderMode === "sequential" ? <ArrowRightIcon /> : <SwapIcon />}
            </button>
          )}
          {/* Break down (#122): ONE control, now also on done parents. Rule 3
              of the parent lifecycle (#111, ADR-32) — a new open subtask
              reopens a done parent — was API/MCP-only, because this
              affordance hid on every done row. Scoped to actual PARENTS: on
              a done leaf the checkbox already IS the reopen. Only the title
              changes on a done row, to name the reopen before the click. */}
          {/* Archived roots reach this row through the show-done list
              (status=all), and `done` only tests for "done" — so before #209
              they offered a Break down whose accept 400s with
              ARCHIVED_PARENT_ERROR. */}
          {task.parentId == null && task.status !== "archived" && (!done || hasSubtasks) && (
            <button
              className="icon-btn"
              onClick={() => setBreakingDown((b) => !b)}
              aria-label="Break down"
              title={
                done
                  ? "Add another step — this reopens the task and undoes its completion"
                  : "Split into small steps"
              }
            >
              <BranchIcon />
            </button>
          )}
          {splittable && (
            <button
              className="icon-btn"
              onClick={() => {
                setSnoozing(false);
                setMovingUnder(false);
                setSplitting((s) => !s);
              }}
              aria-label="Split"
              title={
                splitBecauseTooBig
                  ? "Too big to draw — replace this step with smaller parts at the same level"
                  : "Replace this step with smaller parts at the same level"
              }
            >
              <ScissorsIcon />
            </button>
          )}
          {!done && task.parentId != null && (
            <button
              className="icon-btn"
              onClick={() => reparent(null)}
              aria-label="Promote to top-level"
              title="Promote to top-level"
            >
              <ArrowUpIcon />
            </button>
          )}
          {/* Done rows are not editable — reopen first (matches the checkbox
              flow). Break down above is the deliberate exception: adding a
              step IS the reopen (#111 rule 3, ADR-32), not an edit that
              needs one first. */}
          {!done && (
            <button
              className="icon-btn"
              onClick={() => {
                setBreakingDown(false);
                setSplitting(false);
                setAiPanel(false);
                setSnoozing(false);
                setMovingUnder(false);
                setEditing(true);
              }}
              aria-label="Edit"
              title="Edit"
            >
              <PencilIcon />
            </button>
          )}
          {/* The overflow kebab (#244): the two rarest actions live one
              deliberate click away instead of repeating down the page.
              "Move under…" keeps being THE keyboard reparent control (#100)
              — the popover items are plain buttons, so both stay keyboard-
              operable by construction. */}
          <RowMenu
            items={[
              ...(moveTargets.length > 0
                ? [
                    {
                      label: "Move under…",
                      icon: <MoveUnderIcon />,
                      title: "Move under another task (it becomes a subtask)",
                      onPick: () => {
                        setBreakingDown(false);
                        setSnoozing(false);
                        setReparentError(null);
                        setMovingUnder((m) => !m);
                      },
                    },
                  ]
                : []),
              {
                label: "Delete",
                icon: <TrashIcon />,
                danger: true,
                onPick: () => {
                  if (confirm(`Delete "${task.title}"${hasSubtasks ? " and its subtasks" : ""}?`)) {
                    setLeaving(true);
                    deleteTask.mutate(task.id, { onError: () => setLeaving(false) });
                  }
                },
              },
            ]}
          />
        </span>
      </div>
      )}
      {dropBlockReason && (
        /* data-dnd-row makes the strip part of this row's hit target: it
           mounts right under the pointer, so drifting onto it must keep
           overKey on this row — without it the strip would unmount the
           moment the pointer touches it, flickering the feedback. The strip
           itself is an absolute overlay (TaskDnd.css, #250): appearing
           mid-drag must not shift the rows below the pointer. */
        <div className="dnd-reason" data-dnd-row={task.id} role="status">
          Cannot drop here — {dropBlockReason}
        </div>
      )}
      {orderModeError && (
        <div role="alert" style={{ padding: "4px 10px", color: "var(--danger)", fontSize: 13 }}>
          {orderModeError}
        </div>
      )}
      {movingUnder && !editing && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap", // the select can be title-wide — phone widths wrap (#193)
            gap: 8,
            padding: "8px 10px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <label htmlFor={`move-under-${task.id}`} style={{ color: "var(--text-dim)", fontSize: 13 }}>
            Move under
          </label>
          <select
            id={`move-under-${task.id}`}
            value={moveTargetId}
            onChange={(e) => setMoveTargetId(e.target.value)}
          >
            <option value="">choose a task…</option>
            {/* Blocked targets stay listed but disabled WITH their reason —
                the rule is visible instead of the option silently missing. */}
            {moveTargets.map(({ target, blockReason }) => (
              <option key={target.id} value={target.id} disabled={blockReason != null}>
                {target.title}
                {blockReason ? ` — ${blockReason}` : ""}
              </option>
            ))}
          </select>
          <button disabled={moveTargetId === ""} onClick={() => reparent(Number(moveTargetId))}>
            Move
          </button>
          <button
            onClick={() => {
              setMovingUnder(false);
              setMoveTargetId("");
              setReparentError(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {reparentError && (
        <div role="alert" style={{ padding: "4px 10px", color: "var(--danger)", fontSize: 13 }}>
          {reparentError}
        </div>
      )}
      {snoozing && !snoozed && (
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <SnoozeMenu
            onSnooze={(iso) => snooze({ deferredUntil: iso })}
            onBlock={() => snooze({ blocked: true })}
          />
        </div>
      )}
      {/* Split-in-place (#108): the SubtaskEditor pattern reused — retitled,
          without the "Do in order" toggle (parts join the parent's existing
          mode), pre-filled with the deterministic even split, min 2 parts.
          The AI suggest reuses the breakdown endpoint (taskContext works for
          any task id); only the ACCEPT differs — it calls the split endpoint,
          replacing this row with its parts as siblings. */}
      {splitting && (
        <>
          {aiStatus.data?.configured && !aiPanel && (
            <button
              style={{ margin: "8px 0 0", borderColor: "var(--accent)" }}
              onClick={() => setAiPanel(true)}
            >
              <span aria-hidden="true">✨ </span>Suggest with AI
            </button>
          )}
          {aiPanel && (
            <AiBreakdownPanel
              taskId={task.id}
              goalId={task.goalId}
              hideOrderToggle
              acceptLabel={(n) => `Split into ${n} part${n === 1 ? "" : "s"}`}
              onClose={() => setAiPanel(false)}
              onAccept={async (parts) => {
                // Sibling-replacement semantics on accept: the split endpoint,
                // never createSubtasks (per-part impact stays out of scope —
                // parts inherit the original's rating).
                await splitTask.mutateAsync({
                  id: task.id,
                  parts: parts.map(({ title, effortMinutes }) => ({ title, effortMinutes })),
                });
                setSplitting(false);
              }}
            />
          )}
          <SubtaskEditor
            maxEffort={maxEffort}
            heading={`Split into parts — they replace this step at the same level (drawable ≤ ${maxEffort} min, bigger parts can be split again)`}
            // minRows gates accept at 2, so the pre-fill must offer 2 (#209):
            // a subtask under maxEffort splits into one part by arithmetic.
            initialRows={evenSplitPlan(task.title, task.effortMinutes ?? 0, maxEffort, 2)}
            minRows={2}
            requireMinutes
            hideOrderToggle
            acceptLabel={(n) => `Split into ${n} part${n === 1 ? "" : "s"}`}
            onCancel={() => setSplitting(false)}
            onAccept={async (parts) => {
              await splitTask.mutateAsync({
                id: task.id,
                // requireMinutes gates accept, so effortMinutes is present.
                parts: parts.map(({ title, effortMinutes }) => ({
                  title,
                  effortMinutes: effortMinutes!,
                })),
              });
              setSplitting(false);
            }}
          />
        </>
      )}
      {breakingDown && (
        <>
          {aiStatus.data?.configured && !aiPanel && (
            <button
              style={{ margin: "8px 0 0", borderColor: "var(--accent)" }}
              onClick={() => setAiPanel(true)}
            >
              <span aria-hidden="true">✨ </span>Suggest with AI
            </button>
          )}
          {aiPanel && (
            <AiBreakdownPanel
              taskId={task.id}
              goalId={task.goalId}
              // A re-breakdown seeds from the persisted mode (#67); only a
              // fresh parent lets the model's orderMatters pre-set the toggle.
              initialOrderMode={hasSubtasks ? task.subtaskOrderMode : undefined}
              sequentialLocked={sequentialLocked}
              onClose={() => setAiPanel(false)}
              onAccept={async (subtasks, orderMode) => {
                await createSubtasks.mutateAsync({ parentId: task.id, subtasks, orderMode });
                setBreakingDown(false);
              }}
            />
          )}
          <SubtaskEditor
            maxEffort={maxEffort}
            initialOrderMode={task.subtaskOrderMode}
            sequentialLocked={sequentialLocked}
            onCancel={() => setBreakingDown(false)}
            onAccept={async (subtasks, orderMode) => {
              await createSubtasks.mutateAsync({ parentId: task.id, subtasks, orderMode });
              setBreakingDown(false);
            }}
          />
        </>
      )}
      {expanded &&
        task.subtasks?.map((s, i) => (
          <Fragment key={s.id}>
            {showSubtaskGaps && !flanksDragged(i) && (
              <SubtaskGap
                parentId={task.id}
                beforeId={s.id}
                depth={depth + 1}
                over={dnd?.overKey === `gap:${task.id}:${s.id}`}
              />
            )}
            <TaskRow
              task={s}
              categories={categories}
              goals={goals}
              maxEffort={maxEffort}
              depth={depth + 1}
              parentOrderMode={task.subtaskOrderMode}
              // A childless subtask offers "Move under…" too (#167) — it needs
              // the same root pool as its parent to list cross-parent targets.
              rootTasks={rootTasks}
            />
          </Fragment>
        ))}
      {/* Trailing gap = drop after the last sibling (beforeId null → the end).
          Suppressed when the dragged row already IS last — that gap sits right
          below it, another no-op. */}
      {expanded && showSubtaskGaps && !draggedIsLast && (
        <SubtaskGap
          parentId={task.id}
          beforeId={null}
          depth={depth + 1}
          over={dnd?.overKey === `gap:${task.id}:end`}
        />
      )}
    </div>
  );
}

/**
 * The row overflow menu (#244): a minimal popover, not a modal — no root
 * inert, no focus trap. Opens on click/Enter on the "More actions" kebab;
 * closes on Escape (focus returns to the trigger), outside pointerdown,
 * focus leaving the wrap (a keyboard user Tabbing away must not leave an
 * invisible open popover with a stale aria-expanded — and it keeps the
 * helpers.ts invariant that only one .row-menu is ever open, for keyboard
 * users too), or picking an item. Items are plain buttons reachable with Tab AND walkable
 * with ArrowUp/ArrowDown; the design-foundation spec drives the whole
 * keyboard round-trip.
 */
function RowMenu({
  items,
}: {
  items: { label: string; icon: ReactNode; title?: string; danger?: boolean; onPick: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function onKeyDown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      // Contain it: Escape here closes THIS popover, never a surrounding
      // overlay's handler too.
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const buttons = Array.from(
        wrapRef.current?.querySelectorAll<HTMLButtonElement>(".row-menu button") ?? [],
      );
      if (buttons.length === 0) return;
      const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "ArrowDown"
          ? (idx + 1) % buttons.length
          : idx <= 0
            ? buttons.length - 1
            : idx - 1;
      buttons[next].focus();
    }
  }

  return (
    <span
      ref={wrapRef}
      className="row-menu-wrap"
      onKeyDown={onKeyDown}
      // React's onBlur is the bubbling focusout: relatedTarget is where focus
      // went, null when it left the document — contains(null) is false, so
      // that closes too.
      onBlur={(e) => {
        if (open && !wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        className="icon-btn"
        aria-label="More actions"
        title="More actions"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <KebabIcon />
      </button>
      {open && (
        <div className="row-menu">
          {items.map((it) => (
            <button
              key={it.label}
              className={it.danger ? "danger" : undefined}
              title={it.title}
              onClick={() => {
                setOpen(false);
                it.onPick();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * A reorder drop line between sibling rows (#157). Its net vertical footprint
 * is zero — a 12px hit box pulled back by equal negative margins so it
 * overlays the row boundary and appearing mid-drag never shifts the rows under
 * the pointer (the nest/promote drags rely on stable geometry). The visible
 * 2px line and its hover glow live in TaskDnd.css, behind the same
 * dnd-over language the rows use; motion stays reduced-motion safe there.
 */
function SubtaskGap({
  parentId,
  beforeId,
  depth,
  over,
}: {
  parentId: number;
  beforeId: number | null;
  depth: number;
  over: boolean;
}) {
  return (
    <div
      className={"dnd-gap" + (over ? " dnd-over" : "")}
      data-dnd-gap={`${parentId}:${beforeId ?? "end"}`}
      style={{ marginLeft: depth * 24 }}
      aria-hidden="true"
    />
  );
}
