import { db, getSettingString, setSetting } from "../db.js";

/**
 * The XP shop (#230, ADR-62). XP finally buys something: a booster pack of
 * cosmetic card-back pulls, or a banked streak freeze. Every movement of XP
 * is an xp_ledger row (purchases negative, duplicate refunds positive) —
 * summed by totalXp(), never a counter (ADR-5). Spending can lower the level;
 * unlocked achievements never re-lock (the achievements table is append-only).
 *
 * Idempotency spine: the client sends a `ref` with each purchase and the
 * ledger's UNIQUE(reason, ref) makes retries harmless — the same double-click
 * safety the claim endpoint gets from the achievements primary key.
 */

export const PACK_COST = 250;
export const FREEZE_COST = 500;
export const PULLS_PER_PACK = 2;
export const DUPLICATE_REFUND = 75;

export type BackRarity = "common" | "rare" | "ultra-rare" | "secret-rare";

export interface CardBack {
  key: string;
  name: string;
  rarity: BackRarity;
}

/**
 * The pull pool. "classic" is the shipped weave — always owned, never pulled.
 * Keys are stable identifiers the client maps to CSS; adding designs is
 * append-only (owned sets reference keys).
 */
export const CARD_BACKS: CardBack[] = [
  { key: "classic", name: "Classic weave", rarity: "common" },
  { key: "ember", name: "Ember lattice", rarity: "common" },
  { key: "tide", name: "Tide glass", rarity: "common" },
  { key: "meadow", name: "Meadow braid", rarity: "rare" },
  { key: "royal", name: "Royal filigree", rarity: "rare" },
  { key: "aurum", name: "Aurum crest", rarity: "ultra-rare" },
  { key: "prism", name: "Prism foil", rarity: "secret-rare" },
];

/** Pull weights per rarity — the achievement ladder's spirit: commons carry
 *  the pack, the prism is a genuine event. */
const RARITY_WEIGHTS: Record<BackRarity, number> = {
  common: 45,
  rare: 32,
  "ultra-rare": 18,
  "secret-rare": 5,
};

const OWNED_KEY = "owned_card_backs";
const EQUIPPED_KEY = "equipped_card_back";

export function ownedBacks(): string[] {
  const raw = getSettingString(OWNED_KEY);
  if (!raw) return ["classic"];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const valid = parsed.filter(
        (k): k is string => typeof k === "string" && CARD_BACKS.some((b) => b.key === k),
      );
      return valid.includes("classic") ? valid : ["classic", ...valid];
    }
  } catch {
    // malformed — behave like the default
  }
  return ["classic"];
}

export function equippedBack(): string {
  const key = getSettingString(EQUIPPED_KEY);
  // Only an OWNED key renders; anything else degrades to the classic weave —
  // the same resolve-against-reality rule as the deck scope (#214).
  return key && ownedBacks().includes(key) ? key : "classic";
}

export function equipBack(key: string): void {
  if (!ownedBacks().includes(key)) {
    throw new ShopError(400, "you do not own that card back");
  }
  setSetting(EQUIPPED_KEY, key);
}

export class ShopError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function ledgerBalanceGuard(totalXp: () => number, cost: number) {
  const balance = totalXp();
  if (balance < cost) {
    throw new ShopError(400, `not enough XP — this costs ${cost}, you have ${balance}`);
  }
}

function spend(amount: number, reason: string, ref: string, now: Date): void {
  const r = db
    .prepare(
      "INSERT OR IGNORE INTO xp_ledger (amount, reason, ref, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(-amount, reason, ref, now.toISOString());
  // A replayed ref bought nothing new: the retry of an already-applied
  // purchase must not charge twice OR re-run the effects.
  if (r.changes === 0) throw new ShopError(409, "this purchase was already made");
}

export interface PackPull {
  back: CardBack;
  duplicate: boolean;
  refund: number;
}

/**
 * Buy and open a booster pack: charge, roll PULLS_PER_PACK backs by rarity
 * weight, add new ones to the owned set, refund duplicates. One transaction —
 * the charge and its pulls exist together or not at all. `rng` is injectable
 * so tests can pin exact outcomes; production rolls Math.random.
 */
export function buyPack(
  totalXp: () => number,
  ref: string,
  now: Date = new Date(),
  rng: () => number = Math.random,
): { pulls: PackPull[] } {
  ledgerBalanceGuard(totalXp, PACK_COST);
  spend(PACK_COST, "buy:pack", ref, now);

  const pool = CARD_BACKS.filter((b) => b.key !== "classic");
  const owned = new Set(ownedBacks());
  const pulls: PackPull[] = [];
  for (let slot = 0; slot < PULLS_PER_PACK; slot++) {
    const back = rollBack(pool, rng);
    const duplicate = owned.has(back.key);
    if (duplicate) {
      // The refund is its own ledger fact, ref-scoped per slot so a replay of
      // the (already-409ing) purchase could never double-pay it either.
      db.prepare(
        "INSERT OR IGNORE INTO xp_ledger (amount, reason, ref, created_at) VALUES (?, ?, ?, ?)",
      ).run(DUPLICATE_REFUND, "refund:duplicate", `${ref}:${slot}`, now.toISOString());
    } else {
      owned.add(back.key);
    }
    pulls.push({ back, duplicate, refund: duplicate ? DUPLICATE_REFUND : 0 });
  }
  setSetting(OWNED_KEY, JSON.stringify([...owned]));
  return { pulls };
}

function rollBack(pool: CardBack[], rng: () => number): CardBack {
  const weighted = pool.map((b) => ({ back: b, weight: RARITY_WEIGHTS[b.rarity] }));
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = rng() * total;
  for (const w of weighted) {
    roll -= w.weight;
    if (roll < 0) return w.back;
  }
  return weighted[weighted.length - 1].back;
}

/**
 * Buy a streak freeze: one banked token, the #58 semantics — capped at
 * FREEZE_BANK_CAP unconsumed, checked BEFORE the charge so a full bank never
 * costs anything.
 *
 * The PURCHASE ROW IS THE TOKEN: earnedFreezeDays() derives a shop token
 * from this ledger row's local day, so nothing touches streak_freezes.
 * Deliberate, twice over — the milestone table's UNIQUE(milestone_day) can
 * only hold one row per day, and writing a shop token there would ALSO make
 * shouldEarnFreeze see "today already earned" and silently swallow a real
 * organic milestone landing on the purchase day. One fact, one row (ADR-2).
 */
export function buyFreeze(
  totalXp: () => number,
  bankedFreezes: () => number,
  bankCap: number,
  ref: string,
  now: Date = new Date(),
): void {
  if (bankedFreezes() >= bankCap) {
    throw new ShopError(400, "your freeze bank is full");
  }
  ledgerBalanceGuard(totalXp, FREEZE_COST);
  spend(FREEZE_COST, "buy:freeze", ref, now);
}
