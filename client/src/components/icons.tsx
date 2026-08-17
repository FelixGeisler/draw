import type { ReactNode, SVGProps } from "react";

/**
 * The app's one icon set (#244, ADR-69): inline SVG, a single 2px stroke,
 * currentColor, 24-box, sized by the consumer's CSS (the components render
 * at 1em-ish sizes via .nav-ico / .icon-btn rules). Icons are chrome, so
 * every one is aria-hidden — the accessible name lives on the button/link
 * that hosts it, never in the graphic (five specs select nav tabs by bare
 * label). Emoji stays only where it is CONTENT: category emoji, achievement
 * art, the TaskBadges chip vocabulary.
 */
function Svg({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Two fanned cards — the deck. Nav "Draw" and the brand. */
export function CardsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <rect x="8.5" y="3.5" width="11.5" height="15.5" rx="2" />
      <path d="M8.5 7.2 5.4 8a2 2 0 0 0-1.44 2.43l2.4 8.9a2 2 0 0 0 2.44 1.4l5.7-1.53" />
    </Svg>
  );
}

/** A checked list. Nav "Tasks". */
export function TasksIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m3.5 6.5 1.6 1.6 2.9-2.9" />
      <path d="M11.5 6.5H21" />
      <path d="m3.5 13 1.6 1.6 2.9-2.9" />
      <path d="M11.5 13H21" />
      <path d="M3.5 19.5h9" />
    </Svg>
  );
}

/** A target. Nav "Goals". */
export function TargetIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.25" />
      <circle cx="12" cy="12" r="0.5" />
    </Svg>
  );
}

/** Bar chart. Nav "Stats". */
export function ChartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 20.5h16" />
      <path d="M7 16.5v-4" />
      <path d="M12 16.5v-9" />
      <path d="M17 16.5v-6.5" />
    </Svg>
  );
}

/** A gear. Nav "Settings". */
export function GearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.75v2.9M12 18.35v2.9M21.25 12h-2.9M5.65 12h-2.9M18.54 5.46l-2.05 2.05M7.51 16.49l-2.05 2.05M18.54 18.54l-2.05-2.05M7.51 7.51 5.46 5.46" />
    </Svg>
  );
}

/** Sparkles — the AI mark. Nav "Assistant". */
export function AssistantIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M10 3.5 11.8 8l4.5 1.8-4.5 1.8L10 16.1l-1.8-4.5L3.7 9.8 8.2 8Z" />
      <path d="m17.75 14.5 1 2.35 2.35 1-2.35 1-1 2.35-1-2.35-2.35-1 2.35-1Z" />
    </Svg>
  );
}

/** A crescent moon — snooze (the old 💤). */
export function MoonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M20 13.6A8.1 8.1 0 1 1 10.4 4a6.4 6.4 0 0 0 9.6 9.6Z" />
    </Svg>
  );
}

/** A sun — wake a snoozed task. */
export function SunIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3" />
    </Svg>
  );
}

/** One stem forking into two — break a task down into steps. */
export function BranchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 3.5V9" />
      <path d="M12 9 6.5 14.5v6" />
      <path d="M12 9l5.5 5.5v6" />
    </Svg>
  );
}

/** Scissors — split a step into parts at the same level. */
export function ScissorsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M8.1 7.7 20 18.5" />
      <path d="M8.1 16.3 20 5.5" />
    </Svg>
  );
}

/** An elbow arrow tucking under — move under another task. */
export function MoveUnderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M5 4v7a4 4 0 0 0 4 4h10" />
      <path d="m15 11 4 4-4 4" />
    </Svg>
  );
}

/** A straight up arrow — promote to top-level (the old ⤴). */
export function ArrowUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M12 19.5V5" />
      <path d="m6 11 6-6 6 6" />
    </Svg>
  );
}

/** A right arrow — subtasks drawn in the listed order. */
export function ArrowRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </Svg>
  );
}

/** Two opposing arrows — subtasks drawn in any order (the old ⇄). */
export function SwapIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 8h14" />
      <path d="M14.5 4.5 18 8l-3.5 3.5" />
      <path d="M20 16H6" />
      <path d="M9.5 12.5 6 16l3.5 3.5" />
    </Svg>
  );
}

/** A pencil — edit. */
export function PencilIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="m4 20 1-4L16.55 4.45a2.05 2.05 0 0 1 2.9 2.9L7.9 18.9l-3.9 1.1Z" />
      <path d="m14.5 6.5 3 3" />
    </Svg>
  );
}

/** A trash can — delete. */
export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      <path d="m6.5 7 .9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

/** Three vertical dots — the row overflow menu trigger. */
export function KebabIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="5.5" r="0.75" fill="currentColor" />
      <circle cx="12" cy="12" r="0.75" fill="currentColor" />
      <circle cx="12" cy="18.5" r="0.75" fill="currentColor" />
    </Svg>
  );
}
