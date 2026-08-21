import { getSettingString, setSetting } from "../db.js";

/**
 * Transitional read-only collection (#263). Gold purchases and opening
 * production intentionally do not exist until #266; settings remain the
 * byte-compatible authority for ownership and equipment.
 */
export type BackRarity = "common" | "rare" | "ultra-rare" | "secret-rare";

export interface CardBack {
  key: string;
  name: string;
  rarity: BackRarity;
}

/** Stable keys already persisted by the legacy shop. Classic is always owned. */
export const CARD_BACKS: CardBack[] = [
  { key: "classic", name: "Classic weave", rarity: "common" },
  { key: "ember", name: "Ember lattice", rarity: "common" },
  { key: "tide", name: "Tide glass", rarity: "common" },
  { key: "meadow", name: "Meadow braid", rarity: "rare" },
  { key: "royal", name: "Royal filigree", rarity: "rare" },
  { key: "aurum", name: "Aurum crest", rarity: "ultra-rare" },
  { key: "prism", name: "Prism foil", rarity: "secret-rare" },
];

const OWNED_KEY = "owned_card_backs";
const EQUIPPED_KEY = "equipped_card_back";

export function ownedBacks(): string[] {
  const raw = getSettingString(OWNED_KEY);
  if (!raw) return ["classic"];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid = parsed.filter(
        (key): key is string =>
          typeof key === "string" && CARD_BACKS.some((back) => back.key === key),
      );
      return valid.includes("classic") ? valid : ["classic", ...valid];
    }
  } catch {
    // Malformed or unknown persisted data degrades to Classic without rewrite.
  }
  return ["classic"];
}

export function equippedBack(): string {
  const key = getSettingString(EQUIPPED_KEY);
  return key && ownedBacks().includes(key) ? key : "classic";
}

export class ShopError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function equipBack(key: string): void {
  if (!ownedBacks().includes(key)) {
    throw new ShopError(400, "you do not own that card back");
  }
  setSetting(EQUIPPED_KEY, key);
}
