import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";

export type BackRarity = "common" | "rare" | "ultra-rare" | "secret-rare";
export type PackPayment = "gold" | "ticket";
export type EffectivePackBonus = "freeze" | "pouch" | "ticket" | "none";

export const PACK_BONUS_LABELS: Record<EffectivePackBonus, string> = {
  none: "No bonus",
  freeze: "Freeze +1",
  pouch: "Gold Pouch +50 Gold",
  ticket: "Golden Ticket +1",
};

/** Exact authoritative Gold shop payload (#266). */
export interface ShopState {
  gold: number;
  goldenTickets: number;
  packCost: number;
  nextSecretChanceBps: number;
  freezesBanked: number;
  freezeBankCap: number;
  backs: { key: string; name: string; rarity: BackRarity; owned: boolean }[];
  equipped: string;
}

export interface PackOpening {
  openingOrder: number;
  ref: string;
  payment: PackPayment;
  back: { key: string; name: string; rarity: BackRarity };
  duplicate: boolean;
  appliedSecretChanceBps: number;
  duplicateRefundGold: number;
  bonus: EffectivePackBonus;
  bonusGold: number;
  openedAt: string;
}

export interface PackPurchaseResult {
  opening: PackOpening;
  shop: ShopState;
  replayed: boolean;
}

export interface PackPurchaseRequest {
  item: "pack";
  payment: PackPayment;
  ref: string;
}

export class PackTransportError extends Error {
  constructor(options?: ErrorOptions) {
    super("The purchase response was not received.", options);
  }
}

export class PackResponseError extends Error {
  constructor(message = "The purchase response could not be verified.", options?: ErrorOptions) {
    super(message, options);
  }
}

const BACK_RARITIES = new Set<BackRarity>(["common", "rare", "ultra-rare", "secret-rare"]);
const BONUSES = new Set<EffectivePackBonus>(["freeze", "pouch", "ticket", "none"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBackRarity(value: unknown): value is BackRarity {
  return typeof value === "string" && BACK_RARITIES.has(value as BackRarity);
}

function isShopState(value: unknown): value is ShopState {
  if (!isRecord(value) || !Array.isArray(value.backs)) return false;
  return (
    isFiniteNumber(value.gold) &&
    isFiniteNumber(value.goldenTickets) &&
    isFiniteNumber(value.packCost) &&
    isFiniteNumber(value.nextSecretChanceBps) &&
    isFiniteNumber(value.freezesBanked) &&
    isFiniteNumber(value.freezeBankCap) &&
    typeof value.equipped === "string" &&
    value.backs.every(
      (back) =>
        isRecord(back) &&
        typeof back.key === "string" &&
        typeof back.name === "string" &&
        isBackRarity(back.rarity) &&
        typeof back.owned === "boolean",
    )
  );
}

function isPackPurchaseResult(value: unknown): value is PackPurchaseResult {
  if (!isRecord(value) || !isRecord(value.opening)) return false;
  const opening = value.opening;
  const back = opening.back;
  if (!isRecord(back)) return false;
  return (
    isFiniteNumber(opening.openingOrder) &&
    typeof opening.ref === "string" &&
    (opening.payment === "gold" || opening.payment === "ticket") &&
    typeof back.key === "string" &&
    typeof back.name === "string" &&
    isBackRarity(back.rarity) &&
    typeof opening.duplicate === "boolean" &&
    isFiniteNumber(opening.appliedSecretChanceBps) &&
    isFiniteNumber(opening.duplicateRefundGold) &&
    typeof opening.bonus === "string" &&
    BONUSES.has(opening.bonus as EffectivePackBonus) &&
    isFiniteNumber(opening.bonusGold) &&
    typeof opening.openedAt === "string" &&
    isShopState(value.shop) &&
    typeof value.replayed === "boolean"
  );
}

/** One HTTP attempt. Transport, HTTP, and successful-response failures stay distinguishable. */
export async function requestPackPurchase(body: PackPurchaseRequest): Promise<PackPurchaseResult> {
  let response: Response;
  try {
    response = await fetch("/api/shop/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new PackTransportError({ cause });
  }

  if (!response.ok) {
    let message = response.statusText;
    let errorBody: unknown;
    try {
      errorBody = await response.json();
      const serverMessage = isRecord(errorBody) ? errorBody.error : undefined;
      if (typeof serverMessage === "string") message = serverMessage;
    } catch {
      // The response status is still definitive even if its error body is not JSON.
    }
    throw new ApiError(response.status, message, errorBody);
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch (cause) {
    throw new PackResponseError("The server returned an unreadable purchase response.", { cause });
  }
  if (!isPackPurchaseResult(result)) throw new PackResponseError();
  if (result.opening.ref !== body.ref || result.opening.payment !== body.payment) {
    throw new PackResponseError("The purchase response did not match the requested purchase.");
  }
  return result;
}

export function useShop() {
  return useQuery({
    queryKey: ["shop"],
    queryFn: () => api.get<ShopState>("/api/shop"),
    staleTime: 30_000,
  });
}

export function useEquipBack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (back: string) => api.post<ShopState>("/api/shop/equip", { back }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shop"] }),
  });
}

export function applyPackPurchaseSnapshot(
  queryClient: QueryClient,
  response: PackPurchaseResult,
): void {
  queryClient.setQueryData(["shop"], response.shop);
  void queryClient.invalidateQueries({ queryKey: ["gamification"] });
}

export function useBuyPack() {
  return useMutation({
    mutationFn: ({ payment, ref }: { payment: PackPayment; ref: string }) =>
      requestPackPurchase({ item: "pack", payment, ref }),
  });
}
