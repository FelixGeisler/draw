import { useEquipBack, useShop } from "../hooks/useShop";
import "./ShopPanel.css";

/**
 * Transitional read-only Gold shop (#263): collection/equipment stays usable,
 * while pack and direct-freeze purchase controls remain absent until #266.
 */
export function ShopPanel() {
  const shop = useShop();
  const equip = useEquipBack();

  if (!shop.data) return null;
  const state = shop.data;

  return (
    <section style={{ marginTop: 24 }} data-testid="shop">
      <h3>
        Shop{" "}
        <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>
          — {state.gold} Gold · {state.freezesBanked}/{state.freezeBankCap} freezes banked
        </span>
      </h3>

      {/* Settings-owned collection, equippable in place. The swatch is the same
          weave used by the Draw page, preserving rendering compatibility. */}
      <div className="shop-backs">
        {state.backs.map((back) => (
          <button
            key={back.key}
            className={`shop-back ${back.owned ? "" : "locked"} ${state.equipped === back.key ? "equipped" : ""}`}
            disabled={!back.owned || equip.isPending || state.equipped === back.key}
            onClick={() => equip.mutate(back.key)}
            title={back.owned ? `Equip ${back.name}` : `${back.name} — not owned`}
          >
            <span
              className="draw-face front shop-back-swatch"
              data-back={back.key === "classic" ? undefined : back.key}
            />
            <span className="shop-back-name">{back.name}</span>
            <span className={`shop-back-tier tier-${back.rarity}`}>
              {state.equipped === back.key
                ? "equipped"
                : back.owned
                  ? back.rarity
                  : `🔒 ${back.rarity}`}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
