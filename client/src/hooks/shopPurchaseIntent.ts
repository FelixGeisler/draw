import { ApiError } from "../api/client";
import {
  PackResponseError,
  PackTransportError,
  type PackPayment,
  type PackPurchaseResult,
} from "./useShop";

export const SHOP_PURCHASE_INTENT_KEY = "draw:shop:pack-purchase-intent";
const PURCHASE_INTENT_VERSION = 1;

export interface PackPurchaseIntent {
  version: 1;
  ref: string;
  payment: PackPayment;
  automaticRetryConsumed: boolean;
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PackPurchaseRequest = (intent: PackPurchaseIntent) => Promise<PackPurchaseResult>;
export type PackPurchasePublisher = (response: PackPurchaseResult) => void;

export type PackPurchaseAttempt =
  | { kind: "success"; response: PackPurchaseResult }
  | { kind: "definitive-error"; error: ApiError }
  | { kind: "unresolved"; error: PackTransportError | PackResponseError | Error; intent: PackPurchaseIntent }
  | { kind: "stale" };

export class PackPurchaseStorageError extends Error {
  constructor(
    message: string,
    public readonly intent: PackPurchaseIntent | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isIntent(value: unknown): value is PackPurchaseIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.join(",") === "automaticRetryConsumed,payment,ref,version" &&
    record.version === PURCHASE_INTENT_VERSION &&
    typeof record.ref === "string" &&
    UUID_PATTERN.test(record.ref) &&
    (record.payment === "gold" || record.payment === "ticket") &&
    typeof record.automaticRetryConsumed === "boolean"
  );
}

/** Read the one tab-scoped intent. Invalid/old values are discarded and never returned for replay. */
export function loadPackPurchaseIntent(storage: SessionStorageLike): PackPurchaseIntent | null {
  let raw: string | null;
  try {
    raw = storage.getItem(SHOP_PURCHASE_INTENT_KEY);
  } catch (cause) {
    throw new PackPurchaseStorageError(
      "Purchase recovery storage is unavailable. Enable session storage and reload before buying a pack.",
      null,
      { cause },
    );
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (isIntent(parsed)) return parsed;

  try {
    storage.removeItem(SHOP_PURCHASE_INTENT_KEY);
  } catch (cause) {
    throw new PackPurchaseStorageError(
      "An invalid saved purchase could not be cleared. Enable session storage and reload.",
      null,
      { cause },
    );
  }
  return null;
}

export function savePackPurchaseIntent(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
): void {
  try {
    storage.setItem(SHOP_PURCHASE_INTENT_KEY, JSON.stringify(intent));
  } catch (cause) {
    throw new PackPurchaseStorageError(
      "The purchase could not be saved for safe retry. Enable session storage and try again; no pack was opened.",
      intent,
      { cause },
    );
  }
}

function sameIntent(left: PackPurchaseIntent, right: PackPurchaseIntent): boolean {
  return (
    left.version === right.version &&
    left.ref === right.ref &&
    left.payment === right.payment &&
    left.automaticRetryConsumed === right.automaticRetryConsumed
  );
}

function isCurrentPackPurchaseIntent(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
): boolean {
  let raw: string | null;
  try {
    raw = storage.getItem(SHOP_PURCHASE_INTENT_KEY);
  } catch (cause) {
    throw new PackPurchaseStorageError(
      "The saved purchase could not be verified in session storage. Enable storage and reload to reconcile it safely.",
      intent,
      { cause },
    );
  }
  if (raw === null) return false;

  try {
    const current: unknown = JSON.parse(raw);
    return isIntent(current) && sameIntent(current, intent);
  } catch {
    return false;
  }
}

/** Clear only the exact generation that the settling request was bound to. */
function clearPackPurchaseIntent(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
): boolean {
  if (!isCurrentPackPurchaseIntent(storage, intent)) return false;
  try {
    storage.removeItem(SHOP_PURCHASE_INTENT_KEY);
    return true;
  } catch (cause) {
    throw new PackPurchaseStorageError(
      "The completed purchase could not be cleared from session storage. Enable storage and reload to reconcile it safely.",
      intent,
      { cause },
    );
  }
}

function newIntent(payment: PackPayment, ref: string): PackPurchaseIntent {
  return { version: PURCHASE_INTENT_VERSION, ref, payment, automaticRetryConsumed: false };
}

function unresolvedAttempt(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
  error: unknown,
): PackPurchaseAttempt {
  if (!isCurrentPackPurchaseIntent(storage, intent)) return { kind: "stale" };
  const unresolved = error instanceof Error ? error : new Error("Unknown purchase failure");
  return { kind: "unresolved", error: unresolved, intent };
}

function definitiveAttempt(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
  error: ApiError,
): PackPurchaseAttempt {
  if (!clearPackPurchaseIntent(storage, intent)) return { kind: "stale" };
  return { kind: "definitive-error", error };
}

function successfulAttempt(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
  response: PackPurchaseResult,
  publish: PackPurchasePublisher,
): PackPurchaseAttempt {
  if (response.opening.ref !== intent.ref || response.opening.payment !== intent.payment) {
    return unresolvedAttempt(
      storage,
      intent,
      new PackResponseError("The purchase response did not match the saved purchase."),
    );
  }
  if (!clearPackPurchaseIntent(storage, intent)) return { kind: "stale" };
  publish(response);
  return { kind: "success", response };
}

async function finishOneRequest(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
  request: PackPurchaseRequest,
  publish: PackPurchasePublisher,
): Promise<PackPurchaseAttempt> {
  let response: PackPurchaseResult;
  try {
    response = await request(intent);
  } catch (error) {
    return error instanceof ApiError
      ? definitiveAttempt(storage, intent, error)
      : unresolvedAttempt(storage, intent, error);
  }
  return successfulAttempt(storage, intent, response, publish);
}

/** Persist-before-send initial attempt with one transport-only automatic retry. */
export async function startPackPurchase(
  storage: SessionStorageLike,
  payment: PackPayment,
  ref: string,
  request: PackPurchaseRequest,
  publish: PackPurchasePublisher = () => undefined,
): Promise<PackPurchaseAttempt> {
  const intent = newIntent(payment, ref);
  savePackPurchaseIntent(storage, intent);

  let response: PackPurchaseResult;
  try {
    response = await request(intent);
  } catch (error) {
    if (error instanceof ApiError) return definitiveAttempt(storage, intent, error);
    if (!(error instanceof PackTransportError)) {
      return unresolvedAttempt(storage, intent, error);
    }
    if (!isCurrentPackPurchaseIntent(storage, intent)) return { kind: "stale" };

    const retryIntent: PackPurchaseIntent = { ...intent, automaticRetryConsumed: true };
    savePackPurchaseIntent(storage, retryIntent);
    return finishOneRequest(storage, retryIntent, request, publish);
  }
  return successfulAttempt(storage, intent, response, publish);
}

/** Resume/manual retry is exactly one request and never changes the automatic-retry allowance. */
export function retryPackPurchase(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
  request: PackPurchaseRequest,
  publish: PackPurchasePublisher = () => undefined,
): Promise<PackPurchaseAttempt> {
  return finishOneRequest(storage, intent, request, publish);
}
