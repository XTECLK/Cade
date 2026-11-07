import { notesUrl } from "./links.ts";
import type { AppEnv } from "./env.ts";
import type { Task } from "./types.ts";

// Each task has a notes page on the Worker (see web.ts), for what doesn't fit
// in Slack: the summary an AI agent writes (see mcp.ts) and the notes people
// type in by hand. Both are kept in the database (`task_notes`). Cade only
// links the page: the task keeps its address (`notes` on the task, see db.ts),
// and its card shows the link. A new task gets its link as it is created (see
// addPages in export.ts); `/cade resync` makes one for a task that has none
// (see syncNotes).

// Gives the task the link to its notes page if it has none, and records it in
// `task.notes` (nothing is stored here: the caller saves the task, which also
// redraws its card). Nothing changes where the Worker's address isn't known.
export function syncNotes(env: AppEnv, channel: string, ts: string, task: Task) {
  if (task.notes) return;
  const url = notesUrl(env, channel, ts);
  if (url) task.notes = { url };
}
