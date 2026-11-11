---
description: Write an executive summary of a Cade project for a client, for a period (what was done, and how the open work is going), into your team's own document once you approve.
arguments:
  project: The project, by name.
  period?: The period it covers, such as 2026-11-01 to 2026-11-14 or "the last two weeks". Left out, it starts where the last summary ended.
---

# Write an executive summary

A report for a client, per project and period, that the team goes through on a call. Cade gives the
tasks; the report lives wherever the team keeps it (a Google Doc, Notion, Confluence, an email), written
and read with your own tools. You need tools that can read and write the team's document. After the
call, the **executive-summary-after-call** prompt brings the tasks in line with what was decided.

## 1. Settle the project, the period and the document

- The project: `get_projects`, by name. If more than one could be meant, ask.
- The document: ask where the team keeps its summaries, if you don't know. Read the last summary there.
  Its period ends where this one starts, and its format is the one to follow, unless the person says
  otherwise.
- The period: as given, or from the day after the last summary's period to today. Without either, ask.

## 2. Gather

1. `get_tasks` with `project`, `completed_from` and `completed_to` (the period, YYYY-MM-DD),
   `include_open: true`, `status` left out, and `fields` adding `summary` and `notes`: the tasks done in
   the period, and those not done. Raise `limit` if `total` is larger than what came back.
2. For each task not done: `get_task` (its subtasks, pull requests and releases) and
   `get_task_history` (what happened in the period). Read its subtasks' threads too
   (`get_task_history` on each), when they say how the whole task is going.
3. For tasks done in the period, the summary and the card are usually enough; read the thread when
   what was delivered isn't clear from them.

## 3. Draft

A line for each task, in the last summary's format:

- **Done**: what was delivered, in the client's terms.
- **Not done**: its health (on track, at risk, delayed or blocked), its progress (such as 3 of 5, or 2
  of 4 CRMs live) and a short note: what's next, what it waits on, any date. Judge from the tasks and
  threads, name the evidence for anything other than on track, and say when unsure. A blocked task
  (`blocked`, `blocked_reason`) is blocked.

Group or leave out tasks the client doesn't need (internal work, tiny fixes) the way the last summary
did, and say which you left out. Carry a line over from the last summary only when nothing changed
since, and say which lines you carried over. Nothing from a private channel or direct message, no
secrets, credentials or internal hostnames, no commit messages or diffs.

## 4. Approve and write

Show the project, the period and the whole summary as it will be written, with what you left out and
carried over; then ask "Go ahead?" and stop. If they change anything, show it again. On a clear yes,
write it to the team's document with your own tools, at the place the last one is (usually above it),
and give the link. Nothing is written to Cade.
