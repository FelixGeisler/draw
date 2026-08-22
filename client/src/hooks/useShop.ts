import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

export type BackRarity = "common" | "rare" | "ultra-rare" | "secret-rare";

/** Exact transitional Gold shop payload (#263). */
export interface ShopState {
  gold: number;
  freezesBanked: number;
  freezeBankCap: 2;
  backs: { key: string; name: string; rarity: BackRarity; owned: boolean }[];
  equipped: string;
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
