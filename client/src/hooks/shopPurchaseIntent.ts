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

export type PackPurchaseAttempt =
  | { kind: "success"; response: PackPurchaseResult }
  | { kind: "definitive-error"; error: ApiError }
  | { kind: "unresolved"; error: PackTransportError | PackResponseError | Error; intent: PackPurchaseIntent };

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

function clearPackPurchaseIntent(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
): void {
  try {
    storage.removeItem(SHOP_PURCHASE_INTENT_KEY);
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

async function finishOneRequest(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
  request: PackPurchaseRequest,
): Promise<PackPurchaseAttempt> {
  try {
    const response = await request(intent);
    clearPackPurchaseIntent(storage, intent);
    return { kind: "success", response };
  } catch (error) {
    if (error instanceof ApiError) {
      clearPackPurchaseIntent(storage, intent);
      return { kind: "definitive-error", error };
    }
    const unresolved = error instanceof Error ? error : new Error("Unknown purchase failure");
    return { kind: "unresolved", error: unresolved, intent };
  }
}

/** Persist-before-send initial attempt with one transport-only automatic retry. */
export async function startPackPurchase(
  storage: SessionStorageLike,
  payment: PackPayment,
  ref: string,
  request: PackPurchaseRequest,
): Promise<PackPurchaseAttempt> {
  const intent = newIntent(payment, ref);
  savePackPurchaseIntent(storage, intent);

  try {
    const response = await request(intent);
    clearPackPurchaseIntent(storage, intent);
    return { kind: "success", response };
  } catch (error) {
    if (error instanceof ApiError) {
      clearPackPurchaseIntent(storage, intent);
      return { kind: "definitive-error", error };
    }
    if (!(error instanceof PackTransportError)) {
      const unresolved = error instanceof Error ? error : new Error("Unknown purchase failure");
      return { kind: "unresolved", error: unresolved, intent };
    }

    const retryIntent: PackPurchaseIntent = { ...intent, automaticRetryConsumed: true };
    savePackPurchaseIntent(storage, retryIntent);
    return finishOneRequest(storage, retryIntent, request);
  }
}

/** Resume/manual retry is exactly one request and never changes the automatic-retry allowance. */
export function retryPackPurchase(
  storage: SessionStorageLike,
  intent: PackPurchaseIntent,
  request: PackPurchaseRequest,
): Promise<PackPurchaseAttempt> {
  return finishOneRequest(storage, intent, request);
}
