import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { PackResponseError, PackTransportError, type PackPurchaseResult } from "./useShop";
import {
  loadPackPurchaseIntent,
  PackPurchaseStorageError,
  retryPackPurchase,
  savePackPurchaseIntent,
  SHOP_PURCHASE_INTENT_KEY,
  startPackPurchase,
  type PackPurchaseIntent,
  type SessionStorageLike,
} from "./shopPurchaseIntent";

const REF = "123e4567-e89b-42d3-a456-426614174000";
const RESPONSE = { opening: {}, shop: {}, replayed: false } as PackPurchaseResult;

class MemoryStorage implements SessionStorageLike {
  values = new Map<string, string>();
  log: string[] = [];
  failSet = false;

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.log.push(`set:${value}`);
    if (this.failSet) throw new Error("blocked");
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.log.push("remove");
    this.values.delete(key);
  }
}

function intent(overrides: Partial<PackPurchaseIntent> = {}): PackPurchaseIntent {
  return {
    version: 1,
    ref: REF,
    payment: "gold",
    automaticRetryConsumed: false,
    ...overrides,
  };
}

describe("tab-scoped pack purchase intent", () => {
  it("round-trips only the versioned ref/payment/retry record", () => {
    const storage = new MemoryStorage();
    savePackPurchaseIntent(storage, intent({ payment: "ticket", automaticRetryConsumed: true }));
    expect(loadPackPurchaseIntent(storage)).toEqual(
      intent({ payment: "ticket", automaticRetryConsumed: true }),
    );
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 2, ref: REF, payment: "gold", automaticRetryConsumed: false }),
    JSON.stringify({ version: 1, ref: "not-a-uuid", payment: "gold", automaticRetryConsumed: false }),
    JSON.stringify({
      version: 1,
      ref: REF,
      payment: "gold",
      automaticRetryConsumed: false,
      gold: 100,
    }),
  ])("removes a malformed/unsupported value without returning it", (raw) => {
    const storage = new MemoryStorage();
    storage.values.set(SHOP_PURCHASE_INTENT_KEY, raw);
    expect(loadPackPurchaseIntent(storage)).toBeNull();
    expect(storage.values.has(SHOP_PURCHASE_INTENT_KEY)).toBe(false);
  });

  it("fails closed before the first request when persistence fails", async () => {
    const storage = new MemoryStorage();
    storage.failSet = true;
    const request = vi.fn();
    await expect(startPackPurchase(storage, "gold", REF, request)).rejects.toBeInstanceOf(
      PackPurchaseStorageError,
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe("pack purchase retry state machine", () => {
  it("persists before send and clears a definitive success", async () => {
    const storage = new MemoryStorage();
    const request = vi.fn(async (pending: PackPurchaseIntent) => {
      storage.log.push(`request:${pending.ref}:${pending.payment}`);
      return RESPONSE;
    });
    await expect(startPackPurchase(storage, "gold", REF, request)).resolves.toEqual({
      kind: "success",
      response: RESPONSE,
    });
    expect(storage.log[0]).toContain('"payment":"gold"');
    expect(storage.log[1]).toBe(`request:${REF}:gold`);
    expect(storage.log.at(-1)).toBe("remove");
  });

  it("automatically retries one transport rejection with identical identity after marking it consumed", async () => {
    const storage = new MemoryStorage();
    const seen: PackPurchaseIntent[] = [];
    const request = vi
      .fn(async (pending: PackPurchaseIntent) => {
        seen.push({ ...pending });
        if (seen.length === 1) throw new PackTransportError();
        return RESPONSE;
      });

    await expect(startPackPurchase(storage, "ticket", REF, request)).resolves.toMatchObject({
      kind: "success",
    });
    expect(seen).toEqual([
      intent({ payment: "ticket" }),
      intent({ payment: "ticket", automaticRetryConsumed: true }),
    ]);
    expect(storage.log[1]).toContain('"automaticRetryConsumed":true');
  });

  it("never retries an HTTP error and clears the intent", async () => {
    const storage = new MemoryStorage();
    const request = vi.fn().mockRejectedValue(new ApiError(400, "insufficient Gold"));
    await expect(startPackPurchase(storage, "gold", REF, request)).resolves.toMatchObject({
      kind: "definitive-error",
      error: { status: 400, message: "insufficient Gold" },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(loadPackPurchaseIntent(storage)).toBeNull();
  });

  it.each([new PackResponseError(), new Error("unreadable JSON")])(
    "retains a non-HTTP response failure without automatic retry",
    async (failure) => {
      const storage = new MemoryStorage();
      const request = vi.fn().mockRejectedValue(failure);
      await expect(startPackPurchase(storage, "gold", REF, request)).resolves.toMatchObject({
        kind: "unresolved",
        intent: intent(),
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(loadPackPurchaseIntent(storage)).toEqual(intent());
    },
  );

  it("exhausts the single automatic retry and keeps the consumed marker", async () => {
    const storage = new MemoryStorage();
    const request = vi.fn().mockRejectedValue(new PackTransportError());
    await expect(startPackPurchase(storage, "gold", REF, request)).resolves.toMatchObject({
      kind: "unresolved",
      intent: intent({ automaticRetryConsumed: true }),
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(loadPackPurchaseIntent(storage)).toEqual(intent({ automaticRetryConsumed: true }));
  });

  it("manual resume is one request with the same payment/ref and preserves the retry marker", async () => {
    const storage = new MemoryStorage();
    const pending = intent({ payment: "ticket", automaticRetryConsumed: true });
    savePackPurchaseIntent(storage, pending);
    const request = vi.fn().mockRejectedValue(new PackTransportError());
    await expect(retryPackPurchase(storage, pending, request)).resolves.toMatchObject({
      kind: "unresolved",
      intent: pending,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(pending);
    expect(loadPackPurchaseIntent(storage)).toEqual(pending);
  });
});
