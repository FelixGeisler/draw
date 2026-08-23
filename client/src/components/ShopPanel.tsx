import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  applyPackPurchaseSnapshot,
  PACK_BONUS_LABELS,
  PackResponseError,
  PackTransportError,
  type PackPayment,
  type PackPurchaseResult,
  useBuyPack,
  useEquipBack,
  useShop,
} from "../hooks/useShop";
import {
  loadPackPurchaseIntent,
  PackPurchaseStorageError,
  retryPackPurchase,
  startPackPurchase,
  type PackPurchaseAttempt,
  type PackPurchaseIntent,
} from "../hooks/shopPurchaseIntent";
import "./ShopPanel.css";

type PendingAction = "resume" | "retry" | null;

function initialIntent(): { intent: PackPurchaseIntent | null; error: string | null } {
  try {
    return { intent: loadPackPurchaseIntent(window.sessionStorage), error: null };
  } catch (error) {
    return {
      intent: null,
      error: error instanceof Error ? error.message : "Purchase recovery storage is unavailable.",
    };
  }
}

function unresolvedMessage(error: Error): string {
  if (error instanceof PackTransportError) {
    return "The purchase response was not received. Retry with the same saved purchase.";
  }
  if (error instanceof PackResponseError) {
    return "The purchase response could not be verified. Retry with the same saved purchase.";
  }
  return error.message;
}

/** Authoritative Gold shop controls and settings-owned card-back collection (#267). */
export function ShopPanel() {
  const shop = useShop();
  const equip = useEquipBack();
  const buy = useBuyPack();
  const queryClient = useQueryClient();
  const [recovery] = useState(initialIntent);
  const [intent, setIntent] = useState<PackPurchaseIntent | null>(recovery.intent);
  const [pendingAction, setPendingAction] = useState<PendingAction>(
    recovery.intent ? "resume" : null,
  );
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const purchaseLock = useRef(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(recovery.error);
  const [result, setResult] = useState<PackPurchaseResult | null>(null);

  if (!shop.data) return null;
  const state = shop.data;

  const request = (pending: PackPurchaseIntent) =>
    buy.mutateAsync({ payment: pending.payment, ref: pending.ref });
  const publish = (response: PackPurchaseResult) =>
    applyPackPurchaseSnapshot(queryClient, response);

  function applyAttempt(attempt: PackPurchaseAttempt) {
    if (attempt.kind === "stale") return;
    if (attempt.kind === "success") {
      setIntent(null);
      setPendingAction(null);
      setPurchaseError(null);
      setResult(attempt.response);
      return;
    }
    if (attempt.kind === "definitive-error") {
      setIntent(null);
      setPendingAction(null);
      setPurchaseError(attempt.error.message);
      return;
    }
    setIntent(attempt.intent);
    setPendingAction("retry");
    setPurchaseError(unresolvedMessage(attempt.error));
  }

  async function openPack(payment: PackPayment) {
    if (purchaseLock.current || purchaseBusy || intent) return;
    purchaseLock.current = true;
    setPurchaseBusy(true);
    setPurchaseError(null);
    try {
      applyAttempt(
        await startPackPurchase(
          window.sessionStorage,
          payment,
          window.crypto.randomUUID(),
          request,
          publish,
        ),
      );
    } catch (error) {
      if (error instanceof PackPurchaseStorageError) {
        let saved: PackPurchaseIntent | null = null;
        try {
          saved = loadPackPurchaseIntent(window.sessionStorage);
        } catch {
          // The actionable storage message below is the only safe recovery state.
        }
        setIntent(saved);
        setPendingAction(saved ? "retry" : null);
        setPurchaseError(error.message);
      } else {
        setPurchaseError(error instanceof Error ? error.message : "The purchase failed.");
      }
    } finally {
      purchaseLock.current = false;
      setPurchaseBusy(false);
    }
  }

  async function continuePurchase() {
    if (purchaseLock.current || purchaseBusy || !intent) return;
    purchaseLock.current = true;
    setPurchaseBusy(true);
    setPurchaseError(null);
    try {
      applyAttempt(await retryPackPurchase(window.sessionStorage, intent, request, publish));
    } catch (error) {
      setPurchaseError(
        error instanceof Error ? error.message : "The saved purchase could not be reconciled.",
      );
    } finally {
      purchaseLock.current = false;
      setPurchaseBusy(false);
    }
  }

  const purchasesBlocked = purchaseBusy || intent !== null;

  return (
    <section className="shop-panel" data-testid="shop">
      <h3>Shop</h3>
      <div className="shop-state" aria-label="Current shop balances">
        <span>{state.gold} Gold</span>
        <span>{state.goldenTickets} Golden Tickets</span>
        <span>
          Freeze bank {state.freezesBanked}/{state.freezeBankCap}
        </span>
        <span>Secret chance {state.nextSecretChanceBps / 100}%</span>
      </div>

      <div className="shop-pack-controls">
        <button
          type="button"
          disabled={purchasesBlocked || state.gold < state.packCost}
          onClick={() => void openPack("gold")}
        >
          Open pack — {state.packCost} Gold
        </button>
        {state.goldenTickets > 0 && (
          <button
            type="button"
            disabled={purchasesBlocked}
            onClick={() => void openPack("ticket")}
          >
            Open pack — Golden Ticket
          </button>
        )}
        {intent && pendingAction && (
          <button type="button" disabled={purchaseBusy} onClick={() => void continuePurchase()}>
            {pendingAction === "resume" ? "Resume purchase" : "Retry purchase"} — {intent.payment}
          </button>
        )}
      </div>

      {purchaseError && <p className="shop-error" role="alert">{purchaseError}</p>}
      {equip.error && <p className="shop-error" role="alert">{equip.error.message}</p>}

      {result && (
        <p className="shop-result" role="status" aria-live="polite">
          <strong>{result.opening.back.name}</strong> · {result.opening.back.rarity} ·{" "}
          {result.opening.duplicate ? "Duplicate" : "New background"} · Duplicate refund:{" "}
          {result.opening.duplicateRefundGold} Gold · {PACK_BONUS_LABELS[result.opening.bonus]}
        </p>
      )}

      <div className="shop-backs">
        {state.backs.map((back) => (
          <button
            type="button"
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
