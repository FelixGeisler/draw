import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { DrawPage } from "./pages/DrawPage";
import { TasksPage } from "./pages/TasksPage";
import { StatsPage } from "./pages/StatsPage";
import { GoalsPage } from "./pages/GoalsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AssistantPage } from "./pages/AssistantPage";
import { TimerBar } from "./components/TimerBar";
import { GamificationHeader } from "./components/GamificationHeader";
import { AchievementToast } from "./components/AchievementToast";
import { CommandPalette } from "./components/CommandPalette";
import { DeckScopeBar } from "./components/DeckScopeBar";
import { DeckScopeProvider } from "./DeckScopeContext";
import { useAiStatus } from "./hooks/useAi";
import {
  AssistantIcon,
  CardsIcon,
  ChartIcon,
  GearIcon,
  TargetIcon,
  TasksIcon,
} from "./components/icons";

// Each entry wears an icon from the app's single SVG set (#244, ADR-69) —
// emoji glyphs rendered per-platform with different shapes and widths, so
// the set moved to inline SVG. The icon sits in a fixed-width slot
// (.nav-ico), stays aria-hidden, and must never leak into the link's
// accessible name: five specs select the tabs by bare label.
const NAV = [
  { to: "/", label: "Draw", icon: CardsIcon },
  { to: "/tasks", label: "Tasks", icon: TasksIcon },
  { to: "/goals", label: "Goals", icon: TargetIcon },
  { to: "/stats", label: "Stats", icon: ChartIcon },
  { to: "/settings", label: "Settings", icon: GearIcon },
];

// The Assistant (#31) is an AI surface: its nav entry exists only while a key
// is configured (degraded mode hides the feature, like every AI affordance).
// The ROUTE stays registered either way — a direct visit in degraded mode
// gets the page's own Settings hint instead of a dead link.
const ASSISTANT = { to: "/assistant", label: "Assistant", icon: AssistantIcon };

export default function App() {
  const aiStatus = useAiStatus();
  const nav = aiStatus.data?.configured ? [...NAV.slice(0, 3), ASSISTANT, ...NAV.slice(3)] : NAV;
  // Route-enter fade (#244): the pathname keys the wrapper below, so every
  // navigation remounts it and re-runs the CSS animation — one attachment
  // point instead of touching seven per-page .content roots. Motion itself
  // is gated behind prefers-reduced-motion in index.css.
  const location = useLocation();
  return (
    <DeckScopeProvider>
    <div className="layout">
      <nav className="sidenav">
        <div className="brand">
          <span className="brand-ico" aria-hidden="true">
            <CardsIcon />
          </span>
          Draw
        </div>
        {nav.map(({ icon: Icon, ...item }) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}>
            <span className="nav-ico" aria-hidden="true">
              <Icon />
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
        {/* Work mode (#214): renders nothing unless a scope is set, so the
            unscoped app gains no chrome. Above TimerBar — a standing setting
            reads as context for the running timer, not the other way round. */}
        <DeckScopeBar />
        <TimerBar />
        <AchievementToast />
        {/* Command palette + global shortcuts (#243, ADR-68): mounted once in
            the shell so Ctrl+K works from every page; renders null until
            opened, like the toast above. */}
        <CommandPalette />
        <div className="route-view" key={location.pathname}>
          <Routes>
            <Route path="/" element={<DrawPage />} />
            {/* Capture merged into Tasks (#151, ADR-40) — the route survives
                as a redirect for muscle memory and old links. */}
            <Route path="/capture" element={<Navigate to="/tasks" replace />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/goals" element={<GoalsPage />} />
            <Route path="/assistant" element={<AssistantPage />} />
            <Route path="/stats" element={<StatsPage />} />
            {/* History merged into Stats (#155, ADR-41) — the route survives
                as a redirect for muscle memory and old links. */}
            <Route path="/history" element={<Navigate to="/stats" replace />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </div>
      </div>
    </div>
    </DeckScopeProvider>
  );
}
