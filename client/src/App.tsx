import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { DrawPage } from "./pages/DrawPage";
import { TasksPage } from "./pages/TasksPage";
import { StatsPage } from "./pages/StatsPage";
import { HistoryPage } from "./pages/HistoryPage";
import { GoalsPage } from "./pages/GoalsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AssistantPage } from "./pages/AssistantPage";
import { TimerBar } from "./components/TimerBar";
import { GamificationHeader } from "./components/GamificationHeader";
import { AchievementToast } from "./components/AchievementToast";
import { useAiStatus } from "./hooks/useAi";

const NAV = [
  { to: "/", label: "Draw" },
  { to: "/tasks", label: "Tasks" },
  { to: "/goals", label: "Goals" },
  { to: "/stats", label: "Stats" },
  { to: "/history", label: "History" },
  { to: "/settings", label: "Settings" },
];

// The Assistant (#31) is an AI surface: its nav entry exists only while a key
// is configured (degraded mode hides the feature, like every AI affordance).
// The ROUTE stays registered either way — a direct visit in degraded mode
// gets the page's own Settings hint instead of a dead link.
const ASSISTANT = { to: "/assistant", label: "✨ Assistant" };

export default function App() {
  const aiStatus = useAiStatus();
  const nav = aiStatus.data?.configured ? [...NAV.slice(0, 3), ASSISTANT, ...NAV.slice(3)] : NAV;
  return (
    <div className="layout">
      <nav className="sidenav">
        <div className="brand">🃏 Draw</div>
        {nav.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}>
            {item.label}
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
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </div>
  );
}
