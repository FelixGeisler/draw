import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

/** The XP shop payload (#230, ADR-62) — balance, catalog, bank, equipment. */
export interface ShopState {
  xp: number;
  packCost: number;
  freezeCost: number;
  freezesBanked: number;
  freezeBankCap: number;
  backs: { key: string; name: string; rarity: string; owned: boolean }[];
  equipped: string;
}

export interface PackPull {
  back: { key: string; name: string; rarity: string };
  duplicate: boolean;
  refund: number;
}

export function useShop() {
  return useQuery({
    queryKey: ["shop"],
    queryFn: () => api.get<ShopState>("/api/shop"),
    staleTime: 30_000,
  });
}

function useInvalidateShop() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["shop"] });
    // Spending moves totalXp, which the header and the level chain read.
    qc.invalidateQueries({ queryKey: ["gamification"] });
  };
}

export function useBuyItem() {
  const invalidate = useInvalidateShop();
  return useMutation({
    // The ref is minted PER MUTATION CALL, not per retry: a network retry of
    // the same click reuses it, and the ledger's UNIQUE(reason, ref) turns
    // the replay into a 409 instead of a double charge.
    mutationFn: ({ item, ref }: { item: "pack" | "freeze"; ref: string }) =>
      api.post<ShopState & { pulls?: PackPull[] }>("/api/shop/buy", { item, ref }),
    onSuccess: invalidate,
  });
}

export function useEquipBack() {
  const invalidate = useInvalidateShop();
  return useMutation({
    mutationFn: (back: string) => api.post<ShopState>("/api/shop/equip", { back }),
    onSuccess: invalidate,
  });
}
