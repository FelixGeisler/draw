import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../api/types";
import { classifyDrop, passesDragThreshold, type DropSpot } from "../lib/taskDnd";
import "./TaskDnd.css";

/**
 * Pointer drag-and-drop for the Tasks page (#101) — an alternative input for
 * the #100 reparent controls, not a new concern: the drop handler issues the
 * same PATCH parentId the menu does, and every verdict comes from
 * lib/taskDnd.ts → lib/reparent.ts. Hand-rolled on pointer events (no
 * dependency): pointerdown on a row's handle arms a drag and captures the
 * pointer, a 5px threshold separates drags from clicks, elementFromPoint
 * hit-tests the row/zone under the cursor, Escape or pointercancel abandons
 * it. The session is bound to its starting pointerId — a second touch can
 * neither steer nor commit it — and a move without a held button (the
 * release happened outside the window, uncaptured) retires the session
 * before any later pointerup could commit an accidental drop.
 *
 * The ghost follows the pointer via a ref (a position, not an animation — no
 * re-render per move, nothing for prefers-reduced-motion to object to); the
 * decorative enter transitions live in TaskDnd.css behind a
 * no-preference media query.
 */

export interface TaskDndController {
  /** The task being dragged — null while idle. Rows derive their own
   *  eligible/blocked/source styling from this via classifyDrop. */
  dragging: Task | null;
  /** Hit-test key of the spot under the pointer: "row:<id>" or "zone". */
  overKey: string | null;
  /** Server 400 from a drop — the backstop, like the menu's inline error. */
  dropError: string | null;
  /** Wire to the row handle's onPointerDown. */
  startDrag: (task: Task, e: React.PointerEvent<HTMLElement>) => void;
  /** Attach to the ghost element so it can follow the pointer. */
  ghostRef: (el: HTMLDivElement | null) => void;
}

/** Null outside the Tasks page — TaskRow renders no drag affordance then. */
export const TaskDndContext = createContext<TaskDndController | null>(null);

interface Session {
  task: Task;
  /** The pointer that started the drag — move/up/cancel ignore all others. */
  pointerId: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  active: boolean;
  overKey: string | null;
}

function ghostTransform(x: number, y: number): string {
  // Offset past the cursor so the ghost never hides the row under it.
  return `translate(${x + 14}px, ${y + 10}px)`;
}

export function useTaskDnd(opts: {
  taskById: (id: number) => Task | undefined;
  reparent: (taskId: number, parentId: number | null) => Promise<unknown>;
}): TaskDndController {
  const [dragging, setDragging] = useState<Task | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const ghostEl = useRef<HTMLDivElement | null>(null);
  const session = useRef<Session | null>(null);
  // Unmount cleanup: navigating away mid-drag must tear down the session and
  // its window listeners. end() is session-scoped (defined inside startDrag),
  // so each session parks its own teardown here while it runs.
  const endRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endRef.current?.(), []);

  const ghostRef = useCallback((el: HTMLDivElement | null) => {
    ghostEl.current = el;
    // The ghost mounts on the first post-threshold move — place it before
    // paint so it never flashes at the viewport origin.
    if (el && session.current) {
      el.style.transform = ghostTransform(session.current.x, session.current.y);
    }
  }, []);

  const startDrag = useCallback((task: Task, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || session.current) return;
    // Keep the press from starting a text selection; with touch-action: none
    // on the handle, touch pointers stay ours instead of scrolling.
    e.preventDefault();
    // Capture the pointer so a release OUTSIDE the window still delivers its
    // pointerup — without capture the session would survive that release and
    // the next in-page click's pointerup would commit an accidental drop.
    // Capture only retargets events (they still bubble to window) and does
    // not affect elementFromPoint, so the hit-testing below is untouched.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Stale pointer or no capture support — the buttons check in move()
      // still retires an uncaptured session before it can drop.
    }

    const spotFromKey = (key: string): DropSpot | null => {
      if (key === "zone") return { type: "root-zone" };
      const target = optsRef.current.taskById(Number(key.slice("row:".length)));
      return target ? { type: "row", task: target } : null;
    };

    const move = (ev: PointerEvent) => {
      const s = session.current;
      // Only the starting pointer steers the drag — on touch, a second
      // finger must neither move the ghost nor (via its lift) commit it.
      if (!s || ev.pointerId !== s.pointerId) return;
      // Our pointer moving with no button held means its release was never
      // delivered (it happened outside the window, uncaptured): retire the
      // zombie session before any pointerup can land a drop. Live mouse,
      // touch and pen contacts always report a pressed button here.
      if (ev.buttons === 0) {
        end(false);
        return;
      }
      s.x = ev.clientX;
      s.y = ev.clientY;
      if (!s.active) {
        if (!passesDragThreshold(s.x0, s.y0, ev.clientX, ev.clientY)) return;
        s.active = true;
        setDropError(null);
        setDragging(s.task);
      }
      if (ghostEl.current) ghostEl.current.style.transform = ghostTransform(s.x, s.y);
      // The ghost is pointer-events: none, so elementFromPoint sees the row
      // (or the fixed root zone) underneath it.
      const el = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest("[data-dnd-row], [data-dnd-zone]");
      const key =
        el == null
          ? null
          : el.hasAttribute("data-dnd-zone")
            ? "zone"
            : `row:${el.getAttribute("data-dnd-row")}`;
      if (key !== s.overKey) {
        s.overKey = key;
        setOverKey(key);
      }
    };

    const end = (drop: boolean) => {
      const s = session.current;
      if (!s) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", esc);
      session.current = null;
      endRef.current = null;
      setDragging(null);
      setOverKey(null);
      if (!drop || !s.active || s.overKey == null) return;
      const verdict = classifyDrop(s.task, spotFromKey(s.overKey));
      // An invalid drop leaves the tree untouched — the hover already named
      // the rule; releasing is simply a cancel.
      if (verdict.kind === "inert" || verdict.blockReason != null) return;
      const parentId = verdict.kind === "nest" ? verdict.targetId : null;
      optsRef.current.reparent(s.task.id, parentId).catch((err) => {
        // Server 400s (the validation matrix sees archived children etc. that
        // the client mirror cannot) surface as the backstop.
        setDropError((err as Error).message);
      });
    };
    // Same identity discipline as move: only the session's own pointer can
    // commit or cancel — a second finger lifting is not our release.
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === session.current?.pointerId) end(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === session.current?.pointerId) end(false);
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") end(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", esc);
    session.current = {
      task,
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      active: false,
      overKey: null,
    };
    endRef.current = () => end(false);
  }, []);

  return { dragging, overKey, dropError, startDrag, ghostRef };
}

/**
 * The floating pieces of a live drag: the fixed promote zone (the drop
 * target for "subtask → top level") and the title ghost under the cursor.
 * Rendered by TasksPage while a drag is active.
 */
export function TaskDragOverlay({ dnd }: { dnd: TaskDndController }) {
  if (!dnd.dragging) return null;
  const verdict = classifyDrop(dnd.dragging, { type: "root-zone" });
  const blockReason = verdict.kind === "promote" ? verdict.blockReason : null;
  const over = dnd.overKey === "zone";
  return (
    <>
      <div
        data-dnd-zone="true"
        role="status"
        className={
          "dnd-root-zone " +
          (blockReason ? "dnd-zone-blocked" : "dnd-zone-eligible") +
          (over ? " dnd-over" : "")
        }
      >
        {blockReason
          ? `⤴ Cannot drop here — ${blockReason}`
          : `⤴ Drop here to promote “${dnd.dragging.title}” to top level`}
      </div>
      <div className="dnd-ghost" ref={dnd.ghostRef} aria-hidden="true">
        {dnd.dragging.title}
      </div>
    </>
  );
}
