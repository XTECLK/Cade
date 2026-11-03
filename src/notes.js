import { notesUrl } from "./links.js";

// Each task has a notes page on the Worker (see web.js), for what doesn't fit
// in Slack: the summary an AI agent writes (see mcp.js) and the notes people
// type in by hand. Both are kept in the database (`task_notes`). Cade only
// links the page: the task keeps its address (`notes` on the task, see db.js),
// and its card shows the link. A new task gets its link as it is created (see
// addPages in export.js); `/cade resync` makes one for a task that has none
// (see syncNotes).

// Gives the task the link to its notes page if it has none, and records it in
// `task.notes` (nothing is stored here: the caller saves the task, which also
// redraws its card). Nothing changes where the Worker's address isn't known.
export function syncNotes(env, channel, ts, task) {
  if (task.notes) return;
  const url = notesUrl(env, channel, ts);
  if (url) task.notes = { url };
}
