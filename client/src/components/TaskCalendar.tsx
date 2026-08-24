import { useEffect, useMemo, useState } from "react";
import type { Category, Goal, NewTask, Task } from "../api/types";
import { asLocalDate, formatDay, localToday } from "../lib/localDay";
import {
  deriveTaskCalendar,
  monthGridDays,
  shiftMonth,
  type TaskCalendarDay,
} from "../lib/taskCalendar";
import { TaskForm } from "./TaskForm";
import "./TaskCalendar.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  roots: Task[];
  categories: Category[];
  goals?: Goal[];
  selectedMonth: string;
  scopeName?: string;
  onSelectedMonthChange: (month: string) => void;
  onShowList: () => void;
  onUpdate: (id: number, patch: NewTask) => Promise<unknown>;
}

function monthLabel(month: string): string {
  return asLocalDate(`${month}-01`).toLocaleDateString([], {
    month: "long",
    year: "numeric",
  });
}

export function TaskCalendar({
  roots,
  categories,
  goals,
  selectedMonth,
  scopeName,
  onSelectedMonthChange,
  onShowList,
  onUpdate,
}: Props) {
  const today = localToday();
  const data = useMemo(
    () => deriveTaskCalendar(roots, selectedMonth, today),
    [roots, selectedMonth, today],
  );
  const daysByDate = new Map(data.monthDays.map((day) => [day.date, day]));
  const categoriesById = new Map(
    categories.map((category) => [category.id, category]),
  );
  const tasksById = new Map(data.scheduled.map((task) => [task.id, task]));
  const [editingId, setEditingId] = useState<number | null>(null);
  const editing = editingId == null ? undefined : tasksById.get(editingId);

  // A work-mode change or saved status/date change can remove the active item.
  // Do not leave an editor for work that is no longer on this calendar.
  useEffect(() => {
    if (editingId != null && !tasksById.has(editingId)) setEditingId(null);
  }, [editingId, tasksById]);

  const taskButton = (task: Task, context: string) => {
    const category = categoriesById.get(task.categoryId);
    const categoryName = category?.name ?? "Unknown category";
    return (
      <button
        type="button"
        key={`${context}-${task.id}`}
        className="task-calendar-item"
        data-calendar-task-id={task.id}
        aria-label={`${task.title}, ${categoryName}, due ${formatDay(task.dueDate!)}`}
        onClick={() => setEditingId(task.id)}
      >
        <span
          className="task-calendar-dot"
          style={{ background: category?.color ?? "var(--text-dim)" }}
          aria-hidden="true"
        />
        <span className="task-calendar-title">{task.title}</span>
        <span className="task-calendar-category">{categoryName}</span>
      </button>
    );
  };

  const agendaDay = (day: TaskCalendarDay) => (
    <section
      className="task-agenda-day"
      key={day.date}
      data-agenda-date={day.date}
    >
      <h3>
        <time dateTime={day.date}>{formatDay(day.date)}</time>
        {day.date === today && (
          <span className="task-calendar-today-label">Today</span>
        )}
      </h3>
      <div className="task-calendar-items">
        {day.tasks.map((task) => taskButton(task, `agenda-${day.date}`))}
      </div>
    </section>
  );

  return (
    <section
      className="task-calendar"
      data-testid="task-calendar"
      aria-label="Task calendar"
    >
      {data.overdue.length > 0 && (
        <section
          className="task-calendar-overdue"
          aria-labelledby="task-calendar-overdue-title"
        >
          <h2 id="task-calendar-overdue-title">
            Overdue <span>({data.overdue.length})</span>
          </h2>
          <div className="task-calendar-items">
            {data.overdue.map((task) => (
              <div className="task-calendar-overdue-row" key={task.id}>
                <time dateTime={task.dueDate!}>{formatDay(task.dueDate!)}</time>
                {taskButton(task, "overdue")}
              </div>
            ))}
          </div>
        </section>
      )}

      {editing && (
        <section
          className="panel task-calendar-editor"
          aria-label={`Edit ${editing.title}`}
        >
          <h2>Edit scheduled task</h2>
          <TaskForm
            key={editing.id}
            categories={categories}
            goals={editing.parentId == null ? goals : undefined}
            initial={editing}
            autoFocus
            submitLabel="Save"
            hideRecur={
              editing.parentId != null &&
              tasksById.get(editing.parentId)?.subtaskOrderMode === "sequential"
            }
            onSubmit={async (patch) => {
              await onUpdate(editing.id, patch);
              setEditingId(null);
            }}
            onCancel={() => setEditingId(null)}
          />
        </section>
      )}

      <div className="task-calendar-controls">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => onSelectedMonthChange(shiftMonth(selectedMonth, -1))}
        >
          ← Previous
        </button>
        <h2 aria-live="polite" data-testid="task-calendar-month">
          {monthLabel(selectedMonth)}
        </h2>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => onSelectedMonthChange(shiftMonth(selectedMonth, 1))}
        >
          Next →
        </button>
        <button
          type="button"
          onClick={() => onSelectedMonthChange(today.slice(0, 7))}
          disabled={selectedMonth === today.slice(0, 7)}
        >
          Today
        </button>
      </div>

      {data.scheduled.length === 0 ? (
        <div className="panel task-calendar-empty">
          <p>
            {scopeName
              ? `Nothing is scheduled in ${scopeName} work mode.`
              : "Calendar has nothing scheduled."}
          </p>
          <button type="button" onClick={onShowList}>
            Switch to List to add a due date
          </button>
        </div>
      ) : (
        <>
          <div
            className="task-month-grid"
            role="grid"
            aria-label={monthLabel(selectedMonth)}
          >
            {WEEKDAYS.map((weekday) => (
              <div
                role="columnheader"
                className="task-month-weekday"
                key={weekday}
              >
                {weekday}
              </div>
            ))}
            {monthGridDays(selectedMonth).map((date, index) => {
              if (date == null) {
                return (
                  <div
                    className="task-month-pad"
                    aria-hidden="true"
                    key={`pad-${index}`}
                  />
                );
              }
              const day = daysByDate.get(date);
              return (
                <div
                  role="gridcell"
                  className={`task-month-day${date === today ? " today" : ""}`}
                  data-calendar-date={date}
                  aria-label={formatDay(date)}
                  key={date}
                >
                  <time dateTime={date}>{Number(date.slice(8))}</time>
                  {date === today && (
                    <span className="task-calendar-today-label">Today</span>
                  )}
                  <div className="task-calendar-items">
                    {day?.tasks.map((task) => taskButton(task, `grid-${date}`))}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            className="task-month-agenda"
            aria-label={`${monthLabel(selectedMonth)} agenda`}
          >
            {data.monthDays.map(agendaDay)}
          </div>

          {data.monthDays.length === 0 && (
            <p className="panel task-calendar-empty">
              No tasks due this month.
            </p>
          )}
        </>
      )}
    </section>
  );
}
