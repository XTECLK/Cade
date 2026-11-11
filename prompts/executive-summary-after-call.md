---
description: After a client call on an executive summary, bring the project's Cade tasks in line with what was decided, one task at a time, as you approve.
arguments:
  project: The project, by name.
  summary?: Where the summary the call went through is: a link to the document, or which one in it.
---

# Follow up a client call

The team went through an executive summary (see the **executive-summary** prompt) with the client.
Bring the tasks in line with what the call decided. You need tools that can read the team's document.

## 1. Compare

- The project: `get_projects`, by name. If more than one could be meant, ask.
- Read the summary back from the team's document, as edited in or after the call, and compare it with
  what was written: lines changed, taken out or added, and notes about the call. If you didn't write it
  in this conversation, ask what it said before the call, or read the document's history if your tools
  can.

## 2. Bring the tasks in line

One task at a time, for each change that touches a task:

1. Read its thread first (`get_task_history`), so the same decision isn't posted twice: if the thread
   already says it, skip it.
2. Show the task, each field that changes as old -> new with the reason (status, priority, due date,
   owner, reviewer, tester), and the message telling the thread what the call decided; then ask
   "Go ahead?" and stop.
3. On a clear yes, `update_task` with only what changes, then `send_thread_message` with `thread_id`
   set to the `task_id`. If the person has Slack tools of their own, ask first whether to post as
   them with those or via Cade.

For something the call added that isn't a task yet, offer `create_task`, one at a time, with the same
preview and approval. Finish with a list of what was changed, posted and created, with links.
