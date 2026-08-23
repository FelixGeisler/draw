export type BackRarity = "common" | "rare" | "ultra-rare" | "secret-rare";
export type PullableBackRarity = BackRarity;
export type EffectivePackBonus = "freeze" | "pouch" | "ticket" | "none";

export interface CardBack {
  readonly key: string;
  readonly name: string;
  readonly rarity: BackRarity;
}

export interface PackOutcomeForSecretChance {
  readonly rarity: BackRarity;
  readonly duplicate?: boolean;
}

/**
 * Stable registry order is part of the pack contract. Classic is the
 * always-owned fallback, not a pullable common background.
 */
export const CARD_BACKS = [
  { key: "classic", name: "Classic weave", rarity: "common" },
  { key: "ember", name: "Ember lattice", rarity: "common" },
  { key: "tide", name: "Tide glass", rarity: "common" },
  { key: "midnight", name: "Midnight stars", rarity: "common" },
  { key: "parchment", name: "Aged parchment", rarity: "common" },
  { key: "graphite", name: "Graphite weave", rarity: "common" },
  { key: "meadow", name: "Meadow braid", rarity: "rare" },
  { key: "royal", name: "Royal filigree", rarity: "rare" },
  { key: "sakura", name: "Sakura glass", rarity: "rare" },
  { key: "circuit", name: "Neon circuit", rarity: "rare" },
  { key: "frost", name: "Frost lattice", rarity: "rare" },
  { key: "aurum", name: "Aurum crest", rarity: "ultra-rare" },
  { key: "aurora", name: "Aurora silk", rarity: "ultra-rare" },
  { key: "obsidian", name: "Obsidian gold", rarity: "ultra-rare" },
  { key: "prism", name: "Prism foil", rarity: "secret-rare" },
] as const satisfies readonly CardBack[];

const RARITIES = new Set<BackRarity>(["common", "rare", "ultra-rare", "secret-rare"]);
const PULLABLE_BACKS: Readonly<Record<PullableBackRarity, readonly CardBack[]>> = {
  common: CARD_BACKS.filter((back) => back.rarity === "common" && back.key !== "classic"),
  rare: CARD_BACKS.filter((back) => back.rarity === "rare"),
  "ultra-rare": CARD_BACKS.filter((back) => back.rarity === "ultra-rare"),
  "secret-rare": CARD_BACKS.filter((back) => back.rarity === "secret-rare"),
};
const DUPLICATE_REFUND_GOLD: Readonly<Record<PullableBackRarity, number>> = {
  common: 10,
  rare: 20,
  "ultra-rare": 40,
  "secret-rare": 100,
};

function isRarity(value: unknown): value is BackRarity {
  return typeof value === "string" && RARITIES.has(value as BackRarity);
}

function requireRarity(value: unknown): BackRarity {
  if (!isRarity(value)) throw new TypeError("unknown card-back rarity");
  return value;
}

function requireSample(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("sample must be a finite number in [0, 1)");
  }
  return value;
}

/** Uses outcomes exactly in the supplied oldest-to-newest order. */
export function nextSecretChanceBps(
  outcomes: readonly PackOutcomeForSecretChance[],
): number {
  if (!Array.isArray(outcomes)) throw new TypeError("outcomes must be an array");

  let trailingMisses = 0;
  for (const candidate of outcomes) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new TypeError("every outcome must identify a known rarity");
    }
    const rarity = requireRarity((candidate as { rarity?: unknown }).rarity);
    trailingMisses = rarity === "secret-rare" ? 0 : trailingMisses + 1;
  }
  return Math.min(500 + 50 * trailingMisses, 1500);
}

/** Selects only a rarity; callers must supply a separate sample for the item. */
export function selectPackRarity(secretChanceBps: number, sample: number): PullableBackRarity {
  if (
    !Number.isInteger(secretChanceBps) ||
    secretChanceBps < 500 ||
    secretChanceBps > 1500 ||
    secretChanceBps % 50 !== 0
  ) {
    throw new RangeError("Secret chance must be an allowed 50-basis-point step");
  }
  const r = requireSample(sample);
  const secretThreshold = secretChanceBps / 10_000;
  const commonThreshold = secretThreshold + ((1 - secretThreshold) * 45) / 95;
  const rareThreshold = secretThreshold + ((1 - secretThreshold) * 77) / 95;

  if (r < secretThreshold) return "secret-rare";
  if (r < commonThreshold) return "common";
  if (r < rareThreshold) return "rare";
  return "ultra-rare";
}

/** Selects uniformly within one fixed tier in registry order. */
export function selectPackBack(rarity: PullableBackRarity, sample: number): CardBack {
  const pool = PULLABLE_BACKS[requireRarity(rarity)];
  const u = requireSample(sample);
  return pool[Math.floor(u * pool.length)]!;
}

export function duplicateRefundGold(rarity: PullableBackRarity): number {
  return DUPLICATE_REFUND_GOLD[requireRarity(rarity)];
}

/** Refuses Classic and unknown keys instead of treating them as common pulls. */
export function duplicateRefundGoldForBack(backKey: string): number {
  if (typeof backKey !== "string") throw new TypeError("card-back key must be a string");
  const back = CARD_BACKS.find((candidate) => candidate.key === backKey);
  if (!back || back.key === "classic") throw new RangeError("card back is not pullable");
  return duplicateRefundGold(back.rarity);
}

/** Resolves the cap-two Freeze substitution before exposing the bonus. */
export function selectEffectivePackBonus(
  sample: number,
  freezesBanked: number,
): EffectivePackBonus {
  const b = requireSample(sample);
  if (!Number.isInteger(freezesBanked) || freezesBanked < 0 || freezesBanked > 2) {
    throw new RangeError("banked Freezes must be an integer from 0 through 2");
  }
  if (b < 0.05) return freezesBanked === 2 ? "pouch" : "freeze";
  if (b < 0.1) return "pouch";
  if (b < 0.12) return "ticket";
  return "none";
}
