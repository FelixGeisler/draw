import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDeckScope } from "../DeckScopeContext";
import { useCategories } from "../hooks/useTasks";
import {
  ALL_PROJECTS_OPTION,
  moveProjectPickerActive,
  projectOptionId,
  projectOptions,
  type ProjectOption,
  type ProjectOptionId,
  type ProjectPickerMove,
} from "../lib/projectPicker";
import "./ProjectPicker.css";

const LIST_ID = "project-picker-list";
const optionDomId = (id: ProjectOptionId) => `project-picker-option-${id}`;

/**
 * The app-wide presentation of ADR-57's category-backed deck scope.
 * "Project" is UI language only: selection still reads and writes DeckScopeContext.
 */
export function ProjectPicker() {
  const { scope, setScope } = useDeckScope();
  const categories = useCategories();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<ProjectOptionId>(ALL_PROJECTS_OPTION);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loaded = categories.data !== undefined;
  const selected = categories.data?.find((category) => category.id === scope);
  const selectedId = selected ? projectOptionId(selected.id) : ALL_PROJECTS_OPTION;
  const options = useMemo(
    () => projectOptions(categories.data ?? [], query),
    [categories.data, query],
  );
  const optionIds = useMemo(() => options.map((option) => option.id), [options]);
  // A query can remove the active project during the render before the effect
  // below normalises state. Keep aria-activedescendant valid in that frame.
  const effectiveActive = optionIds.includes(active) ? active : ALL_PROJECTS_OPTION;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openPicker = () => {
    if (!loaded) return;
    setActive(selectedId);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    requestAnimationFrame(() => {
      document.getElementById(optionDomId(active))?.scrollIntoView({ block: "nearest" });
    });
  }, [open]); // The current selection is the one-time opening target.

  useEffect(() => {
    if (optionIds.includes(active)) return;
    setActive(ALL_PROJECTS_OPTION);
  }, [active, optionIds]);

  useEffect(() => {
    if (!open) return;
    const onOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      close(false);
      // Pointer default focus runs after pointerdown. Restore focus once that
      // step finishes so outside activation has the same documented endpoint
      // as Escape without cancelling the outside control's click action.
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    };
    document.addEventListener("pointerdown", onOutsidePointer);
    return () => document.removeEventListener("pointerdown", onOutsidePointer);
  }, [close, open]);

  const select = (option: ProjectOption) => {
    setScope(option.categoryId);
    close(true);
  };

  const move = (direction: ProjectPickerMove) => {
    const next = moveProjectPickerActive(optionIds, effectiveActive, direction);
    setActive(next);
    requestAnimationFrame(() => {
      document.getElementById(optionDomId(next))?.scrollIntoView({ block: "nearest" });
    });
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? "next" : "previous");
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      move(event.key === "Home" ? "first" : "last");
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options.find((candidate) => candidate.id === effectiveActive);
      if (option) select(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      // Let the browser advance focus from the still-mounted input, then remove
      // the popup. Returning focus here would trap keyboard users on the trigger.
      window.setTimeout(() => close(false), 0);
    }
  };

  let label = selected ? selected.name : "All projects";
  if (!loaded) label = categories.isError ? "Unavailable" : "Loading…";
  const fullLabel = `Project: ${label}`;

  return (
    <div className="project-picker" data-testid="project-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="project-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? LIST_ID : undefined}
        aria-label={fullLabel}
        title={fullLabel}
        disabled={!loaded}
        onClick={() => (open ? close(true) : openPicker())}
      >
        {selected && (
          <span
            className="project-picker-dot"
            style={{ background: selected.color }}
            aria-hidden="true"
          />
        )}
        <span className="project-picker-label">
          <span className="project-picker-prefix">Project: </span>
          <span className="project-picker-name">{label}</span>
        </span>
        {loaded && <span className="project-picker-chevron" aria-hidden="true" />}
      </button>

      {open && (
        <div className="project-picker-popup">
          <input
            ref={searchRef}
            type="search"
            className="project-picker-search"
            aria-label="Search projects"
            aria-controls={LIST_ID}
            aria-activedescendant={optionDomId(effectiveActive)}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <div id={LIST_ID} className="project-picker-list" role="listbox" aria-label="Projects">
            {options.map((option) => {
              const isSelected = option.id === selectedId;
              const isActive = option.id === effectiveActive;
              return (
                <div
                  id={optionDomId(option.id)}
                  key={option.id}
                  role="option"
                  aria-selected={isSelected}
                  className={`project-picker-option${isActive ? " active" : ""}`}
                  title={option.name}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => setActive(option.id)}
                  onClick={() => select(option)}
                >
                  {option.color ? (
                    <span
                      className="project-picker-dot"
                      style={{ background: option.color }}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="project-picker-all" aria-hidden="true">✦</span>
                  )}
                  <span className="project-picker-option-name">{option.name}</span>
                  {isSelected && <span className="project-picker-check" aria-hidden="true">✓</span>}
                </div>
              );
            })}
            {options.length === 1 && query.trim() !== "" && (
              <div className="project-picker-empty" role="status" aria-live="polite">
                No matching projects
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
