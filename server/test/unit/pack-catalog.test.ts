import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as packCatalog from "../../src/services/packCatalog.js";
import {
  CARD_BACKS,
  duplicateRefundGold,
  duplicateRefundGoldForBack,
  nextSecretChanceBps,
  selectEffectivePackBonus,
  selectPackBack,
  selectPackRarity,
  type BackRarity,
} from "../../src/services/packCatalog.js";

const EXACT_CATALOG = [
  ["classic", "Classic weave", "common"],
  ["ember", "Ember lattice", "common"],
  ["tide", "Tide glass", "common"],
  ["midnight", "Midnight stars", "common"],
  ["parchment", "Aged parchment", "common"],
  ["graphite", "Graphite weave", "common"],
  ["meadow", "Meadow braid", "rare"],
  ["royal", "Royal filigree", "rare"],
  ["sakura", "Sakura glass", "rare"],
  ["circuit", "Neon circuit", "rare"],
  ["frost", "Frost lattice", "rare"],
  ["aurum", "Aurum crest", "ultra-rare"],
  ["aurora", "Aurora silk", "ultra-rare"],
  ["obsidian", "Obsidian gold", "ultra-rare"],
  ["prism", "Prism foil", "secret-rare"],
] as const;
const RARITIES: BackRarity[] = ["common", "rare", "ultra-rare", "secret-rare"];
const LARGEST_SAMPLE = 1 - Number.EPSILON / 2;

function nextDown(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) - 1n);
  return view.getFloat64(0);
}

describe("approved card-back catalog", () => {
  it("pins the exact unique 15-entry registry and all seven shipped records", () => {
    expect(CARD_BACKS.map(({ key, name, rarity }) => [key, name, rarity])).toEqual(EXACT_CATALOG);
    expect(new Set(CARD_BACKS.map(({ key }) => key)).size).toBe(15);

    const shipped = ["classic", "ember", "tide", "meadow", "royal", "aurum", "prism"];
    expect(CARD_BACKS.filter(({ key }) => shipped.includes(key))).toEqual([
      { key: "classic", name: "Classic weave", rarity: "common" },
      { key: "ember", name: "Ember lattice", rarity: "common" },
      { key: "tide", name: "Tide glass", rarity: "common" },
      { key: "meadow", name: "Meadow braid", rarity: "rare" },
      { key: "royal", name: "Royal filigree", rarity: "rare" },
      { key: "aurum", name: "Aurum crest", rarity: "ultra-rare" },
      { key: "prism", name: "Prism foil", rarity: "secret-rare" },
    ]);
  });

  it("has exactly 5/5/3/1 pullable entries and never pulls Classic", () => {
    const reachable = new Set<string>();
    const expectedCounts = { common: 5, rare: 5, "ultra-rare": 3, "secret-rare": 1 };
    for (const rarity of RARITIES) {
      const expected = CARD_BACKS.filter(
        (back) => back.rarity === rarity && back.key !== "classic",
      );
      expect(expected).toHaveLength(expectedCounts[rarity]);
      for (let index = 0; index < expected.length; index += 1) {
        reachable.add(selectPackBack(rarity, index / expected.length).key);
      }
    }
    expect(reachable).toEqual(new Set(CARD_BACKS.slice(1).map(({ key }) => key)));
    expect(reachable.has("classic")).toBe(false);
    expect(() => duplicateRefundGoldForBack("classic")).toThrow();
  });
});

describe("next Secret chance", () => {
  it("returns every exact step from empty history through the cap", () => {
    for (let misses = 0; misses <= 20; misses += 1) {
      expect(nextSecretChanceBps(Array.from({ length: misses }, () => ({ rarity: "common" })))).toBe(
        500 + 50 * misses,
      );
    }
    expect(nextSecretChanceBps(Array.from({ length: 200 }, () => ({ rarity: "rare" })))).toBe(
      1500,
    );
  });

  it("uses oldest-to-newest trailing misses, including duplicates, and resets on any Secret", () => {
    expect(nextSecretChanceBps([{ rarity: "secret-rare", duplicate: false }])).toBe(500);
    expect(nextSecretChanceBps([{ rarity: "secret-rare", duplicate: true }])).toBe(500);
    expect(nextSecretChanceBps([{ rarity: "common", duplicate: true }])).toBe(550);
    expect(
      nextSecretChanceBps([
        { rarity: "common" },
        { rarity: "rare" },
        { rarity: "secret-rare", duplicate: true },
        { rarity: "ultra-rare" },
        { rarity: "common", duplicate: true },
      ]),
    ).toBe(600);
    expect(nextSecretChanceBps([{ rarity: "secret-rare" }, { rarity: "common" }])).toBe(550);
    expect(nextSecretChanceBps([{ rarity: "common" }, { rarity: "secret-rare" }])).toBe(500);
  });

  it.each([undefined, null, {}, [], { rarity: undefined }, { rarity: "unknown" }])(
    "rejects malformed outcome %#",
    (outcome) => {
      expect(() => nextSecretChanceBps([outcome] as never)).toThrow();
    },
  );

  it("rejects a non-array history", () => {
    expect(() => nextSecretChanceBps(null as never)).toThrow();
  });
});

describe("rarity selection", () => {
  it("pins every half-open threshold at every allowed Secret chance", () => {
    for (let chance = 500; chance <= 1500; chance += 50) {
      const secret = chance / 10_000;
      const common = secret + ((1 - secret) * 45) / 95;
      const rare = secret + ((1 - secret) * 77) / 95;

      expect(selectPackRarity(chance, 0)).toBe("secret-rare");
      expect(selectPackRarity(chance, nextDown(secret))).toBe("secret-rare");
      expect(selectPackRarity(chance, secret)).toBe("common");
      expect(selectPackRarity(chance, nextDown(common))).toBe("common");
      expect(selectPackRarity(chance, common)).toBe("rare");
      expect(selectPackRarity(chance, nextDown(rare))).toBe("rare");
      expect(selectPackRarity(chance, rare)).toBe("ultra-rare");
      expect(selectPackRarity(chance, LARGEST_SAMPLE)).toBe("ultra-rare");
    }
  });

  it.each([499, 501, 525, 1501, 500.5, Number.NaN, Infinity, -Infinity])(
    "rejects invalid Secret chance %s",
    (chance) => expect(() => selectPackRarity(chance, 0)).toThrow(),
  );

  it.each([Number.NaN, Infinity, -Infinity, -Number.EPSILON, 1])(
    "rejects invalid rarity sample %s",
    (sample) => expect(() => selectPackRarity(500, sample)).toThrow(),
  );
});

describe("within-tier item selection", () => {
  it("uses equal-width half-open intervals in registry order for every tier", () => {
    for (const rarity of RARITIES) {
      const pool = CARD_BACKS.filter(
        (back) => back.rarity === rarity && back.key !== "classic",
      );
      expect(selectPackBack(rarity, 0)).toEqual(pool[0]);
      for (let k = 1; k < pool.length; k += 1) {
        const boundary = k / pool.length;
        expect(selectPackBack(rarity, nextDown(boundary))).toEqual(pool[k - 1]);
        expect(selectPackBack(rarity, boundary)).toEqual(pool[k]);
      }
      expect(selectPackBack(rarity, LARGEST_SAMPLE)).toEqual(pool.at(-1));
    }
  });

  it("keeps rarity and item samples as two explicit, independent calls", () => {
    expect(selectPackRarity).toHaveLength(2);
    expect(selectPackBack).toHaveLength(2);
    const rarity = selectPackRarity(500, 0.2);
    expect(rarity).toBe("common");
    expect(selectPackBack(rarity, 0.8).key).toBe("graphite");
  });

  it("rejects unknown tiers and invalid samples", () => {
    expect(() => selectPackBack("unknown" as never, 0)).toThrow();
    for (const sample of [Number.NaN, Infinity, -Infinity, -Number.EPSILON, 1]) {
      expect(() => selectPackBack("common", sample)).toThrow();
    }
  });
});

describe("duplicate refunds", () => {
  it("returns exact rarity and back-aware Gold values without changing catalog state", () => {
    const before = structuredClone(CARD_BACKS);
    expect(RARITIES.map(duplicateRefundGold)).toEqual([10, 20, 40, 100]);
    for (const back of CARD_BACKS.slice(1)) {
      expect(duplicateRefundGoldForBack(back.key)).toBe(duplicateRefundGold(back.rarity));
    }
    expect(CARD_BACKS).toEqual(before);
  });

  it("rejects Classic, unknown backs, unknown rarity, and non-string keys", () => {
    expect(() => duplicateRefundGoldForBack("classic")).toThrow();
    expect(() => duplicateRefundGoldForBack("unknown")).toThrow();
    expect(() => duplicateRefundGold("unknown" as never)).toThrow();
    expect(() => duplicateRefundGoldForBack(1 as never)).toThrow();
  });
});

describe("effective bonus selection", () => {
  const boundaries = [0.05, 0.1, 0.12] as const;

  it("pins every boundary and resolves a full-bank Freeze to Pouch", () => {
    for (const bank of [0, 1]) {
      expect(selectEffectivePackBonus(0, bank)).toBe("freeze");
      expect(selectEffectivePackBonus(nextDown(boundaries[0]), bank)).toBe("freeze");
    }
    expect(selectEffectivePackBonus(0, 2)).toBe("pouch");
    expect(selectEffectivePackBonus(nextDown(boundaries[0]), 2)).toBe("pouch");

    for (const bank of [0, 1, 2]) {
      expect(selectEffectivePackBonus(0.05, bank)).toBe("pouch");
      expect(selectEffectivePackBonus(nextDown(0.1), bank)).toBe("pouch");
      expect(selectEffectivePackBonus(0.1, bank)).toBe("ticket");
      expect(selectEffectivePackBonus(nextDown(0.12), bank)).toBe("ticket");
      expect(selectEffectivePackBonus(0.12, bank)).toBe("none");
      expect(selectEffectivePackBonus(LARGEST_SAMPLE, bank)).toBe("none");
    }
  });

  it.each([Number.NaN, Infinity, -Infinity, -Number.EPSILON, 1])(
    "rejects invalid bonus sample %s",
    (sample) => expect(() => selectEffectivePackBonus(sample, 0)).toThrow(),
  );

  it.each([-1, 0.5, 3, Number.NaN, Infinity])("rejects invalid Freeze bank %s", (bank) => {
    expect(() => selectEffectivePackBonus(0, bank)).toThrow();
  });
});

describe("pure service boundary", () => {
  it("has no RNG/default, request, database, ledger, write, or clock dependency", () => {
    const source = readFileSync(new URL("../../src/services/packCatalog.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/Math\.random|crypto|request|seed|override/i);
    expect(source).not.toMatch(/\.\.\/db|database|sqlite|ledger|pack_openings|setSetting/i);
    expect(source).not.toMatch(/\bDate\.|new Date|performance\.|\bclock\b/i);
  });

  it("does not consume ambient randomness or time and exports only effective bonus selection", () => {
    const random = vi.spyOn(Math, "random");
    const now = vi.spyOn(Date, "now");
    nextSecretChanceBps([{ rarity: "common" }]);
    const rarity = selectPackRarity(500, 0.2);
    selectPackBack(rarity, 0.2);
    duplicateRefundGoldForBack("ember");
    selectEffectivePackBonus(0.01, 2);
    expect(random).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(Object.keys(packCatalog).filter((key) => /bonus/i.test(key))).toEqual([
      "selectEffectivePackBonus",
    ]);
  });
});
