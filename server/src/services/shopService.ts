import { db, getSettingString, setSetting } from "../db.js";
import { streakState, totalGold } from "./gamificationService.js";
import {
  CARD_BACKS,
  duplicateRefundGold,
  nextSecretChanceBps,
  selectEffectivePackBonus,
  selectPackBack,
  selectPackRarity,
  type BackRarity,
  type EffectivePackBonus,
} from "./packCatalog.js";
import { FREEZE_BANK_CAP } from "./streak.js";

export { CARD_BACKS } from "./packCatalog.js";
export type { BackRarity, CardBack } from "./packCatalog.js";

const OWNED_KEY = "owned_card_backs";
const EQUIPPED_KEY = "equipped_card_back";
export const PACK_COST = 100;

export type PackPayment = "gold" | "ticket";

export interface ShopSnapshot {
  gold: number;
  goldenTickets: number;
  packCost: 100;
  nextSecretChanceBps: number;
  freezesBanked: number;
  freezeBankCap: 2;
  backs: Array<{
    key: string;
    name: string;
    rarity: BackRarity;
    owned: boolean;
  }>;
  equipped: string;
}

export interface PackOpeningDto {
  openingOrder: number;
  ref: string;
  payment: PackPayment;
  back: {
    key: string;
    name: string;
    rarity: BackRarity;
  };
  duplicate: boolean;
  appliedSecretChanceBps: number;
  duplicateRefundGold: 0 | 10 | 20 | 40 | 100;
  bonus: EffectivePackBonus;
  bonusGold: 0 | 50;
  openedAt: string;
}

export interface PackPurchaseResult {
  opening: PackOpeningDto;
  shop: ShopSnapshot;
  replayed: boolean;
}

interface OpeningRow {
  openingOrder: number;
  ref: string;
  payment: PackPayment;
  backKey: string;
  rarity: BackRarity;
  duplicate: 0 | 1;
  secretChanceBp: number;
  effectiveBonus: EffectivePackBonus;
  openedAt: string;
}

const OPENING_COLUMNS = `opening_order AS openingOrder, ref, payment,
  back_key AS backKey, rarity, duplicate, secret_chance_bp AS secretChanceBp,
  effective_bonus AS effectiveBonus, opened_at AS openedAt`;

/**
 * Read compatibility for settings-owned cosmetics. Unknown entries remain
 * persisted but do not become API catalog entries; Classic is always the
 * safe display fallback.
 */
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
    // Malformed persisted data degrades to Classic without a read-side write.
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

function openingHistory(): { rarity: BackRarity }[] {
  return db
    .prepare("SELECT rarity FROM pack_openings ORDER BY opening_order")
    .all() as { rarity: BackRarity }[];
}

export function goldenTicketBalance(): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN effective_bonus = 'ticket' THEN 1 ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN payment = 'ticket' THEN 1 ELSE 0 END), 0) AS tickets
       FROM pack_openings`,
    )
    .get() as { tickets: number };
  return row.tickets;
}

export function shopSnapshot(): ShopSnapshot {
  const owned = new Set(ownedBacks());
  return {
    gold: totalGold(),
    goldenTickets: goldenTicketBalance(),
    packCost: PACK_COST,
    nextSecretChanceBps: nextSecretChanceBps(openingHistory()),
    freezesBanked: streakState().freezesBanked,
    freezeBankCap: FREEZE_BANK_CAP,
    backs: CARD_BACKS.map((back) => ({ ...back, owned: owned.has(back.key) })),
    equipped: equippedBack(),
  };
}

function openingDto(row: OpeningRow): PackOpeningDto {
  const back = CARD_BACKS.find((candidate) => candidate.key === row.backKey);
  if (!back) throw new Error(`pack opening references unknown card back: ${row.backKey}`);
  const refund = row.duplicate ? duplicateRefundGold(row.rarity) : 0;
  return {
    openingOrder: row.openingOrder,
    ref: row.ref,
    payment: row.payment,
    back: { key: row.backKey, name: back.name, rarity: row.rarity },
    duplicate: row.duplicate === 1,
    appliedSecretChanceBps: row.secretChanceBp,
    duplicateRefundGold: refund as 0 | 10 | 20 | 40 | 100,
    bonus: row.effectiveBonus,
    bonusGold: row.effectiveBonus === "pouch" ? 50 : 0,
    openedAt: row.openedAt,
  };
}

function openingByRef(ref: string): OpeningRow | undefined {
  return db
    .prepare(`SELECT ${OPENING_COLUMNS} FROM pack_openings WHERE ref = ?`)
    .get(ref) as OpeningRow | undefined;
}

/** Add one newly won back while preserving unknown strings in a valid array. */
function grantBack(key: string): void {
  const raw = getSettingString(OWNED_KEY);
  let entries: string[];
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    entries = Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? [...parsed]
      : ["classic"];
  } catch {
    entries = ["classic"];
  }
  if (!entries.includes("classic")) entries.unshift("classic");
  entries = entries.filter((entry, index) => entry !== key || entries.indexOf(entry) === index);
  if (!entries.includes(key)) entries.push(key);
  setSetting(OWNED_KEY, JSON.stringify(entries));
}

function insertGoldEffect(amount: number, reason: string, ref: string, openedAt: string): void {
  db.prepare(
    "INSERT INTO gold_ledger (amount, reason, ref, created_at) VALUES (?, ?, ?, ?)",
  ).run(amount, reason, ref, openedAt);
}

/**
 * Execute one idempotent opening against the current live DB handle. The
 * transaction is deliberately created per call because backup import replaces
 * and reopens that handle (ADR-26).
 */
export function buyPack(
  payment: PackPayment,
  ref: string,
  random: () => number,
): PackPurchaseResult {
  const transaction = db.transaction((): PackPurchaseResult => {
    const existing = openingByRef(ref);
    if (existing) {
      if (existing.payment !== payment) {
        throw new ShopError(409, "ref was already used with a different payment");
      }
      return { opening: openingDto(existing), shop: shopSnapshot(), replayed: true };
    }

    if (payment === "gold") {
      if (totalGold() < PACK_COST) throw new ShopError(400, "not enough Gold");
    } else if (goldenTicketBalance() < 1) {
      throw new ShopError(400, "no Golden Ticket available");
    }

    const appliedSecretChanceBps = nextSecretChanceBps(openingHistory());
    const freezesBanked = streakState().freezesBanked;
    const rarity = selectPackRarity(appliedSecretChanceBps, random());
    const back = selectPackBack(rarity, random());
    const bonus = selectEffectivePackBonus(random(), freezesBanked);
    const duplicate = ownedBacks().includes(back.key);
    const openedAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO pack_openings
       (ref, payment, back_key, rarity, duplicate, secret_chance_bp, effective_bonus, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ref, payment, back.key, rarity, duplicate ? 1 : 0, appliedSecretChanceBps, bonus, openedAt);

    if (!duplicate) grantBack(back.key);
    if (payment === "gold") insertGoldEffect(-PACK_COST, "buy:pack", ref, openedAt);
    if (duplicate) insertGoldEffect(duplicateRefundGold(rarity), "refund:duplicate", ref, openedAt);
    if (bonus === "pouch") insertGoldEffect(50, "bonus:pouch", ref, openedAt);

    const persisted = openingByRef(ref);
    if (!persisted) throw new Error("pack opening disappeared before commit");
    return { opening: openingDto(persisted), shop: shopSnapshot(), replayed: false };
  });
  return transaction.immediate();
}
