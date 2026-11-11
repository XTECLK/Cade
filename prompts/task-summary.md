---
description: Write a Cade task's summary from its Slack threads, or bring the one it has up to date, and save it once you approve.
arguments:
  task: The task: its ID, a link to its card or a message in its thread, or its title.
---

# Summarize a task

The summary at the top of a task's notes page says what the issue or request is, for someone who wasn't
in the discussion. Write it if the task has none, or bring it up to date if it has one.

## 1. Find the task

- A task ID (`C0123ABCD:1700000000.000100`): use it as `task_id`.
- A link to the task's card or to a message in its thread: `get_thread_history` with `link` gives
  `thread_id`, which is the task's ID when the thread is a task's.
- A title or a description: `get_tasks`, and pick the one that matches. If more than one could be
  meant, or none, ask.

## 2. Read

1. `get_task` with the `task_id`: its title, status, `summary` and `summary_by`, `notes`, and where it
   came from (`original_thread_state`, `original_thread`).
2. The thread it was made from: `get_thread_history` with `original_thread.thread_id`. Read the task's
   own thread too with `get_task_history`: the scope and the details often change there after the task
   is made. If `original_thread_state` is `none`, the task's own thread is all there is.
3. Links in the messages (`links`): Cade doesn't open them. Open those that matter with your own tools,
   signed in as the person; if you can't, say so rather than guess what they hold.

## 3. Write

The summary is about the issue only, as the threads now understand it:

- what the problem or request is, who raised it and when;
- the impact: who or what it affects, and how badly;
- the details needed to understand or reproduce it (steps, examples, error text, environment).

Leave out what was done about it and how it ended: the task's status and thread say that. Plain text,
short paragraphs, `- ` for bullets, people's names rather than `<@U…>` mentions, no secrets,
credentials or internal hostnames. Only what the threads say: if something important is missing, say
so to the person rather than fill it in. Nothing from a private channel or direct message goes in a
task whose channel others can read.

If the task has a summary already, keep what is still right and change only what the threads show has
changed. If nothing has, say so and stop: don't rewrite a summary for the sake of it. If someone other
than the person asking wrote it (`summary_by`), say whose summary they are replacing.

## 4. Approve and save

Show the task and the whole summary as it will be saved; when it replaces one, show each change as
before -> after with the message it comes from. Then ask "Go ahead?" and stop. If they change anything,
show it again. On a clear yes, call `update_task` once, with `task_id` and `summary`. Cade saves it on
the notes page and tells the task's thread; give the person the `notes_link`.
