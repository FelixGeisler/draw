# 1. Introduction and Goals

[← back to index](index.md)

## 1.1 Requirements Overview

**Draw** is a local, single-user web application that helps its user overcome two
concrete productivity problems:

1. **Difficulty getting started.** Big, vague tasks create decision paralysis.
   Draw forces every task above a configurable effort threshold (default 30 minutes)
   to be broken into small, concrete steps before it can be worked on, and offers a
   *card draw*: a weighted random pick that removes the "what should I do now?"
   decision entirely.
2. **Time spent on low-leverage work.** When studying for an exam it is tempting to
   perfect the introduction chapter instead of practicing past exam questions. Draw
   attaches an *impact* rating (1–5★) to goal-linked tasks, biases the draw toward
   high-impact work, tracks where time actually goes, and confronts the user with
   the result ("80% of your tracked time went to 1–2★ tasks").

Main features:

| Feature | Purpose |
|---|---|
| Capture + forced breakdown | Tasks > 30 min cannot enter the deck; they must be split |
| Weighted card draw | Random pick weighted by impact² / effort × urgency × staleness |
| Goals + backward planning | Derive tasks from what is actually measured (e.g. the exam) |
| Time tracking + leverage stats | Minutes by impact level, weekly leverage grade A–F |
| Gamification | XP, levels, streaks, achievements, trophy deck |
| AI assistance (optional) | Claude API breaks down tasks and plans backward from goals, using uploaded materials (lecture PDFs, past exams) as context |

## 1.2 Quality Goals

| Priority | Quality goal | Motivation |
|---|---|---|
| 1 | **Zero-friction local operation** | One command (`npm run dev`), no accounts, no cloud dependency for core features |
| 2 | **Graceful AI degradation** | Everything must work without an API key; AI is purely additive |
| 3 | **Data integrity** | Time entries and completions are the basis of stats and XP — atomic writes, one source of truth, derived values never stored |
| 4 | **Cost transparency** | Every AI call shows a token/cost estimate and requires explicit confirmation |
| 5 | **Responsiveness** | Draw and completion feedback (confetti, XP) must feel instant |

## 1.3 Stakeholders

| Role | Expectations |
|---|---|
| Owner/user (Felix) | Daily driver for work, study, and household planning; fun to use |
| AI agents (Claude Code) | Maintain and extend the codebase via the issue/PR workflow ([CONTRIBUTING.md](https://github.com/FelixGeisler/draw-task-planner/blob/main/CONTRIBUTING.md)) |
