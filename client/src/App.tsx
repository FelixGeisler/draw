import { NavLink, Route, Routes } from "react-router-dom";
import { CapturePage } from "./pages/CapturePage";
import { DrawPage } from "./pages/DrawPage";
import { TasksPage } from "./pages/TasksPage";
import { StatsPage } from "./pages/StatsPage";
import { GoalsPage } from "./pages/GoalsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TimerBar } from "./components/TimerBar";
import { GamificationHeader } from "./components/GamificationHeader";
import { AchievementToast } from "./components/AchievementToast";

function Placeholder({ title }: { title: string }) {
  return (
    <div className="content">
      <h1>{title}</h1>
      <p style={{ color: "var(--text-dim)" }}>Coming soon.</p>
    </div>
  );
}

const NAV = [
  { to: "/", label: "Draw" },
  { to: "/capture", label: "Capture" },
  { to: "/tasks", label: "Tasks" },
  { to: "/goals", label: "Goals" },
  { to: "/stats", label: "Stats" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  return (
    <div className="layout">
      <nav className="sidenav">
        <div className="brand">🃏 Draw</div>
        {NAV.map((item) => (
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
          <Route path="/capture" element={<CapturePage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </div>
  );
}
