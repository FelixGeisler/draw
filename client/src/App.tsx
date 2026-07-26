import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { DrawPage } from "./pages/DrawPage";
import { TasksPage } from "./pages/TasksPage";
import { StatsPage } from "./pages/StatsPage";
import { GoalsPage } from "./pages/GoalsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AssistantPage } from "./pages/AssistantPage";
import { TimerBar } from "./components/TimerBar";
import { GamificationHeader } from "./components/GamificationHeader";
import { AchievementToast } from "./components/AchievementToast";
import { useAiStatus } from "./hooks/useAi";

// Each entry wears a leading emoji in the app's existing icon idiom (the brand
// 🃏, the AI ✨, the goal filter's 🎯): 🎯 already means "a goal" on the Draw
// page's filter, and 📊/⚙️ are the conventional stats/settings glyphs. The icon
// sits in a fixed-width slot (.nav-ico) so the labels line up regardless of the
// glyph's natural width.
const NAV = [
  { to: "/", label: "Draw", icon: "🎴" },
  { to: "/tasks", label: "Tasks", icon: "📋" },
  { to: "/goals", label: "Goals", icon: "🎯" },
  { to: "/stats", label: "Stats", icon: "📊" },
  { to: "/settings", label: "Settings", icon: "⚙️" },
];

// The Assistant (#31) is an AI surface: its nav entry exists only while a key
// is configured (degraded mode hides the feature, like every AI affordance).
// The ROUTE stays registered either way — a direct visit in degraded mode
// gets the page's own Settings hint instead of a dead link.
const ASSISTANT = { to: "/assistant", label: "Assistant", icon: "✨" };

export default function App() {
  const aiStatus = useAiStatus();
  const nav = aiStatus.data?.configured ? [...NAV.slice(0, 3), ASSISTANT, ...NAV.slice(3)] : NAV;
  return (
    <div className="layout">
      <nav className="sidenav">
        <div className="brand">🃏 Draw</div>
        {nav.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}>
            <span className="nav-ico" aria-hidden="true">
              {item.icon}
            </span>
            {/* The label is its own element so the phone tab bar can ellipsis it
                (#193): a bare text node is an anonymous flex item and cannot be
                styled, and glyph widths differ per platform, so an unclippable
                label can widen the whole document. */}
            <span className="nav-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="main">
        <GamificationHeader />
        <TimerBar />
        <AchievementToast />
        <Routes>
          <Route path="/" element={<DrawPage />} />
          {/* Capture merged into Tasks (#151, ADR-40) — the route survives as
              a redirect for muscle memory and old links. */}
          <Route path="/capture" element={<Navigate to="/tasks" replace />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="/stats" element={<StatsPage />} />
          {/* History merged into Stats (#155, ADR-41) — the route survives as
              a redirect for muscle memory and old links. */}
          <Route path="/history" element={<Navigate to="/stats" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </div>
  );
}
