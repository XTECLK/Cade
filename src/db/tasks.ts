// Tasks: stored before their root message is posted, then found by its channel and ts, and read with their
// parent's details, their subtasks' counts and where their pull requests stand (see TASK_SELECT).
import type { Priority, Status, StoredTask, Task } from "../types.ts";
import { type DbEnv, insert, upsert } from "./common.ts";

// Rows as D1 gives them: the columns in migrations/.
interface TaskRow {
  id: number;
  channel: string;
  ts: string | null;
  title: string;
  priority: Priority;
  status: Status;
  due_date: string;
  developers: string;
  reviewers: string;
  testers: string;
  prs: string;
  created_by: string;
  via_agent: number;
  completed_at: string;
  kind: "task" | "bug" | "incident";
  parent_id: number | null;
  blocked: number;
  blocked_reason: string | null;
  link: string | null;
  origin: string | null;
  post_attempts: number;
  deleted_at: string | null;
  archived_at: string | null;
  archived_by: string | null;
  export_url: string | null;
}

// A task's row as TASK_SELECT gives it: with its parent's, and its subtasks' counts.
interface ListedTaskRow extends TaskRow {
  parent_ts: string | null;
  parent_title: string | null;
  parent_link: string | null;
  parent_owners: string | null;
  open_subtasks: number;
  closed_subtasks: number;
  // JSON: { [url]: state } for those of its pull requests read from GitHub.
  pr_states: string | null;
}

// A subtask counted on its parent's card: posted, and neither deleted nor archived.
const COUNTED = "c.parent_id = t.id AND c.ts IS NOT NULL AND c.deleted_at IS NULL AND c.archived_at IS NULL";

// Tasks as they are read: each with its parent's ts, title and link (for a subtask), how many of
// its own subtasks are open and closed (Done), and where its pull requests stand, which its card shows. Conditions name the task `t`.
const TASK_SELECT = `SELECT t.*, p.ts AS parent_ts, p.title AS parent_title, p.link AS parent_link, p.developers AS parent_owners,
  (SELECT COUNT(*) FROM tasks c WHERE ${COUNTED} AND c.status != 'DONE') AS open_subtasks,
  (SELECT COUNT(*) FROM tasks c WHERE ${COUNTED} AND c.status = 'DONE') AS closed_subtasks,
  (SELECT json_group_object(pr.url, pr.state) FROM pull_requests pr WHERE pr.url IN (SELECT value FROM json_each(t.prs))) AS pr_states
  FROM tasks t LEFT JOIN tasks p ON p.id = t.parent_id`;

// How many times Cade tries to post a root message before giving up: once
// when it is made, then on each retry (see retry.ts).
export const POST_ATTEMPTS = 5;

// Returns the task whose root message is `ts`, or null if there is none or
// it was deleted.
export async function getTask(env: DbEnv, channel: string, ts: string) {
  const row = await env.DB.prepare(
    `${TASK_SELECT} WHERE t.channel = ? AND t.ts = ? AND t.deleted_at IS NULL AND t.archived_at IS NULL`,
  )
    .bind(channel, ts)
    .first<ListedTaskRow>();
  return row ? taskFromRow(row) : null;
}

// The subtasks of the task whose root message is `ts`, Done or not, as { ts, task }, oldest first.
// Deleted and archived ones aren't included.
export async function subtasksOf(env: DbEnv, channel: string, ts: string) {
  const { results } = await env.DB.prepare(
    `${TASK_SELECT} WHERE p.channel = ? AND p.ts = ? AND t.ts IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
     ORDER BY t.id`,
  )
    .bind(channel, ts)
    .all<ListedTaskRow>();
  return results.map((row) => ({ ts: row.ts!, task: taskFromRow(row) }));
}

// The title of the task whose root message is `ts`, archived or not, or null
// if there is none or it was deleted: what its pages are headed with.
export async function taskTitleOf(env: DbEnv, channel: string, ts: string) {
  const row = await env.DB.prepare("SELECT title FROM tasks WHERE channel = ? AND ts = ? AND deleted_at IS NULL")
    .bind(channel, ts)
    .first<Pick<TaskRow, "title">>();
  return row ? row.title : null;
}

// Makes the posted task at `ts` a subtask of the one at `parentTs`, in the same channel, or, with
// null, a task of its own again (see subtask-link.ts).
export async function setTaskParent(env: DbEnv, channel: string, ts: string, parentTs: string | null) {
  await env.DB.prepare(
    `UPDATE tasks SET parent_id = ${parentTs ? "(SELECT id FROM tasks WHERE channel = ? AND ts = ?)" : "NULL"}, updated_at = CURRENT_TIMESTAMP
     WHERE channel = ? AND ts = ?`,
  )
    .bind(...(parentTs ? [channel, parentTs] : []), channel, ts)
    .run();
}

// Stores a new task that is about to be posted in `channel`, with `origin`,
// what follows the post (see publishTask), and returns its id.
// A subtask is stored with its parent's id, which it keeps.
export async function insertTask(env: DbEnv, channel: string, task: Task, origin: unknown) {
  const parent = task.parent
    ? await env.DB.prepare("SELECT id FROM tasks WHERE channel = ? AND ts = ?")
        .bind(channel, task.parent.ts)
        .first<{ id: number }>()
    : null;
  if (task.parent && !parent) throw new Error("A subtask's parent is not stored");
  return insert(env, "tasks", channel, {
    ...taskToRow(task),
    parent_id: parent?.id ?? null,
    origin: JSON.stringify(origin),
  });
}

// Records that the task's root message was posted as `ts`.
export async function markTaskPosted(env: DbEnv, id: number, ts: string, link?: string | null) {
  await env.DB.prepare(
    `UPDATE tasks SET ts = ?, link = ?, origin = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(ts, link ?? null, id)
    .run();
}

// Saves a posted task.
export async function putTask(env: DbEnv, channel: string, ts: string, task: Task) {
  await upsert(env, "tasks", channel, ts, taskToRow(task));
}

export async function markTaskDeleted(env: DbEnv, channel: string, ts: string) {
  await env.DB.prepare("UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE channel = ? AND ts = ?")
    .bind(channel, ts)
    .run();
}

// Stops tracking the task, keeping it for the summary's Archived section
// (see archive.ts).
export async function markTaskArchived(env: DbEnv, channel: string, ts: string, user: string) {
  await env.DB.prepare("UPDATE tasks SET archived_at = CURRENT_TIMESTAMP, archived_by = ? WHERE channel = ? AND ts = ?")
    .bind(user, channel, ts)
    .run();
}

// The archived tasks in `channel` that weren't deleted since, as { ts,
// task, archivedAt, archivedBy }, most recently archived first: at most
// `limit`.
export async function archivedTasks(env: DbEnv, channel: string, limit: number) {
  const { results } = await env.DB.prepare(
    `${TASK_SELECT}
     WHERE t.channel = ? AND t.ts IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NOT NULL
     ORDER BY t.archived_at DESC, t.id DESC LIMIT ?`,
  )
    .bind(channel, limit)
    .all<ListedTaskRow>();
  return results.map((row) => ({
    ts: row.ts!,
    task: taskFromRow(row),
    archivedAt: row.archived_at!,
    archivedBy: row.archived_by,
  }));
}

// Returns the task whose root message is `ts`, deleted, archived or not,
// with `deleted` saying whether it was deleted, or null if there is none. A deleted task's
// messages may still be in Slack, if deleting them failed.
export async function getTaskIncludingDeleted(env: DbEnv, channel: string, ts: string) {
  const row = await env.DB.prepare(`${TASK_SELECT} WHERE t.channel = ? AND t.ts = ?`)
    .bind(channel, ts)
    .first<ListedTaskRow>();
  return row ? { ...taskFromRow(row), deleted: Boolean(row.deleted_at) } : null;
}

// The posted tasks of every channel with one of `statuses`, as { channel, ts,
// task }, oldest first. Deleted and archived tasks aren't included.
export async function tasksWithStatuses(env: DbEnv, statuses: readonly Status[]) {
  const { results } = await env.DB.prepare(
    `${TASK_SELECT}
     WHERE t.ts IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
       AND t.status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY t.ts`,
  )
    .bind(...statuses)
    .all<ListedTaskRow>();
  return results.map((row) => ({ channel: row.channel, ts: row.ts!, task: taskFromRow(row) }));
}

// The posted tasks in `channel` with one of `statuses`, as { ts, task },
// oldest first.
export async function tasksWithStatus(env: DbEnv, channel: string, statuses: readonly Status[]) {
  const { results } = await env.DB.prepare(
    `${TASK_SELECT}
     WHERE t.channel = ? AND t.ts IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
       AND t.status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY t.ts`,
  )
    .bind(channel, ...statuses)
    .all<ListedTaskRow>();
  return results.map((row) => ({ ts: row.ts!, task: taskFromRow(row) }));
}

// The tasks whose root message Slack hasn't taken yet, as { id, channel,
// task, origin, attempts }, oldest first. Only those made a minute or more
// ago, so a post still under way isn't made twice.
export async function unpostedTasks(env: DbEnv) {
  const { results } = await env.DB.prepare(
    `${TASK_SELECT}
     WHERE t.ts IS NULL AND t.deleted_at IS NULL AND t.created_at <= datetime('now', '-1 minute')
     ORDER BY t.id`,
  ).all<ListedTaskRow>();
  return results.map((row) => ({
    id: row.id,
    channel: row.channel,
    task: taskFromRow(row),
    origin: JSON.parse(row.origin ?? "{}"),
    attempts: row.post_attempts,
  }));
}

// Counts a post Slack refused, for the task `id`. After the last attempt it
// is given up: marked deleted, so it isn't tried again. Returns the attempts
// so far.
export async function countPostAttempt(env: DbEnv, id: number) {
  const { post_attempts: attempts } = (await env.DB.prepare(
    `UPDATE tasks SET post_attempts = post_attempts + 1,
       deleted_at = CASE WHEN post_attempts + 1 >= ? THEN CURRENT_TIMESTAMP END
     WHERE id = ? RETURNING post_attempts`,
  )
    .bind(POST_ATTEMPTS, id)
    .first<{ post_attempts: number }>())!;
  return attempts;
}

function taskToRow(task: Task) {
  return {
    title: task.title,
    priority: task.priority,
    status: task.status,
    due_date: task.dueDate ?? "",
    // The owners are kept in the developers column, from before the role
    // was renamed.
    developers: JSON.stringify(task.people.owner),
    reviewers: JSON.stringify(task.people.reviewer),
    testers: JSON.stringify(task.people.tester),
    prs: JSON.stringify(task.prs ?? []),
    created_by: task.createdBy,
    via_agent: task.viaAgent ? 1 : 0,
    completed_at: task.completedAt ?? "",
    kind: task.incident ? "incident" : task.bug ? "bug" : "task",
    blocked: task.blocked ? 1 : 0,
    blocked_reason: task.blocked ? (task.blockedReason ?? "") : "",
    link: task.link ?? null,
    export_url: task.export?.url ?? null,
  };
}

function taskFromRow(row: ListedTaskRow): StoredTask {
  return {
    title: row.title,
    priority: row.priority,
    status: row.status,
    dueDate: row.due_date,
    people: {
      owner: JSON.parse(row.developers),
      reviewer: JSON.parse(row.reviewers),
      tester: JSON.parse(row.testers),
    },
    prs: JSON.parse(row.prs),
    createdBy: row.created_by,
    viaAgent: Boolean(row.via_agent),
    completedAt: row.completed_at,
    // Whether it is an incident: always urgent and due immediately.
    incident: row.kind === "incident",
    bug: row.kind === "bug",
    // Whether it is blocked, and why (see blockedLine in tasks.ts).
    blocked: Boolean(row.blocked),
    blockedReason: row.blocked_reason ?? "",
    link: row.link || undefined,
    // The address of its thread's page on the Worker, once it has one (see export.ts).
    export: row.export_url ? { url: row.export_url } : undefined,
    // The task it is a subtask of, if it is one, and how its own subtasks stand.
    parent: row.parent_ts
      ? {
          ts: row.parent_ts,
          title: row.parent_title ?? "",
          link: row.parent_link ?? undefined,
          owner: JSON.parse(row.parent_owners ?? "[]"),
        }
      : undefined,
    subtaskCounts: { open: row.open_subtasks, closed: row.closed_subtasks },
    prStates: JSON.parse(row.pr_states ?? "{}"),
  };
}

// The tasks a thread was moved into: those whose kept messages include Cade's "Moved from" copy of a
// message of the thread `channel`/`ts` (see moveMessage in commands/move.ts), as [{ channel, ts }].
export async function tasksMovedFrom(env: DbEnv, channel: string, ts: string) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT channel, task_ts, text FROM messages WHERE text LIKE 'Moved from %' AND text LIKE ?",
  )
    .bind(`%/archives/${channel}/%`)
    .all<{ channel: string; task_ts: string; text: string }>();
  return results.map((row) => ({ channel: row.channel, ts: row.task_ts, text: row.text }));
}

// The posted tasks, not deleted or archived, that link one of `urls`, as { channel, ts, task }.
export async function tasksWithPrs(env: DbEnv, urls: string[]) {
  const { results } = await env.DB.prepare(
    `${TASK_SELECT} WHERE t.ts IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM json_each(t.prs) j WHERE j.value IN (SELECT value FROM json_each(?)))`,
  )
    .bind(JSON.stringify(urls))
    .all<ListedTaskRow>();
  return results.map((row) => ({ channel: row.channel, ts: row.ts!, task: taskFromRow(row) }));
}

// Moves the task at `oldTs` to the root message `newTs` (see rotate.ts): a task, its kept messages and
// its summary and its consumers' positions are all found by their root's ts.
export async function moveTaskThread(env: DbEnv, channel: string, oldTs: string, newTs: string) {
  for (const sql of [
    "UPDATE tasks SET ts = ? WHERE channel = ? AND ts = ?",
    "UPDATE messages SET task_ts = ? WHERE channel = ? AND task_ts = ?",
    "UPDATE task_summaries SET task_ts = ? WHERE channel = ? AND task_ts = ?",
    "UPDATE task_consumers SET task_ts = ? WHERE channel = ? AND task_ts = ?",
  ]) {
    await env.DB.prepare(sql).bind(newTs, channel, oldTs).run();
  }
}
