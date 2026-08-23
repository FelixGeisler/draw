import type { PackPurchaseResult } from "../hooks/useShop";

export type PackRevealStage = "background-ready" | "bonus-ready" | "complete";

export interface PackRevealIdentity {
  ref: string;
  openingOrder: number;
}

export interface PackRevealSession {
  identity: PackRevealIdentity;
  result: PackPurchaseResult;
  stage: PackRevealStage;
  reducedMotion: boolean;
  completion: "reveal" | "skip" | "reduced" | null;
}

export type PackRevealAction = "reveal-background" | "reveal-bonus" | "skip";

export interface PackRevealEvent {
  identity: PackRevealIdentity;
  action: PackRevealAction;
}

export interface PackRevealTransition {
  session: PackRevealSession;
  celebrate: boolean;
}

export function samePackReveal(
  left: PackRevealIdentity,
  right: PackRevealIdentity,
): boolean {
  return left.ref === right.ref && left.openingOrder === right.openingOrder;
}

/** Snapshot one validated purchase response; no later cache state participates. */
export function createPackRevealSession(
  result: PackPurchaseResult,
  reducedMotion: boolean,
): PackRevealSession {
  return {
    identity: {
      ref: result.opening.ref,
      openingOrder: result.opening.openingOrder,
    },
    result,
    stage: reducedMotion ? "complete" : "background-ready",
    reducedMotion,
    completion: reducedMotion ? "reduced" : null,
  };
}

/**
 * Pure current-session state machine. Identity guards make callbacks retained
 * by an older portal harmless after a newer response has taken ownership.
 */
export function transitionPackReveal(
  current: PackRevealSession,
  event: PackRevealEvent,
): PackRevealTransition {
  if (current.reducedMotion || !samePackReveal(current.identity, event.identity)) {
    return { session: current, celebrate: false };
  }

  if (event.action === "skip") {
    return current.stage === "complete"
      ? { session: current, celebrate: false }
      : {
          session: { ...current, stage: "complete", completion: "skip" },
          celebrate: false,
        };
  }

  if (event.action === "reveal-background" && current.stage === "background-ready") {
    const hasBonus = current.result.opening.bonus !== "none";
    return {
      session: {
        ...current,
        stage: hasBonus ? "bonus-ready" : "complete",
        completion: hasBonus ? null : "reveal",
      },
      celebrate: !hasBonus,
    };
  }

  if (event.action === "reveal-bonus" && current.stage === "bonus-ready") {
    return {
      session: { ...current, stage: "complete", completion: "reveal" },
      celebrate: true,
    };
  }

  return { session: current, celebrate: false };
}
