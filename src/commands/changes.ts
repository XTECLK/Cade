import { changeMessage, changeRequests } from "../notify.ts";
import { acknowledge, callSlack } from "../slack.ts";
import { ROLES, cleanReason, loadTask, saveTask } from "../tasks.ts";
import { afterStatusChange, setStatusFields } from "./status.ts";
import type { AppEnv } from "../env.ts";
import type { Change, Changes, Role, Status, Task } from "../types.ts";

// Where a task is: its channel and its root message.
type Where = { channel: string; ts: string };
// `from`: the status a suggestion was made at; `told`: who its message mentioned; `source`: "mcp" for an AI agent.
type ChangeOptions = { from?: Status; told?: string[]; source?: string };

// Suggestions work in three steps:
//   1. detecting what a message asks to change, with AI (ai-suggest.ts),
//      or a pasted pull request link, then asking whoever wrote it,
//      privately;
//   2. once confirmed, applying the changes, here;
//   3. telling the thread, as one message made from what actually changed:
//      the change log, then what it means for the people it names (see
//      notify.ts). A typed command shows its change on the task card, so it
//      acknowledges with a ✅ and posts only the second part (see
//      acknowledged).
// Changes are { people: { [role]: { add, remove } }, status, priority,
// dueDate, prs: { add, remove }, blocked: { on, reason } }, each optional; pull requests are links.

// The pull requests of `task` once `changes` are applied.
export function prsAfter(task: Task, changes: Changes) {
  const { add = [], remove = [] } = changes.prs ?? {};
  return [...task.prs!.filter((url) => !remove.includes(url)), ...add.filter((url) => !task.prs!.includes(url))];
}

// Applies `changes` to the task at `channel`/`ts` for `user`, and posts what
// changed in its thread. Returns whether anything changed.
//
// `told` lists who the message a suggestion came from mentioned: it
// notified them already, so they aren't asked again; the change log still
// mentions them. `source` is "mcp" for a change made through someone's AI agent,
// by their MCP key: the thread says so, and no private prompt is shown to the
// person (see afterStatusChange), since they are not looking at Slack. A change made in Slack
// has no source.
export async function applyChanges(env: AppEnv, where: Where, changes: Changes, user: string, options?: ChangeOptions) {
  const change = await changeTask(env, where, changes, user, options);
  const text = change && [changeMessage(change), options?.source === "mcp" && "_(via AI agent)_"].filter(Boolean).join("\n");
  if (text) await callSlack(env, "chat.postMessage", { channel: where.channel, thread_ts: where.ts, text });
  return Boolean(text);
}

// Applies `changes` to the task at `channel`/`ts` for `user`, all to the one
// task, saved once, and returns what actually changed, as notify.ts reads
// it, or null when nothing did or the task is gone. Only what differs is a
// change: someone already an owner isn't added again, nor a status set
// that it has. The priority and due date of an incident never change, and
// the status is left alone when the task has moved on from `from` since a
// suggestion was made. Telling the thread is left to the caller.
export async function changeTask(env: AppEnv, { channel, ts }: Where, changes: Changes, user: string, { from, told: mentioned = [], source }: ChangeOptions = {}): Promise<Change | null> {
  const task = await loadTask(env, channel, ts);
  if (!task) return null;
  // Left out of requests, not of the change log, which still mentions them.
  const told = Object.fromEntries(mentioned.map((id) => [id, null]));
  const change: Change = { user, told, task, people: [], prs: null, priority: null, dueDate: null, status: null, subtasks: null, blocked: null };

  // Only the roles there are now: a suggestion posted before owners were
  // called that names developers.
  for (const [role, { add = [], remove = [] }] of Object.entries(changes.people ?? {}) as [Role, { add?: string[]; remove?: string[] }][]) {
    if (!ROLES[role]) continue;
    const added = add.filter((id) => !task.people[role].includes(id));
    const removed = remove.filter((id) => task.people[role].includes(id));
    task.people[role] = [...task.people[role].filter((id) => !removed.includes(id)), ...added];
    if (added.length || removed.length) change.people.push({ role, added, removed });
  }

  const added = (changes.prs?.add ?? []).filter((url) => !task.prs!.includes(url));
  const removed = (changes.prs?.remove ?? []).filter((url) => task.prs!.includes(url));
  if (added.length || removed.length) {
    task.prs = [...task.prs!.filter((url) => !removed.includes(url)), ...added];
    change.prs = { added, removed };
  }

  if (!task.incident) {
    if ("priority" in changes && task.priority !== changes.priority) {
      change.priority = { from: task.priority, to: changes.priority! };
      task.priority = changes.priority!;
    }
    if ("dueDate" in changes && (task.dueDate ?? "") !== changes.dueDate) {
      change.dueDate = { from: task.dueDate, to: changes.dueDate! };
      task.dueDate = changes.dueDate;
    }
  }

  if ("subtasks" in changes && Boolean(changes.subtasks) !== Boolean(task.subtasks)) {
    task.subtasks = Boolean(changes.subtasks);
    change.subtasks = { to: task.subtasks };
  }

  // Blocked, or no longer, with a reason when blocking; a new reason on a blocked task is a change too.
  if (changes.blocked) {
    const on = Boolean(changes.blocked.on);
    const reason: string = on ? cleanReason(changes.blocked.reason ?? (task.blocked ? task.blockedReason : "")) : "";
    if (on !== Boolean(task.blocked) || reason !== (task.blockedReason ?? "")) {
      task.blocked = on;
      task.blockedReason = reason;
      change.blocked = { to: on, reason };
    }
  }

  const stale = from && task.status !== from;
  if (changes.status && changes.status !== task.status && !stale) {
    change.status = { from: task.status, to: changes.status };
    setStatusFields(task, changes.status);
  }

  if (!change.people.length && !change.prs && !change.priority && !change.dueDate && !change.status && !change.subtasks && !change.blocked) return null;
  await saveTask(env, channel, ts, task);
  if (change.status) await afterStatusChange(env, channel, ts, change.status, user, source);
  return change;
}

// The reply to a typed command that made `change` (see changeTask): a ✅ on
// the command, and the requests the change means for people, if any.
export function acknowledged(change: Change | null) {
  const notes = change ? changeRequests(change) : [];
  return acknowledge(notes.join("\n") || undefined);
}
