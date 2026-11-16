// What Cade keeps of a task's thread: its messages, the working summary agents keep of them, and how far
// each agent's consumer has read (see get_task_history and get_task_summary in mcp/history.ts).
import type { DbEnv } from "./common.ts";

export interface MessageRow {
  channel: string;
  taskTs: string;
  ts: string;
  userId?: string | null;
  username?: string | null;
  text?: string | null;
  files?: { name?: string; permalink?: string }[] | null;
}

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

// The task's working summary, which AI agents keep (see get_task_summary in mcp/history.ts): { summary,
// through, by, at }, `through` being the ts of the last message of the task's thread it covers, or null
// for a task with none yet.
export async function getSummary(env: DbEnv, channel: string, taskTs: string) {
  const row = await env.DB.prepare(
    "SELECT summary, through_ts, written_by, written_at FROM task_summaries WHERE channel = ? AND task_ts = ?",
  )
    .bind(channel, taskTs)
    .first<SummaryRow>();
  return row ? { summary: row.summary, through: row.through_ts, by: row.written_by, at: row.written_at } : null;
}

// Saves the task's working summary, written by `user` and covering its thread up to `through`, unless
// the one saved covers more of it: two agents can work on it at once, and the later one wins. Returns
// whether it was saved.
export async function putSummary(
  env: DbEnv,
  channel: string,
  taskTs: string,
  summary: string,
  through: string,
  user: string,
) {
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

// How far `consumer` has read the task's thread (see get_task_history in mcp/history.ts): { through, by, at },
// `through` being the ts of the last message it acknowledged, or null for one that never did.
export async function getConsumer(env: DbEnv, channel: string, taskTs: string, consumer: string) {
  const row = await env.DB.prepare(
    "SELECT through_ts, acked_by, acked_at FROM task_consumers WHERE channel = ? AND task_ts = ? AND consumer = ?",
  )
    .bind(channel, taskTs, consumer)
    .first<{ through_ts: string; acked_by: string; acked_at: string }>();
  return row ? { through: row.through_ts, by: row.acked_by, at: row.acked_at } : null;
}

// The most consumers a task keeps a position for, so the table stays small.
export const MAX_CONSUMERS = 10;

// Moves `consumer`'s position in the task's thread on to `through`, for `user`. Returns "saved", or "behind"
// when it is past that already (positions only move forward), or "full" for a new consumer of a task that has
// MAX_CONSUMERS already.
export async function putConsumer(
  env: DbEnv,
  channel: string,
  taskTs: string,
  consumer: string,
  through: string,
  user: string,
) {
  const known = await getConsumer(env, channel, taskTs, consumer);
  if (!known) {
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM task_consumers WHERE channel = ? AND task_ts = ?")
      .bind(channel, taskTs)
      .first<{ n: number }>())!;
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
