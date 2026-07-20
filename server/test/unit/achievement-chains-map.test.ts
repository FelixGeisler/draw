import { describe, expect, it } from "vitest";
import { CHAIN_SPECS } from "../../src/services/gamificationService.js";
import { ACHIEVEMENT_CHAINS } from "../../../shared/achievementChains.js";

// The chain-map drift guard (#183), the third of the achievement anti-drift
// mirrors (shared/achievementKeys -> gamification.test.ts "ships exactly the
// shared key set"; shared/achievementTiers -> achievementRarity.test.ts). The
// client cannot import gamificationService (it pulls in db/better-sqlite3), so
// shared/achievementChains.ts is a hand-kept PROJECTION of CHAIN_SPECS. This
// pins that projection exactly: chainId = metric, order = target.
describe("shared achievement chain map <-> CHAIN_SPECS", () => {
  const derived = Object.fromEntries(
    Object.entries(CHAIN_SPECS).map(([key, spec]) => [
      key,
      { chainId: spec.metric, order: spec.target },
    ]),
  );

  it("mirrors CHAIN_SPECS exactly (chainId = metric, order = target)", () => {
    // A chain level added to CHAIN_SPECS but not mirrored here (or a stale entry
    // left behind) fails this — the same treatment as the key/tier drift guards.
    expect(ACHIEVEMENT_CHAINS).toEqual(derived);
  });

  it("covers exactly the chained keys — no chained key missing, none extra", () => {
    expect(Object.keys(ACHIEVEMENT_CHAINS).sort()).toEqual(Object.keys(CHAIN_SPECS).sort());
  });

  it("orders ascend within every chain, so sorting by order is tier order", () => {
    const byChain = new Map<string, number[]>();
    for (const { chainId, order } of Object.values(ACHIEVEMENT_CHAINS)) {
      (byChain.get(chainId) ?? byChain.set(chainId, []).get(chainId)!).push(order);
    }
    for (const [chainId, orders] of byChain) {
      const ascending = [...orders].sort((a, b) => a - b);
      expect(orders, chainId).toEqual(ascending);
      // Strictly ascending: no two tiers of a chain share a threshold.
      expect(new Set(orders).size, chainId).toBe(orders.length);
    }
  });
});
