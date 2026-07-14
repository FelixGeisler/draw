import { useEffect, useState } from "react";
import { useGamification } from "../hooks/useGamification";

interface Toast {
  id: number;
  key: string;
}

let toastId = 1;

export function AchievementToast() {
  const { data } = useGamification();
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    function onUnlock(e: Event) {
      const keys = (e as CustomEvent<string[]>).detail;
      setToasts((ts) => [...ts, ...keys.map((key) => ({ id: toastId++, key }))]);
    }
    window.addEventListener("achievements-unlocked", onUnlock);
    return () => window.removeEventListener("achievements-unlocked", onUnlock);
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => setToasts((ts) => ts.slice(1)), 4000);
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        zIndex: 100,
      }}
    >
      {toasts.map((toast) => {
        const def = data?.achievements.find((a) => a.key === toast.key);
        return (
          <div
            key={toast.id}
            className="panel"
            style={{
              borderColor: "var(--warn)",
              boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
              minWidth: 260,
            }}
          >
            <div style={{ fontSize: 13, color: "var(--warn)", fontWeight: 600 }}>
              🏆 Achievement unlocked
            </div>
            <div style={{ fontSize: 16, marginTop: 4 }}>
              {def ? `${def.emoji} ${def.title}` : toast.key}
            </div>
            {def && <div style={{ color: "var(--text-dim)", fontSize: 13 }}>{def.description}</div>}
          </div>
        );
      })}
    </div>
  );
}
