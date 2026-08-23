import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  applyPackPurchaseSnapshot,
  PackResponseError,
  PackTransportError,
  type PackPurchaseResult,
} from "./useShop";
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
const REF_B = "223e4567-e89b-42d3-a456-426614174000";

function response(
  pending: Pick<PackPurchaseIntent, "ref" | "payment"> = intent(),
  gold = 0,
): PackPurchaseResult {
  return {
    opening: { ref: pending.ref, payment: pending.payment },
    shop: { gold },
    replayed: false,
  } as PackPurchaseResult;
}

const RESPONSE = response();

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
        return response(pending);
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

  it("does not clear a newer intent when an older request returns a late HTTP error", async () => {
    const storage = new MemoryStorage();
    let rejectA!: (error: Error) => void;
    const requestA = new Promise<PackPurchaseResult>((_resolve, reject) => {
      rejectA = reject;
    });
    const purchaseA = startPackPurchase(storage, "gold", REF, () => requestA);
    const pendingB = intent({ ref: REF_B, payment: "ticket" });
    savePackPurchaseIntent(storage, pendingB);

    rejectA(new ApiError(400, "old failure"));
    await expect(purchaseA).resolves.toEqual({ kind: "stale" });
    expect(loadPackPurchaseIntent(storage)).toEqual(pendingB);
  });

  it("ignores late A after remount settlement and preserves newer B intent/cache", async () => {
    const storage = new MemoryStorage();
    const queryClient = new QueryClient();
    const publish = (purchase: PackPurchaseResult) =>
      applyPackPurchaseSnapshot(queryClient, purchase);
    let settleOriginalA!: (purchase: PackPurchaseResult) => void;
    const originalAResponse = new Promise<PackPurchaseResult>((resolve) => {
      settleOriginalA = resolve;
    });

    // Component A starts a request, then unmounts while that request remains pending.
    const originalA = startPackPurchase(
      storage,
      "gold",
      REF,
      () => originalAResponse,
      publish,
    );
    const pendingA = loadPackPurchaseIntent(storage)!;

    // A remounted panel reconciles the same identity before starting purchase B.
    const resumedAResponse = response(pendingA, 80);
    await expect(
      retryPackPurchase(storage, pendingA, async () => resumedAResponse, publish),
    ).resolves.toMatchObject({ kind: "success" });
    expect(queryClient.getQueryData(["shop"])).toBe(resumedAResponse.shop);

    let rejectFirstB!: (error: Error) => void;
    const firstBResponse = new Promise<PackPurchaseResult>((_resolve, reject) => {
      rejectFirstB = reject;
    });
    const pendingB = intent({ ref: REF_B, payment: "ticket" });
    const requestB = vi
      .fn()
      .mockImplementationOnce(() => firstBResponse)
      .mockRejectedValueOnce(new PackTransportError());
    const purchaseB = startPackPurchase(storage, pendingB.payment, pendingB.ref, requestB, publish);
    expect(loadPackPurchaseIntent(storage)).toEqual(pendingB);

    // The original component's late response is stale: it cannot clear B or overwrite the cache.
    settleOriginalA(response(pendingA, 999));
    await expect(originalA).resolves.toEqual({ kind: "stale" });
    expect(loadPackPurchaseIntent(storage)).toEqual(pendingB);
    expect(queryClient.getQueryData(["shop"])).toBe(resumedAResponse.shop);

    // B still owns recovery and retains the existing one-automatic-retry contract.
    rejectFirstB(new PackTransportError());
    await expect(purchaseB).resolves.toMatchObject({
      kind: "unresolved",
      intent: { ...pendingB, automaticRetryConsumed: true },
    });
    expect(requestB).toHaveBeenCalledTimes(2);
    expect(loadPackPurchaseIntent(storage)).toEqual({
      ...pendingB,
      automaticRetryConsumed: true,
    });
  });
});
