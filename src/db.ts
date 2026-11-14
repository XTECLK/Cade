// Tasks are stored in D1 (the DB binding). Each is stored before its root
// message is posted; once posted, it is found by the message's channel and
// ts. The root message is rendered from the row
// after every change (see saveTask). The schema is in migrations/, and all
// of it in one place in schema.sql.

import type { AppEnv } from "./env.ts";
import type { PrChange, PrState, Priority, Role, Status, StoredTask, Task } from "./types.ts";

// Only the DB binding is used here, so callers (and tests) can pass any env
// that has one.
type DbEnv = Pick<AppEnv, "DB">;

export type { Role, Task };

export interface MessageRow {
  channel: string;
  taskTs: string;
  ts: string;
  userId?: string | null;
  username?: string | null;
  text?: string | null;
  files?: { name?: string; permalink?: string }[] | null;
}

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
  kind: "task" | "incident";
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

interface MessageDbRow {
  user_id: string | null;
  username: string | null;
  ts: string;
  text: string;
  files: string | null;
}

interface SummaryRow {
  summary: string;
  through_ts: string;
  written_by: string;
  written_at: string;
}

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
    ? await env.DB.prepare("SELECT id FROM tasks WHERE channel = ? AND ts = ?").bind(channel, task.parent.ts).first<{ id: number }>()
    : null;
  if (task.parent && !parent) throw new Error("A subtask's parent is not stored");
  return insert(env, "tasks", channel, { ...taskToRow(task), parent_id: parent?.id ?? null, origin: JSON.stringify(origin) });
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
  await env.DB.prepare(
    "UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE channel = ? AND ts = ?",
  )
    .bind(channel, ts)
    .run();
}

// Stops tracking the task, keeping it for the summary's Archived section
// (see archive.ts).
export async function markTaskArchived(env: DbEnv, channel: string, ts: string, user: string) {
  await env.DB.prepare(
    "UPDATE tasks SET archived_at = CURRENT_TIMESTAMP, archived_by = ? WHERE channel = ? AND ts = ?",
  )
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
  return results.map((row) => ({ ts: row.ts!, task: taskFromRow(row), archivedAt: row.archived_at!, archivedBy: row.archived_by }));
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

// The id of the canvas Cade keeps the channel's summary in, or null.
// The group name the person's Home tab shows, or null for every group.
export async function getHomeProject(env: DbEnv, user: string) {
  const row = await env.DB.prepare("SELECT home_project FROM user_preferences WHERE user_id = ?").bind(user).first<{ home_project: string | null }>();
  return row?.home_project ?? null;
}

export async function setHomeProject(env: DbEnv, user: string, project: string | null) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, home_project) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET home_project = excluded.home_project`,
  )
    .bind(user, project)
    .run();
}

// The Home tab view the person last used, or null.
export async function getHomeTab(env: DbEnv, user: string) {
  const row = await env.DB.prepare("SELECT home_tab FROM user_preferences WHERE user_id = ?").bind(user).first<{ home_tab: string | null }>();
  return row?.home_tab ?? null;
}

export async function setHomeTab(env: DbEnv, user: string, tab: string | null) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, home_tab) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET home_tab = excluded.home_tab`,
  )
    .bind(user, tab)
    .run();
}

// Whether the suggestions Cade offers the person from their own messages are on: they are unless
// the person turned them off.
export async function suggestionsOn(env: DbEnv, user: string) {
  const row = await env.DB.prepare("SELECT suggestions FROM user_preferences WHERE user_id = ?").bind(user).first<{ suggestions: number }>();
  return row ? Boolean(row.suggestions) : true;
}

// Turning them on or off starts the count of rejects in a row again.
export async function setSuggestions(env: DbEnv, user: string, on: boolean) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, suggestions) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET suggestions = excluded.suggestions, suggestion_rejects = 0`,
  )
    .bind(user, on ? 1 : 0)
    .run();
}

// Counts one more suggestion the person rejected, and returns how many that makes in a row. While
// the count is paused (see pauseRejects) nothing is counted, and it returns 0.
export async function countReject(env: DbEnv, user: string) {
  const row = await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, suggestion_rejects) VALUES (?, 1)
     ON CONFLICT (user_id) DO UPDATE SET suggestion_rejects =
       CASE WHEN rejects_paused_until > datetime('now') THEN 0 ELSE suggestion_rejects + 1 END
     RETURNING suggestion_rejects`,
  )
    .bind(user)
    .first<{ suggestion_rejects: number }>();
  return row?.suggestion_rejects ?? 0;
}

// Starts the count of rejects in a row again, as accepting or editing a suggestion does.
export async function resetRejects(env: DbEnv, user: string) {
  await env.DB.prepare("UPDATE user_preferences SET suggestion_rejects = 0 WHERE user_id = ? AND suggestion_rejects != 0").bind(user).run();
}

// Stops counting rejects for `days`, after the person chose to keep suggestions when offered to turn them off.
export async function pauseRejects(env: DbEnv, user: string, days: number) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, rejects_paused_until) VALUES (?, datetime('now', ?))
     ON CONFLICT (user_id) DO UPDATE SET suggestion_rejects = 0, rejects_paused_until = excluded.rejects_paused_until`,
  )
    .bind(user, `+${days} days`)
    .run();
}

export async function getCanvas(env: DbEnv, channel: string) {
  const row = await env.DB.prepare("SELECT canvas_id FROM canvases WHERE channel = ?").bind(channel).first<{ canvas_id: string | null }>();
  return row?.canvas_id ?? null;
}

export async function putCanvas(env: DbEnv, channel: string, canvasId: string, user: string) {
  await env.DB.prepare(
    `INSERT INTO canvases (channel, canvas_id, created_by) VALUES (?, ?, ?)
     ON CONFLICT (channel) DO UPDATE SET canvas_id = excluded.canvas_id, created_by = excluded.created_by`,
  )
    .bind(channel, canvasId, user)
    .run();
}

// The hash of the markdown last written to the channel's canvas, or null.
export async function getCanvasHash(env: DbEnv, channel: string) {
  const row = await env.DB.prepare("SELECT content_hash FROM canvases WHERE channel = ?").bind(channel).first<{ content_hash: string | null }>();
  return row?.content_hash ?? null;
}

export async function setCanvasHash(env: DbEnv, channel: string, hash: string) {
  await env.DB.prepare("UPDATE canvases SET content_hash = ? WHERE channel = ?").bind(hash, channel).run();
}

// Marks the channel's summary as out of date, under `token`. Only a channel
// with a canvas is marked, unless `create`: a group's first task adds its
// row, which has no canvas until the summary is rendered.
export async function markCanvasDirty(env: DbEnv, channel: string, token: string, create = false) {
  const statement = create
    ? env.DB.prepare(
        `INSERT INTO canvases (channel, dirty_token) VALUES (?, ?)
         ON CONFLICT (channel) DO UPDATE SET dirty_token = excluded.dirty_token`,
      ).bind(channel, token)
    : env.DB.prepare("UPDATE canvases SET dirty_token = ? WHERE channel = ?").bind(token, channel);
  await statement.run();
}

// The token the channel's summary was last marked with, or null if it is up
// to date.
export async function getCanvasDirty(env: DbEnv, channel: string) {
  const row = await env.DB.prepare("SELECT dirty_token FROM canvases WHERE channel = ?").bind(channel).first<{ dirty_token: string | null }>();
  return row?.dirty_token ?? null;
}

// Marks the summary up to date, unless it was marked again since `token`.
export async function clearCanvasDirty(env: DbEnv, channel: string, token: string) {
  await env.DB.prepare("UPDATE canvases SET dirty_token = NULL WHERE channel = ? AND dirty_token = ?")
    .bind(channel, token)
    .run();
}

// The channels whose summary is out of date, with the token each was marked with.
export async function dirtyCanvases(env: DbEnv) {
  const { results } = await env.DB.prepare("SELECT channel, dirty_token FROM canvases WHERE dirty_token IS NOT NULL").all<{ channel: string; dirty_token: string }>();
  return results.map((row) => ({ channel: row.channel, token: row.dirty_token }));
}

export async function deleteCanvas(env: DbEnv, channel: string) {
  await env.DB.prepare("DELETE FROM canvases WHERE channel = ?").bind(channel).run();
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

async function insert(env: DbEnv, table: string, channel: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  const { id } = (await env.DB.prepare(
    `INSERT INTO ${table} (channel, ${columns.join(", ")})
     VALUES (?, ${columns.map(() => "?").join(", ")})
     RETURNING id`,
  )
    .bind(channel, ...Object.values(row))
    .first<{ id: number }>())!;
  return id;
}

// Writes `row` as the posted root message's row, adding it or replacing it.
async function upsert(env: DbEnv, table: string, channel: string, ts: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO ${table} (channel, ts, ${columns.join(", ")})
     VALUES (?, ?, ${columns.map(() => "?").join(", ")})
     ON CONFLICT (channel, ts) DO UPDATE SET
       ${columns.map((column) => `${column} = excluded.${column}`).join(", ")},
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(channel, ts, ...Object.values(row))
    .run();
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
    kind: task.incident ? "incident" : "task",
    blocked: task.blocked ? 1 : 0,
    blocked_reason: task.blocked ? task.blockedReason ?? "" : "",
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
    // Whether it is blocked, and why (see blockedLine in tasks.ts).
    blocked: Boolean(row.blocked),
    blockedReason: row.blocked_reason ?? "",
    link: row.link || undefined,
    // The address of its thread's page on the Worker, once it has one (see export.ts).
    export: row.export_url ? { url: row.export_url } : undefined,
    // The task it is a subtask of, if it is one, and how its own subtasks stand.
    parent: row.parent_ts
      ? { ts: row.parent_ts, title: row.parent_title ?? "", link: row.parent_link ?? undefined, owner: JSON.parse(row.parent_owners ?? "[]") }
      : undefined,
    subtaskCounts: { open: row.open_subtasks, closed: row.closed_subtasks },
    prStates: JSON.parse(row.pr_states ?? "{}"),
  };
}

// Messages in a tracked task's thread, kept for good (see messages in
// migrations). Slack redelivers events, and a resync reads a thread again, so
// a message already kept is left as it is. Written several to a statement, as
// D1 allows 100 values in one and a Worker only so many queries.
const MESSAGE_ROWS = 14;

export async function addMessages(env: DbEnv, rows: MessageRow[]) {
  for (let from = 0; from < rows.length; from += MESSAGE_ROWS) {
    const chunk = rows.slice(from, from + MESSAGE_ROWS);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO messages (channel, task_ts, ts, user_id, username, text, files) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
    )
      .bind(
        ...chunk.flatMap(({ channel, taskTs, ts, userId, username, text, files }) => [
          channel,
          taskTs,
          ts,
          userId ?? null,
          username ?? null,
          text ?? "",
          files?.length ? JSON.stringify(files) : null,
        ]),
      )
      .run();
  }
}

export const addMessage = (env: DbEnv, row: MessageRow) => addMessages(env, [row]);

// A task's kept messages, oldest first, as { user, username, ts, text, files }.
export async function threadMessages(env: DbEnv, channel: string, taskTs: string) {
  const { results } = await env.DB.prepare("SELECT * FROM messages WHERE channel = ? AND task_ts = ? ORDER BY ts")
    .bind(channel, taskTs)
    .all<MessageDbRow>();
  return results.map((row) => ({
    user: row.user_id ?? undefined,
    username: row.username ?? undefined,
    ts: row.ts,
    text: row.text,
    files: (row.files ? JSON.parse(row.files) : undefined) as { name?: string; permalink?: string }[] | undefined,
  }));
}

// The task's working summary, which AI agents keep (see get_task_summary in mcp.ts): { summary,
// through, by, at }, `through` being the ts of the last message of the task's thread it covers, or null
// for a task with none yet.
export async function getSummary(env: DbEnv, channel: string, taskTs: string) {
  const row = await env.DB.prepare("SELECT summary, through_ts, written_by, written_at FROM task_summaries WHERE channel = ? AND task_ts = ?")
    .bind(channel, taskTs)
    .first<SummaryRow>();
  return row ? { summary: row.summary, through: row.through_ts, by: row.written_by, at: row.written_at } : null;
}

// Saves the task's working summary, written by `user` and covering its thread up to `through`, unless
// the one saved covers more of it: two agents can work on it at once, and the later one wins. Returns
// whether it was saved.
export async function putSummary(env: DbEnv, channel: string, taskTs: string, summary: string, through: string, user: string) {
  const result = await env.DB.prepare(
    `INSERT INTO task_summaries (channel, task_ts, summary, through_ts, written_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (channel, task_ts) DO UPDATE SET summary = excluded.summary, through_ts = excluded.through_ts,
       written_by = excluded.written_by, written_at = CURRENT_TIMESTAMP
     WHERE task_summaries.through_ts <= excluded.through_ts
     RETURNING 1 AS saved`,
  )
    .bind(channel, taskTs, summary, through, user)
    .first<{ saved: number }>();
  return Boolean(result);
}

// How far `consumer` has read the task's thread (see get_task_history in mcp.ts): { through, by, at },
// `through` being the ts of the last message it acknowledged, or null for one that never did.
export async function getConsumer(env: DbEnv, channel: string, taskTs: string, consumer: string) {
  const row = await env.DB.prepare("SELECT through_ts, acked_by, acked_at FROM task_consumers WHERE channel = ? AND task_ts = ? AND consumer = ?")
    .bind(channel, taskTs, consumer)
    .first<{ through_ts: string; acked_by: string; acked_at: string }>();
  return row ? { through: row.through_ts, by: row.acked_by, at: row.acked_at } : null;
}

// The most consumers a task keeps a position for, so the table stays small.
export const MAX_CONSUMERS = 10;

// Moves `consumer`'s position in the task's thread on to `through`, for `user`. Returns "saved", or "behind"
// when it is past that already (positions only move forward), or "full" for a new consumer of a task that has
// MAX_CONSUMERS already.
export async function putConsumer(env: DbEnv, channel: string, taskTs: string, consumer: string, through: string, user: string) {
  const known = await getConsumer(env, channel, taskTs, consumer);
  if (!known) {
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM task_consumers WHERE channel = ? AND task_ts = ?").bind(channel, taskTs).first<{ n: number }>())!;
    if (n >= MAX_CONSUMERS) return "full";
  }
  const result = await env.DB.prepare(
    `INSERT INTO task_consumers (channel, task_ts, consumer, through_ts, acked_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (channel, task_ts, consumer) DO UPDATE SET through_ts = excluded.through_ts, acked_by = excluded.acked_by, acked_at = CURRENT_TIMESTAMP
     WHERE task_consumers.through_ts <= excluded.through_ts
     RETURNING 1 AS saved`,
  )
    .bind(channel, taskTs, consumer, through, user)
    .first<{ saved: number }>();
  return result ? "saved" : "behind";
}

// The tasks a thread was moved into: those whose kept messages include Cade's "Moved from" copy of a
// message of the thread `channel`/`ts` (see moveMessage in commands/move.ts), as [{ channel, ts }].
export async function tasksMovedFrom(env: DbEnv, channel: string, ts: string) {
  const { results } = await env.DB.prepare("SELECT DISTINCT channel, task_ts, text FROM messages WHERE text LIKE 'Moved from %' AND text LIKE ?")
    .bind(`%/archives/${channel}/%`)
    .all<{ channel: string; task_ts: string; text: string }>();
  return results.map((row) => ({ channel: row.channel, ts: row.task_ts, text: row.text }));
}

// Names of Slack users, as a Map of the ones kept: the name, and whether it was looked up more than
// `staleAfterDays` ago and so is worth asking Slack about again.
export async function keptNames(env: DbEnv, ids: Iterable<string>, staleAfterDays = Infinity) {
  const names = new Map<string, { name: string; stale: boolean }>();
  for (const id of ids) {
    const row = await env.DB.prepare("SELECT name, updated_at < datetime('now', ?) AS stale FROM user_names WHERE user_id = ?")
      .bind(`-${Number.isFinite(staleAfterDays) ? staleAfterDays : 100000} days`, id)
      .first<{ name: string; stale: number }>();
    if (row) names.set(id, { name: row.name, stale: Boolean(row.stale) });
  }
  return names;
}

export async function keepName(env: DbEnv, id: string, name: string) {
  await env.DB.prepare(
    `INSERT INTO user_names (user_id, name) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(id, name)
    .run();
}

export type WebTokenKind = "login" | "session";

// Keeps the hash of a web sign-in token for `user`: a 'login' for `minutes`,
// a 'session' for `minutes` too. Old and used ones are cleared as new are made.
export async function putWebToken(env: DbEnv, hash: string, user: string, kind: WebTokenKind, minutes: number) {
  await env.DB.prepare("DELETE FROM web_tokens WHERE expires_at < datetime('now')").run();
  if (kind === "login") await env.DB.prepare("DELETE FROM web_tokens WHERE user_id = ? AND kind = 'login'").bind(user).run();
  await env.DB.prepare("INSERT INTO web_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, datetime('now', ?))")
    .bind(hash, user, kind, `+${minutes} minutes`)
    .run();
}

// The user a live token of this kind belongs to, or null. A 'login' is used
// up by being looked up.
export async function webTokenUser(env: DbEnv, hash: string, kind: WebTokenKind) {
  const sql =
    kind === "login"
      ? "DELETE FROM web_tokens WHERE token_hash = ? AND kind = ? AND expires_at > datetime('now') RETURNING user_id"
      : "SELECT user_id FROM web_tokens WHERE token_hash = ? AND kind = ? AND expires_at > datetime('now')";
  const row = await env.DB.prepare(sql).bind(hash, kind).first<{ user_id: string }>();
  return row ? row.user_id : null;
}

export async function deleteWebToken(env: DbEnv, hash: string) {
  await env.DB.prepare("DELETE FROM web_tokens WHERE token_hash = ?").bind(hash).run();
}

// How many browsers `user` is signed in on: their live sessions.
export async function webSessionsOf(env: DbEnv, user: string) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM web_tokens WHERE user_id = ? AND kind = 'session' AND expires_at > datetime('now')").bind(user).first<{ count: number }>();
  return row?.count ?? 0;
}

// Ends every sign-in of `user`, the browsers' sessions and any sign-in link not used yet;
// returns how many sessions there were.
export async function deleteWebTokensOf(env: DbEnv, user: string) {
  const { results } = await env.DB.prepare("DELETE FROM web_tokens WHERE user_id = ? RETURNING kind").bind(user).all<{ kind: WebTokenKind }>();
  return results.filter((row) => row.kind === "session").length;
}

// Keeps `hash` as the MCP token of `user`, in place of any they had.
export async function putMcpToken(env: DbEnv, user: string, hash: string) {
  await env.DB.prepare(
    `INSERT INTO mcp_tokens (user_id, token_hash) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = CURRENT_TIMESTAMP`,
  )
    .bind(user, hash)
    .run();
}

// Whether the user has an MCP token.
// When the user's API key was made, in SQLite's datetime form, or null.
export async function mcpTokenCreated(env: DbEnv, user: string) {
  return (await env.DB.prepare("SELECT created_at FROM mcp_tokens WHERE user_id = ?").bind(user).first<{ created_at: string }>())?.created_at ?? null;
}

export async function hasMcpToken(env: DbEnv, user: string) {
  return Boolean(await env.DB.prepare("SELECT 1 AS found FROM mcp_tokens WHERE user_id = ?").bind(user).first());
}

// The user whose MCP token has this hash, or null.
export async function mcpTokenUser(env: DbEnv, hash: string) {
  const row = await env.DB.prepare("SELECT user_id FROM mcp_tokens WHERE token_hash = ?").bind(hash).first<{ user_id: string }>();
  return row ? row.user_id : null;
}

// Removes the user's MCP token, and returns whether they had one.
export async function deleteMcpToken(env: DbEnv, user: string) {
  const row = await env.DB.prepare("DELETE FROM mcp_tokens WHERE user_id = ? RETURNING user_id").bind(user).first();
  return Boolean(row);
}

// The settings changed in the project settings form, as { channel, key, value (JSON) }.
export async function projectSettings(env: DbEnv) {
  const { results } = await env.DB.prepare("SELECT channel, key, value FROM project_settings").all<{ channel: string; key: string; value: string }>();
  return results;
}

export async function setProjectSetting(env: DbEnv, channel: string, key: string, value: unknown, user: string | null) {
  await env.DB.prepare(
    `INSERT INTO project_settings (channel, key, value, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (channel, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(channel, key, JSON.stringify(value), user)
    .run();
}

export async function clearProjectSetting(env: DbEnv, channel: string, key: string) {
  await env.DB.prepare("DELETE FROM project_settings WHERE channel = ? AND key = ?").bind(channel, key).run();
}

// The projects added with the Add project button, as { channel, name }.
export async function addedProjects(env: DbEnv) {
  const { results } = await env.DB.prepare("SELECT channel, name FROM projects ORDER BY rowid").all<{ channel: string; name: string }>();
  return results;
}

export async function addProject(env: DbEnv, channel: string, name: string, user: string) {
  await env.DB.prepare("INSERT INTO projects (channel, name, created_by) VALUES (?, ?, ?)").bind(channel, name, user).run();
}

// ---- Pull requests' states (see github.ts) ----

// The GitHub pull requests of open tasks (posted, not Done, deleted or archived) to read: not merged,
// which is for good. Those never read come first, then those read longest ago, at most `limit`.
export async function prsToSync(env: DbEnv, limit: number) {
  const { results } = await env.DB.prepare(
    `SELECT j.value AS url FROM tasks t, json_each(t.prs) j LEFT JOIN pull_requests pr ON pr.url = j.value
     WHERE t.ts IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.status != 'DONE'
       AND j.value LIKE 'https://github.com/%' AND (pr.state IS NULL OR pr.state != 'MERGED')
     GROUP BY j.value ORDER BY MIN(pr.synced_at IS NOT NULL), MIN(pr.synced_at) LIMIT ?`,
  )
    .bind(limit)
    .all<{ url: string }>();
  return results.map((row) => row.url);
}

// Saves where pull requests stand, and returns those whose state changed (one not saved before counts).
export async function setPrStates(env: DbEnv, states: { url: string; state: PrState }[]) {
  if (!states.length) return [];
  const urls = JSON.stringify(states.map(({ url }) => url));
  const { results } = await env.DB.prepare("SELECT url, state FROM pull_requests WHERE url IN (SELECT value FROM json_each(?))")
    .bind(urls)
    .all<{ url: string; state: PrState }>();
  const before = new Map(results.map((row) => [row.url, row.state]));
  // D1 takes 100 values in a statement, two a row.
  for (let from = 0; from < states.length; from += 40) {
    const chunk = states.slice(from, from + 40);
    await env.DB.prepare(
      `INSERT INTO pull_requests (url, state) VALUES ${chunk.map(() => "(?, ?)").join(", ")}
       ON CONFLICT (url) DO UPDATE SET state = excluded.state, synced_at = CURRENT_TIMESTAMP`,
    )
      .bind(...chunk.flatMap(({ url, state }) => [url, state]))
      .run();
  }
  return states.filter(({ url, state }) => before.get(url) !== state).map(({ url, state }): PrChange => ({ url, from: before.get(url), to: state }));
}

// Saves pull requests as open, those not saved before: linked with no word from GitHub on them. They
// are marked as read long ago, so the sync, which reads the oldest first, reads them next (see prsToSync).
export async function addOpenPrs(env: DbEnv, urls: string[]) {
  if (!urls.length) return;
  // "WHERE true" lets SQLite read ON CONFLICT as the upsert's, not the SELECT's join.
  await env.DB.prepare(
    "INSERT INTO pull_requests (url, state, synced_at) SELECT value, 'OPEN', '1970-01-01 00:00:00' FROM json_each(?) WHERE true ON CONFLICT (url) DO NOTHING",
  )
    .bind(JSON.stringify(urls))
    .run();
}

// Where those of `urls` saved stand, as { url: state }.
export async function prStatesOf(env: DbEnv, urls: string[]) {
  const { results } = await env.DB.prepare("SELECT url, state FROM pull_requests WHERE url IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(urls))
    .all<{ url: string; state: PrState }>();
  return Object.fromEntries(results.map((row) => [row.url, row.state]));
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

// The deployment's prompts, which `npm run prompts` saves (see scripts/prompts.ts); the Worker only reads
// them. `arguments` is JSON: [{ name, description, required }].
export type PromptRow = { name: string; title: string; description: string; arguments: string; text: string };

export async function prompts(env: DbEnv) {
  return (await env.DB.prepare("SELECT name, title, description, arguments, text FROM prompts ORDER BY name").all<PromptRow>()).results;
}

export async function promptByName(env: DbEnv, name: string) {
  return env.DB.prepare("SELECT name, title, description, arguments, text FROM prompts WHERE name = ?").bind(name).first<PromptRow>();
}

// Each prompt's name and hash, which change with the prompt: what the MCP server's version is made from.
export async function promptHashes(env: DbEnv) {
  const rows = (await env.DB.prepare("SELECT name, hash FROM prompts ORDER BY name").all<{ name: string; hash: string }>()).results;
  return rows.map((row) => `${row.name}:${row.hash}`).join(",");
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
