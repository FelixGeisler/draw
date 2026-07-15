/**
 * Issue #30 validation simulation — deterministic, against the REAL weight
 * math in src/services/drawService.ts (no copy of the formula).
 *
 * Question: after a 40-sibling umbrella import (#28/#29 shape), how badly do
 * the import leaves crowd organic tasks out of the draw — and what does the
 * sqrt sibling damping (ADR-25) do about it?
 *
 * Deck fixtures are shared with test/unit/draw-weights.test.ts via
 * ./deckFixtures.ts. Monte Carlo parts use a seeded PRNG — every run prints
 * identical numbers.
 *
 * Run: npx tsx server/scripts/sim-issue30.ts
 */
import { poolWeights, siblingDamping, weight } from "../src/services/drawService.js";
import { IMPORT_PARENT_ID, importLeaves, organicDeck, SIM_NOW as NOW, type SimTask } from "./deckFixtures.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MIN = 60; // draw_cooldown_minutes default

// --- measurement helpers ----------------------------------------------------

/** Import share of the probability mass, using the PRE-damping raw weight(). */
function rawShare(pool: SimTask[], now: Date): number {
  const ws = pool.map((c) => weight(c, now, COOLDOWN_MIN, pool.length));
  const total = ws.reduce((a, b) => a + b, 0);
  return pool.reduce((a, c, i) => a + (c.organic ? 0 : ws[i]), 0) / total;
}

/** Import share under the shipped formula (weight × sibling damping). */
function dampedShare(pool: SimTask[], now: Date): number {
  const ws = poolWeights(pool, now, COOLDOWN_MIN);
  const total = ws.reduce((a, b) => a + b, 0);
  return pool.reduce((a, c, i) => a + (c.organic ? 0 : ws[i]), 0) / total;
}

/** Deterministic PRNG (mulberry32) so the Monte Carlo parts are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One weighted draw, replicating drawTask()'s selection loop. */
function drawOnce(pool: SimTask[], ws: number[], rand: () => number): SimTask {
  const total = ws.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  let picked = pool.length - 1;
  for (let i = 0; i < pool.length; i++) {
    r -= ws[i];
    if (r <= 0) {
      picked = i;
      break;
    }
  }
  return pool[picked];
}

/**
 * A user session: consecutive draws 5 minutes apart (draw → glance/skip →
 * draw again). lastDrawnAt is stamped like the real drawTask, so the ×0.15
 * cooldown shapes repeat draws exactly as in production.
 */
function session(
  poolTemplate: SimTask[],
  draws: number,
  runs: number,
  seed: number,
  damped: boolean,
): { meanDrawsToOrganic: number; meanOrganicSeen: number; pFirstKAllImport: number[] } {
  let sumFirst = 0;
  let sumOrganicSeen = 0;
  const allImportAtK = new Array<number>(draws).fill(0);
  const rand = mulberry32(seed);
  for (let run = 0; run < runs; run++) {
    const pool = poolTemplate.map((t) => ({ ...t }));
    let t = new Date(NOW.getTime());
    let firstOrganic = 0;
    const organicIds = new Set<number>();
    let allImportSoFar = true;
    for (let d = 1; d <= draws; d++) {
      const ws = damped
        ? poolWeights(pool, t, COOLDOWN_MIN)
        : pool.map((c) => weight(c, t, COOLDOWN_MIN, pool.length));
      const chosen = drawOnce(pool, ws, rand);
      chosen.lastDrawnAt = t.toISOString();
      if (chosen.organic) {
        if (firstOrganic === 0) firstOrganic = d;
        organicIds.add(chosen.id);
        allImportSoFar = false;
      }
      if (allImportSoFar) allImportAtK[d - 1]++;
      t = new Date(t.getTime() + 5 * 60_000);
    }
    // censored runs count as draws+1 (a lower bound keeps the mean honest)
    sumFirst += firstOrganic === 0 ? draws + 1 : firstOrganic;
    sumOrganicSeen += organicIds.size;
  }
  return {
    meanDrawsToOrganic: sumFirst / runs,
    meanOrganicSeen: sumOrganicSeen / runs,
    pFirstKAllImport: allImportAtK.map((n) => n / runs),
  };
}

const fmt = (x: number) => (100 * x).toFixed(1) + "%";

// --- scenarios ---------------------------------------------------------------

console.log(`=== #30 deck-flood simulation (real weight(), NOW=${NOW.toISOString()}) ===\n`);

const organic = organicDeck(NOW);

// A. Baseline: 40-leaf parallel import lands today
{
  const pool = [...organic, ...importLeaves(40, NOW)];
  console.log("[A] Organic 12 + import 40 (parallel, day 0) — PRE-change formula");
  const share = rawShare(pool, NOW);
  console.log(`    import share of probability mass: ${fmt(share)}  (analytic draws to 1st organic: ${(1 / (1 - share)).toFixed(2)})`);
  const mc = session(pool, 10, 20000, 30, false);
  console.log(`    Monte Carlo (20k sessions, 10 draws, 5 min apart, cooldown active):`);
  console.log(`      mean draws until first organic card: ${mc.meanDrawsToOrganic.toFixed(2)}`);
  console.log(`      distinct organic cards seen in 10 draws: ${mc.meanOrganicSeen.toFixed(2)} of ${organic.length}`);
  console.log(`      P(first 3 draws all import): ${fmt(mc.pFirstKAllImport[2])}   P(first 5 all import): ${fmt(mc.pFirstKAllImport[4])}`);

  // per-task starvation: a mid-weight organic card's chance to surface in 5 draws
  const ws = pool.map((c) => weight(c, NOW, COOLDOWN_MIN, pool.length));
  const total = ws.reduce((a, b) => a + b, 0);
  const guitar = pool.findIndex((c) => c.title === "Practice guitar");
  const before = organic.map((c) => weight(c, NOW, COOLDOWN_MIN, organic.length));
  const beforeTotal = before.reduce((a, b) => a + b, 0);
  const gBefore = 1 - Math.pow(1 - before[9] / beforeTotal, 5);
  const gAfter = 1 - Math.pow(1 - ws[guitar] / total, 5);
  console.log(`      'Practice guitar' P(surfaces within 5 draws): ${fmt(gBefore)} before import -> ${fmt(gAfter)} after`);
}

// B. Staleness drift: does time heal it? Same deck k days later, nothing
// completed. The organic deck's steady state: chores recur (their dues and
// completions roll forward), finished admin tasks are replaced by similar
// ones — so the organic deck is rebuilt relative to `later` (urgency and age
// mix held constant), while the import leaves keep their real createdAt and
// age from staleness 1.0 toward the ×2 cap.
{
  console.log("\n[B] Staleness drift (no completions, organic deck in steady state)");
  for (const d of [0, 3, 7, 14, 30]) {
    const later = new Date(NOW.getTime() + d * DAY_MS);
    const pool = [...organicDeck(later), ...importLeaves(40, NOW)];
    console.log(`    day ${String(d).padStart(2)}: import share pre-change ${fmt(rawShare(pool, later))} -> damped ${fmt(dampedShare(pool, later))}`);
  }
}

// C. Sequential escape hatch (#23): umbrella flipped to 'do in order' — only
// the first open sibling is pool-eligible. Damping counts siblings IN THE
// POOL, so the lone representative is deliberately NOT damped.
{
  const pool = [...organic, ...importLeaves(1, NOW)];
  console.log("\n[C] Same import, umbrella set to sequential (1 sibling in pool)");
  console.log(`    import share pre-change ${fmt(rawShare(pool, NOW))} -> damped ${fmt(dampedShare(pool, NOW))} (no self-damping: k counts pool presence)`);
}

// D. Sensitivity: deck composition
{
  console.log("\n[D] Sensitivity (pre-change formula)");
  const noOverdue = organic.filter((t) => t.title !== "Take out recycling");
  console.log(`    no overdue chore that day (11 organic): import share ${fmt(rawShare([...noOverdue, ...importLeaves(40, NOW)], NOW))}`);
  const lean = organic.filter((_, i) => i % 2 === 0);
  console.log(`    lean organic deck (6 tasks):            import share ${fmt(rawShare([...lean, ...importLeaves(40, NOW)], NOW))}`);
  const twoImports = [...organic, ...importLeaves(40, NOW), ...importLeaves(25, NOW, 2000)];
  console.log(`    second parallel import (+25 leaves):    import share ${fmt(rawShare(twoImports, NOW))} -> damped ${fmt(dampedShare(twoImports, NOW))}`);
  const tenOrganic = organic.slice(0, 10);
  const issueSpecLeaves = importLeaves(40, NOW).map((t, i) => ({ ...t, effortMinutes: [15, 20, 25, 30][i % 4] }));
  console.log(`    issue Scope-0 spec (10 organic, 15-30 min leaves): import share ${fmt(rawShare([...tenOrganic, ...issueSpecLeaves], NOW))}`);
}

// E. The shipped mitigation: sqrt sibling damping (ADR-25), share as the
// import is worked through (k open siblings remaining in the pool).
{
  console.log("\n[E] sqrt sibling damping (each sibling × 1/sqrt(pool siblings))");
  for (const k of [40, 20, 10, 5, 2, 1]) {
    const pool = [...organic, ...importLeaves(k, NOW)];
    console.log(
      `    ${String(k).padStart(2)} pool siblings (damping x${siblingDamping(k).toFixed(3)}): pre-change ${fmt(rawShare(pool, NOW))} -> damped ${fmt(dampedShare(pool, NOW))}`,
    );
  }
  const pool = [...organic, ...importLeaves(40, NOW)];
  const mc = session(pool, 10, 20000, 31, true);
  console.log(`    Monte Carlo with damping (20k sessions, 10 draws):`);
  console.log(`      mean draws until first organic card: ${mc.meanDrawsToOrganic.toFixed(2)}`);
  console.log(`      distinct organic cards seen in 10 draws: ${mc.meanOrganicSeen.toFixed(2)} of ${organic.length}`);
  const ws = poolWeights(pool, NOW, COOLDOWN_MIN);
  const total = ws.reduce((a, b) => a + b, 0);
  const topLeaf = pool.findIndex((c) => c.id === IMPORT_PARENT_ID * 100 + 39); // impact-5, 20 min
  console.log(`      best import leaf still draws at ${fmt(ws[topLeaf] / total)} per draw — the exam stays present, not erased`);
}
