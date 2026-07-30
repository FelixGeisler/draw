import { useState } from "react";
import { useBuyItem, useEquipBack, useShop, type PackPull } from "../hooks/useShop";
import { celebrate, prefersReducedMotion } from "../lib/celebrate";
import "./ShopPanel.css";

/**
 * The XP shop (#230, ADR-62): spend XP on a booster pack of card-back pulls
 * or a banked streak freeze. The pack OPENS — each pull deals face-down on
 * the #224 center stage and flips to its weave, one at a time; that reveal is
 * the whole reason packs exist. Reduced motion: pulls appear face-up, no
 * confetti (celebrate() self-gates), same dismissals.
 */
export function ShopPanel() {
  const shop = useShop();
  const buy = useBuyItem();
  const equip = useEquipBack();
  const [pulls, setPulls] = useState<PackPull[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!shop.data) return null;
  const s = shop.data;

  function buyItem(item: "pack" | "freeze") {
    setError(null);
    buy.mutate(
      { item, ref: crypto.randomUUID() },
      {
        onSuccess: (res) => {
          if (item === "pack" && res.pulls) setPulls(res.pulls);
        },
        onError: (e) => setError((e as Error).message),
      },
    );
  }

  return (
    <section style={{ marginTop: 24 }} data-testid="shop">
      <h3>
        Shop{" "}
        <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>— {s.xp} XP to spend</span>
      </h3>
      <div className="shop-items">
        <div className="panel shop-item">
          <strong>🎴 Booster pack</strong>
          <p>Two card-back pulls for the deck. Duplicates refund 75 XP.</p>
          <button
            disabled={buy.isPending || s.xp < s.packCost}
            onClick={() => buyItem("pack")}
            title={s.xp < s.packCost ? `Needs ${s.packCost} XP` : "Buy and open a pack"}
          >
            Open pack −{s.packCost} XP
          </button>
        </div>
        <div className="panel shop-item">
          <strong>🧊 Streak freeze</strong>
          <p>
            One banked token — a missed day gets covered automatically.{" "}
            {s.freezesBanked}/{s.freezeBankCap} banked.
          </p>
          <button
            disabled={buy.isPending || s.xp < s.freezeCost || s.freezesBanked >= s.freezeBankCap}
            onClick={() => buyItem("freeze")}
            title={
              s.freezesBanked >= s.freezeBankCap
                ? "Your freeze bank is full"
                : s.xp < s.freezeCost
                  ? `Needs ${s.freezeCost} XP`
                  : "Bank a freeze token"
            }
          >
            Buy freeze −{s.freezeCost} XP
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
          {error}
        </p>
      )}

      {/* Owned card backs, equippable in place. The swatch IS the weave — the
          same CSS the Draw page front face wears (data-back). */}
      <div className="shop-backs">
        {s.backs.map((b) => (
          <button
            key={b.key}
            className={`shop-back ${b.owned ? "" : "locked"} ${s.equipped === b.key ? "equipped" : ""}`}
            disabled={!b.owned || equip.isPending || s.equipped === b.key}
            onClick={() => equip.mutate(b.key)}
            title={b.owned ? `Equip ${b.name}` : `${b.name} — pull it from a pack`}
          >
            <span className="draw-face front shop-back-swatch" data-back={b.key === "classic" ? undefined : b.key} />
            <span className="shop-back-name">{b.name}</span>
            <span className={`shop-back-tier tier-${b.rarity}`}>
              {s.equipped === b.key ? "equipped" : b.owned ? b.rarity : "🔒 " + b.rarity}
            </span>
          </button>
        ))}
      </div>

      {pulls && <PackOpening pulls={pulls} onDone={() => setPulls(null)} />}
    </section>
  );
}

/** The pack opening — the #224 stage idiom, pulls flipping in sequence. */
function PackOpening({ pulls, onDone }: { pulls: PackPull[]; onDone: () => void }) {
  const reduce = prefersReducedMotion();
  const [revealed, setRevealed] = useState(reduce ? pulls.length : 0);

  function next() {
    if (revealed < pulls.length) {
      const n = revealed + 1;
      setRevealed(n);
      const pull = pulls[n - 1];
      if (!pull.duplicate) {
        celebrate({ particleCount: 60, spread: 80, startVelocity: 30, ticks: 130 });
      }
    } else {
      onDone();
    }
  }

  return (
    <div className="ach-stage lit shop-opening" onClick={next} role="status" data-testid="pack-opening">
      <div className="ach-stage-inner">
        <div className="ach-stage-heading">🎴 Booster pack</div>
        <div className="shop-pulls">
          {pulls.map((pull, i) => (
            <div key={i} className={`shop-pull ${i < revealed ? "revealed" : ""}`}>
              <div className="shop-pull-flip">
                <span className="ach-toast-face back" aria-hidden="true" />
                <span className="ach-toast-face front">
                  <span
                    className="draw-face front shop-back-swatch tall"
                    data-back={pull.back.key === "classic" ? undefined : pull.back.key}
                  />
                </span>
              </div>
              {i < revealed && (
                <div className="shop-pull-caption">
                  <strong>{pull.back.name}</strong>
                  <span className={`shop-back-tier tier-${pull.back.rarity}`}>{pull.back.rarity}</span>
                  {pull.duplicate && <span className="shop-pull-dup">duplicate · +{pull.refund} XP</span>}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="ach-stage-hint">
          {revealed < pulls.length ? "click to reveal" : "click to close"}
        </div>
      </div>
    </div>
  );
}
