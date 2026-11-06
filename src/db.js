// Tasks are stored in D1 (the DB binding). Each is stored before its root
// message is posted; once posted, it is found by the message's channel and
// ts. The root message is rendered from the row
// after every change (see saveTask). The schema is in migrations/; the
// requirements table, and tasks' source_channel, source_thread_ts and
// source_link, are left from when a client channel could be paired, and no
// longer read.

// How many times Cade tries to post a root message before giving up: once
// when it is made, then on each retry (see retry.js).
export const POST_ATTEMPTS = 5;

// Returns the task whose root message is `ts`, or null if there is none or
// it was deleted. It comes with its releases, which its message shows.
export async function getTask(env, channel, ts) {
  const row = await env.DB.prepare(
    "SELECT * FROM tasks WHERE channel = ? AND ts = ? AND deleted_at IS NULL AND archived_at IS NULL",
  )
    .bind(channel, ts)
    .first();
  return row ? { ...taskFromRow(row), releases: await releasesOf(env, row.id) } : null;
}

// The title of the task whose root message is `ts`, archived or not, or null
// if there is none or it was deleted: what its pages are headed with.
export async function taskTitleOf(env, channel, ts) {
  const row = await env.DB.prepare("SELECT title FROM tasks WHERE channel = ? AND ts = ? AND deleted_at IS NULL")
    .bind(channel, ts)
    .first();
  return row ? row.title : null;
}

// The task's releases that aren't NOT_APPROVED, oldest first, as
// { id, prs, note, status, sentBy, sentAt, decidedBy, decidedAt }.
async function releasesOf(env, taskId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM releases WHERE task_id = ? AND status != 'NOT_APPROVED' ORDER BY id",
  )
    .bind(taskId)
    .all();
  return results.map((row) => ({
    id: row.id,
    prs: JSON.parse(row.prs),
    note: row.note,
    status: row.status,
    sentBy: row.sent_by,
    sentAt: row.sent_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    approver: row.approver,
    messageTs: row.message_ts,
  }));
}

// Stores a release of the task whose root message is `ts`, and returns its
// id. `release` is { prs, note, status, sentBy, decidedBy? }.
export async function insertRelease(env, channel, ts, release) {
  const { id } = await env.DB.prepare(
    `INSERT INTO releases (task_id, prs, note, status, sent_by, decided_by)
     SELECT id, ?, ?, ?, ?, ? FROM tasks WHERE channel = ? AND ts = ? AND deleted_at IS NULL AND archived_at IS NULL
     RETURNING id`,
  )
    .bind(JSON.stringify(release.prs), release.note, release.status, release.sentBy, release.decidedBy ?? null, channel, ts)
    .first();
  return id;
}

// Records the client's decision on a release waiting for one: APPROVED or
// NOT_APPROVED. Returns false if it was decided already, by another click.
export async function decideRelease(env, id, status, user) {
  const row = await env.DB.prepare(
    `UPDATE releases SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'PENDING_APPROVAL' RETURNING id`,
  )
    .bind(status, user, id)
    .first();
  return Boolean(row);
}

// Stores a new task that is about to be posted in `channel`, with `origin`,
// what follows the post (see publishTask), and returns its id.
export async function insertTask(env, channel, task, origin) {
  return insert(env, "tasks", channel, { ...taskToRow(task), origin: JSON.stringify(origin) });
}

// Records that the task's root message was posted as `ts`.
export async function markTaskPosted(env, id, ts, link) {
  await env.DB.prepare(
    `UPDATE tasks SET ts = ?, link = ?, origin = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(ts, link ?? null, id)
    .run();
}

// Saves a posted task.
export async function putTask(env, channel, ts, task) {
  await upsert(env, "tasks", channel, ts, taskToRow(task));
}

export async function markTaskDeleted(env, channel, ts) {
  await env.DB.prepare(
    "UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP WHERE channel = ? AND ts = ?",
  )
    .bind(channel, ts)
    .run();
}

// Stops tracking the task, keeping it for the summary's Archived section
// (see archive.js).
export async function markTaskArchived(env, channel, ts, user) {
  await env.DB.prepare(
    "UPDATE tasks SET archived_at = CURRENT_TIMESTAMP, archived_by = ? WHERE channel = ? AND ts = ?",
  )
    .bind(user, channel, ts)
    .run();
}

// The archived tasks in `channel` that weren't deleted since, as { ts,
// task, archivedAt, archivedBy }, most recently archived first: at most
// `limit`.
export async function archivedTasks(env, channel, limit) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE channel = ? AND ts IS NOT NULL AND deleted_at IS NULL AND archived_at IS NOT NULL
     ORDER BY archived_at DESC, id DESC LIMIT ?`,
  )
    .bind(channel, limit)
    .all();
  return results.map((row) => ({ ts: row.ts, task: taskFromRow(row), archivedAt: row.archived_at, archivedBy: row.archived_by }));
}

// Returns the task whose root message is `ts`, deleted, archived or not,
// with `deleted` saying whether it was deleted, or null if there is none. A deleted task's
// messages may still be in Slack, if deleting them failed.
export async function getTaskIncludingDeleted(env, channel, ts) {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE channel = ? AND ts = ?")
    .bind(channel, ts)
    .first();
  return row ? { ...taskFromRow(row), deleted: Boolean(row.deleted_at) } : null;
}

// The posted tasks of every channel with one of `statuses`, as { channel, ts,
// task }, oldest first. Deleted and archived tasks aren't included.
export async function tasksWithStatuses(env, statuses) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE ts IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL
       AND status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY ts`,
  )
    .bind(...statuses)
    .all();
  return results.map((row) => ({ channel: row.channel, ts: row.ts, task: taskFromRow(row) }));
}

// The posted tasks `user` has a role in, in any channel, as { channel, ts,
// task }, oldest first: `roles` are the ones to count (owner, reviewer,
// tester), `statuses` the ones to include. Deleted and archived tasks aren't.
export async function tasksOfUser(env, user, { roles, statuses }) {
  if (!/^[UW][A-Z0-9]+$/.test(user)) return [];
  const columns = { owner: "developers", reviewer: "reviewers", tester: "testers" };
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE ts IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL
       AND (${roles.map((role) => `${columns[role]} LIKE ?`).join(" OR ")})
       AND status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY ts`,
  )
    .bind(...roles.map(() => `%"${user}"%`), ...statuses)
    .all();
  return results.map((row) => ({ channel: row.channel, ts: row.ts, task: taskFromRow(row) }));
}

// The posted tasks in `channel` with one of `statuses`, as { ts, task },
// oldest first.
export async function tasksWithStatus(env, channel, statuses) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE channel = ? AND ts IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL
       AND status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY ts`,
  )
    .bind(channel, ...statuses)
    .all();
  return results.map((row) => ({ ts: row.ts, task: taskFromRow(row) }));
}

// The tasks whose root message Slack hasn't taken yet, as { id, channel,
// task, origin, attempts }, oldest first. Only those made a minute or more
// ago, so a post still under way isn't made twice.
export async function unpostedTasks(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE ts IS NULL AND deleted_at IS NULL AND created_at <= datetime('now', '-1 minute')
     ORDER BY id`,
  ).all();
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
export async function getHomeProject(env, user) {
  const row = await env.DB.prepare("SELECT home_project FROM user_preferences WHERE user_id = ?").bind(user).first();
  return row?.home_project ?? null;
}

export async function setHomeProject(env, user, project) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, home_project) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET home_project = excluded.home_project`,
  )
    .bind(user, project)
    .run();
}

// The Home tab view the person last used, or null.
export async function getHomeTab(env, user) {
  const row = await env.DB.prepare("SELECT home_tab FROM user_preferences WHERE user_id = ?").bind(user).first();
  return row?.home_tab ?? null;
}

export async function setHomeTab(env, user, tab) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, home_tab) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET home_tab = excluded.home_tab`,
  )
    .bind(user, tab)
    .run();
}

export async function getCanvas(env, channel) {
  const row = await env.DB.prepare("SELECT canvas_id FROM canvases WHERE channel = ?").bind(channel).first();
  return row?.canvas_id ?? null;
}

export async function putCanvas(env, channel, canvasId, user) {
  await env.DB.prepare(
    `INSERT INTO canvases (channel, canvas_id, created_by) VALUES (?, ?, ?)
     ON CONFLICT (channel) DO UPDATE SET canvas_id = excluded.canvas_id, created_by = excluded.created_by`,
  )
    .bind(channel, canvasId, user)
    .run();
}

// The hash of the markdown last written to the channel's canvas, or null.
export async function getCanvasHash(env, channel) {
  const row = await env.DB.prepare("SELECT content_hash FROM canvases WHERE channel = ?").bind(channel).first();
  return row?.content_hash ?? null;
}

export async function setCanvasHash(env, channel, hash) {
  await env.DB.prepare("UPDATE canvases SET content_hash = ? WHERE channel = ?").bind(hash, channel).run();
}

// Marks the channel's summary as out of date, under `token`. Only a channel
// with a canvas is marked, unless `create`: a group's first task adds its
// row, which has no canvas until the summary is rendered.
export async function markCanvasDirty(env, channel, token, create = false) {
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
export async function getCanvasDirty(env, channel) {
  const row = await env.DB.prepare("SELECT dirty_token FROM canvases WHERE channel = ?").bind(channel).first();
  return row?.dirty_token ?? null;
}

// Marks the summary up to date, unless it was marked again since `token`.
export async function clearCanvasDirty(env, channel, token) {
  await env.DB.prepare("UPDATE canvases SET dirty_token = NULL WHERE channel = ? AND dirty_token = ?")
    .bind(channel, token)
    .run();
}

// The channels whose summary is out of date, with the token each was marked with.
export async function dirtyCanvases(env) {
  const { results } = await env.DB.prepare("SELECT channel, dirty_token FROM canvases WHERE dirty_token IS NOT NULL").all();
  return results.map((row) => ({ channel: row.channel, token: row.dirty_token }));
}

export async function deleteCanvas(env, channel) {
  await env.DB.prepare("DELETE FROM canvases WHERE channel = ?").bind(channel).run();
}

// Executive summaries (see summaries.js and migrations/0020).

const summaryFromRow = (row) => ({
  id: row.id,
  project: row.project,
  createdBy: row.created_by,
  since: row.since,
  until: row.until,
  createdAt: row.created_at,
  publishedAt: row.published_at,
  docId: row.doc_id,
  docUrl: row.doc_url,
  docLines: row.doc_lines ? JSON.parse(row.doc_lines) : [],
  callNotes: row.call_notes,
  callBy: row.call_by,
  callAt: row.call_at,
});

// Starts the summary of `project` (its name), `draft` being { createdBy, since, until },
// and returns its id. It isn't one until recordSummaryDoc says it is in the doc.
export async function insertSummary(env, project, draft) {
  const { id } = await env.DB.prepare(
    "INSERT INTO executive_summaries (project, created_by, since, until, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(project, draft.createdBy, draft.since, draft.until, new Date().toISOString())
    .first();
  return id;
}

// The summary `id` (written to the doc or not), or null.
export async function getSummary(env, id) {
  const row = await env.DB.prepare("SELECT * FROM executive_summaries WHERE id = ?").bind(id).first();
  return row ? summaryFromRow(row) : null;
}

// The project's summaries in its doc, newest first: those written on or
// before `onOrBefore` (an ISO timestamp), if given, at most `limit`.
export async function summariesOf(env, project, { onOrBefore, limit = 10 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM executive_summaries
     WHERE project = ? AND published_at IS NOT NULL AND (? IS NULL OR created_at <= ?)
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(project, onOrBefore ?? null, onOrBefore ?? null, limit)
    .all();
  return results.map(summaryFromRow);
}

// The project's last summary in its doc, or null. Its `until` is where the next one's period starts.
export async function lastSummary(env, project) {
  return (await summariesOf(env, project, { limit: 1 }))[0] ?? null;
}

// Stores what a summary said of a task, in its BEFORE or AFTER version (`stage`): `item` is { channel,
// ts, kind, title, status, incident, included, health, progress, notes }; channel and ts are "" for
// something with no task.
export async function putSummaryItem(env, id, stage, item) {
  await env.DB.prepare(
    `INSERT INTO executive_summary_items (summary_id, stage, task_channel, task_ts, kind, title, status, incident, included, health, progress, notes, informed_at, informed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (summary_id, stage, task_channel, task_ts, title) DO UPDATE SET
       kind = excluded.kind, status = excluded.status, incident = excluded.incident,
       included = excluded.included, health = excluded.health, progress = excluded.progress, notes = excluded.notes,
       informed_at = excluded.informed_at, informed_by = excluded.informed_by`,
  )
    .bind(id, stage, item.channel ?? "", item.ts ?? "", item.kind, item.title, item.status ?? "", item.incident ? 1 : 0, item.included ? 1 : 0, item.health ?? null, item.progress ?? "", item.notes ?? "", item.informedAt ?? null, item.informedBy ?? null)
    .run();
}

// What the summary said of each task, as { before, after }: lists of items in the order stored (see
// putSummaryItem); `after` is empty until the call was recorded.
export async function summaryItems(env, id) {
  const { results } = await env.DB.prepare("SELECT * FROM executive_summary_items WHERE summary_id = ? ORDER BY rowid").bind(id).all();
  const items = { before: [], after: [] };
  for (const row of results) {
    items[row.stage === "AFTER" ? "after" : "before"].push({
      channel: row.task_channel,
      ts: row.task_ts,
      kind: row.kind,
      title: row.title,
      status: row.status,
      incident: Boolean(row.incident),
      included: Boolean(row.included),
      health: row.health,
      progress: row.progress,
      notes: row.notes,
      informedAt: row.informed_at,
      informedBy: row.informed_by,
    });
  }
  return items;
}

// Replaces the AFTER version of the summary with `items` (see putSummaryItem), and keeps what was said
// of the call as a whole. An item that is the same as it was in the AFTER version before keeps the
// time its thread was told about it; one that changed (or is new) has not been told.
export async function putSummaryAfter(env, id, items, { notes, user }) {
  const same = (a, b) => a.included === b.included && (a.health ?? null) === (b.health ?? null) && a.progress === b.progress && a.notes === b.notes;
  const earlier = new Map((await summaryItems(env, id)).after.map((item) => [`${item.channel}:${item.ts}:${item.title}`, item]));
  await env.DB.prepare("DELETE FROM executive_summary_items WHERE summary_id = ? AND stage = 'AFTER'").bind(id).run();
  for (const item of items) {
    const was = earlier.get(`${item.channel ?? ""}:${item.ts ?? ""}:${item.title}`);
    const kept = was && same(was, item) ? { informedAt: was.informedAt, informedBy: was.informedBy } : {};
    await putSummaryItem(env, id, "AFTER", { ...item, ...kept });
  }
  await env.DB.prepare("UPDATE executive_summaries SET call_notes = ?, call_by = ?, call_at = ? WHERE id = ?")
    .bind(notes ?? "", user, new Date().toISOString(), id)
    .run();
}

// Marks that the task's thread was told what the call decided about it in the summary `id`. Gives
// "marked", "already" (it was told before) or "none" (the AFTER version has no such task).
export async function markSummaryInformed(env, id, channel, ts, user) {
  const marked = await env.DB.prepare(
    `UPDATE executive_summary_items SET informed_at = ?, informed_by = ?
     WHERE summary_id = ? AND stage = 'AFTER' AND task_channel = ? AND task_ts = ? AND informed_at IS NULL RETURNING task_ts`,
  )
    .bind(new Date().toISOString(), user, id, channel, ts)
    .first();
  if (marked) return "marked";
  const exists = await env.DB.prepare("SELECT 1 AS found FROM executive_summary_items WHERE summary_id = ? AND stage = 'AFTER' AND task_channel = ? AND task_ts = ?")
    .bind(id, channel, ts)
    .first();
  return exists ? "already" : "none";
}

// Records that the summary was written to the doc `docId`, its tab being at
// `url`, with `lines`, the text of each line written. It is a summary from then on.
export async function recordSummaryDoc(env, id, docId, url, lines) {
  await env.DB.prepare("UPDATE executive_summaries SET published_at = ?, doc_id = ?, doc_url = ?, doc_lines = ? WHERE id = ?")
    .bind(new Date().toISOString(), docId, url, JSON.stringify(lines), id)
    .run();
}

// Removes a summary that couldn't be written to the doc.
export async function deleteSummary(env, id) {
  await env.DB.prepare("DELETE FROM executive_summary_items WHERE summary_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM executive_summaries WHERE id = ? AND published_at IS NULL").bind(id).run();
}

// Counts a post Slack refused, for the task `id`. After the last attempt it
// is given up: marked deleted, so it isn't tried again. Returns the attempts
// so far.
export async function countPostAttempt(env, id) {
  const { post_attempts: attempts } = await env.DB.prepare(
    `UPDATE tasks SET post_attempts = post_attempts + 1,
       deleted_at = CASE WHEN post_attempts + 1 >= ? THEN CURRENT_TIMESTAMP END
     WHERE id = ? RETURNING post_attempts`,
  )
    .bind(POST_ATTEMPTS, id)
    .first();
  return attempts;
}

async function insert(env, table, channel, row) {
  const columns = Object.keys(row);
  const { id } = await env.DB.prepare(
    `INSERT INTO ${table} (channel, ${columns.join(", ")})
     VALUES (?, ${columns.map(() => "?").join(", ")})
     RETURNING id`,
  )
    .bind(channel, ...Object.values(row))
    .first();
  return id;
}

// Writes `row` as the posted root message's row, adding it or replacing it.
async function upsert(env, table, channel, ts, row) {
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

function taskToRow(task) {
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
    completed_at: task.completedAt ?? "",
    source_incident: task.incident ? 1 : 0,
    has_subtasks: task.subtasks ? 1 : 0,
    link: task.link ?? null,
    notes_url: task.notes?.url ?? null,
    export_url: task.export?.url ?? null,
  };
}

function taskFromRow(row) {
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
    completedAt: row.completed_at,
    // Whether it is an incident: always urgent and due immediately.
    incident: Boolean(row.source_incident),
    // Whether it is done in parts, so no status changes are suggested for it.
    subtasks: Boolean(row.has_subtasks),
    link: row.link || undefined,
    // The address of the task's notes page on the Worker, once it has one (see notes.js).
    notes: row.notes_url ? { url: row.notes_url } : undefined,
    // Its thread's page, likewise (see export.js).
    export: row.export_url ? { url: row.export_url } : undefined,
  };
}

// Messages in a tracked task's thread, kept for good (see messages in
// migrations). Slack redelivers events, and a resync reads a thread again, so
// a message already kept is left as it is. Written several to a statement, as
// D1 allows 100 values in one and a Worker only so many queries.
const MESSAGE_ROWS = 14;

export async function addMessages(env, rows) {
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

export const addMessage = (env, row) => addMessages(env, [row]);

// A task's kept messages, oldest first, as { user, username, ts, text, files }.
export async function threadMessages(env, channel, taskTs) {
  const { results } = await env.DB.prepare("SELECT * FROM messages WHERE channel = ? AND task_ts = ? ORDER BY ts")
    .bind(channel, taskTs)
    .all();
  return results.map((row) => ({
    user: row.user_id ?? undefined,
    username: row.username ?? undefined,
    ts: row.ts,
    text: row.text,
    files: row.files ? JSON.parse(row.files) : undefined,
  }));
}

// The task's notes page: { summary, summaryBy, summaryAt, body, updatedBy,
// updatedAt }, empty for a task with none yet.
export async function getNotes(env, channel, taskTs) {
  const row = await env.DB.prepare("SELECT * FROM task_notes WHERE channel = ? AND task_ts = ?").bind(channel, taskTs).first();
  return {
    summary: row?.summary ?? "",
    summaryBy: row?.summary_by ?? undefined,
    summaryAt: row?.summary_at ?? undefined,
    body: row?.body ?? "",
    updatedBy: row?.updated_by ?? undefined,
    updatedAt: row?.updated_at ?? undefined,
  };
}

// The notes pages of many tasks (`keys`: [{ channel, ts }]) as a Map from
// "channel:ts" to { summary, summaryBy, body }; a task with none is absent.
// D1 takes few values per query, so it asks in chunks.
export async function notesOf(env, keys) {
  const found = new Map();
  for (let i = 0; i < keys.length; i += 40) {
    const chunk = keys.slice(i, i + 40);
    const { results } = await env.DB.prepare(`SELECT * FROM task_notes WHERE ${chunk.map(() => "(channel = ? AND task_ts = ?)").join(" OR ")}`)
      .bind(...chunk.flatMap(({ channel, ts }) => [channel, ts]))
      .all();
    for (const row of results) found.set(`${row.channel}:${row.task_ts}`, { summary: row.summary ?? "", summaryBy: row.summary_by ?? "", body: row.body ?? "" });
  }
  return found;
}

// Replaces the summary an AI agent wrote for `user`.
export async function putSummary(env, channel, taskTs, summary, user) {
  await env.DB.prepare(
    `INSERT INTO task_notes (channel, task_ts, summary, summary_by, summary_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (channel, task_ts) DO UPDATE SET summary = excluded.summary, summary_by = excluded.summary_by, summary_at = CURRENT_TIMESTAMP`,
  )
    .bind(channel, taskTs, summary, user)
    .run();
}

// Replaces the notes people write, as edited by `user`.
export async function putNotesBody(env, channel, taskTs, body, user) {
  await env.DB.prepare(
    `INSERT INTO task_notes (channel, task_ts, body, updated_by, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (channel, task_ts) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(channel, taskTs, body, user)
    .run();
}

// Names of Slack users, as a Map of the ones kept: the name, and whether it was looked up more than
// `staleAfterDays` ago and so is worth asking Slack about again.
export async function keptNames(env, ids, staleAfterDays = Infinity) {
  const names = new Map();
  for (const id of ids) {
    const row = await env.DB.prepare("SELECT name, updated_at < datetime('now', ?) AS stale FROM user_names WHERE user_id = ?")
      .bind(`-${Number.isFinite(staleAfterDays) ? staleAfterDays : 100000} days`, id)
      .first();
    if (row) names.set(id, { name: row.name, stale: Boolean(row.stale) });
  }
  return names;
}

export async function keepName(env, id, name) {
  await env.DB.prepare(
    `INSERT INTO user_names (user_id, name) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(id, name)
    .run();
}

// Keeps the hash of a web sign-in token for `user`: a 'login' for `minutes`,
// a 'session' for `minutes` too. Old and used ones are cleared as new are made.
export async function putWebToken(env, hash, user, kind, minutes) {
  await env.DB.prepare("DELETE FROM web_tokens WHERE expires_at < datetime('now')").run();
  if (kind === "login") await env.DB.prepare("DELETE FROM web_tokens WHERE user_id = ? AND kind = 'login'").bind(user).run();
  await env.DB.prepare("INSERT INTO web_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, datetime('now', ?))")
    .bind(hash, user, kind, `+${minutes} minutes`)
    .run();
}

// The user a live token of this kind belongs to, or null. A 'login' is used
// up by being looked up.
export async function webTokenUser(env, hash, kind) {
  const sql =
    kind === "login"
      ? "DELETE FROM web_tokens WHERE token_hash = ? AND kind = ? AND expires_at > datetime('now') RETURNING user_id"
      : "SELECT user_id FROM web_tokens WHERE token_hash = ? AND kind = ? AND expires_at > datetime('now')";
  const row = await env.DB.prepare(sql).bind(hash, kind).first();
  return row ? row.user_id : null;
}

export async function deleteWebToken(env, hash) {
  await env.DB.prepare("DELETE FROM web_tokens WHERE token_hash = ?").bind(hash).run();
}

// Ends every sign-in of `user`, the browsers' sessions and any sign-in link not used yet;
// returns how many sessions there were.
export async function deleteWebTokensOf(env, user) {
  const { results } = await env.DB.prepare("DELETE FROM web_tokens WHERE user_id = ? RETURNING kind").bind(user).all();
  return results.filter((row) => row.kind === "session").length;
}

// Keeps `hash` as the MCP token of `user`, in place of any they had.
export async function putMcpToken(env, user, hash) {
  await env.DB.prepare(
    `INSERT INTO mcp_tokens (user_id, token_hash) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = CURRENT_TIMESTAMP`,
  )
    .bind(user, hash)
    .run();
}

// Whether the user has an MCP token.
// When the user's API key was made, in SQLite's datetime form, or null.
export async function mcpTokenCreated(env, user) {
  return (await env.DB.prepare("SELECT created_at FROM mcp_tokens WHERE user_id = ?").bind(user).first())?.created_at ?? null;
}

export async function hasMcpToken(env, user) {
  return Boolean(await env.DB.prepare("SELECT 1 AS found FROM mcp_tokens WHERE user_id = ?").bind(user).first());
}

// The user whose MCP token has this hash, or null.
export async function mcpTokenUser(env, hash) {
  const row = await env.DB.prepare("SELECT user_id FROM mcp_tokens WHERE token_hash = ?").bind(hash).first();
  return row ? row.user_id : null;
}

// Removes the user's MCP token, and returns whether they had one.
export async function deleteMcpToken(env, user) {
  const row = await env.DB.prepare("DELETE FROM mcp_tokens WHERE user_id = ? RETURNING user_id").bind(user).first();
  return Boolean(row);
}

// The settings changed in the project settings form, as { channel, key, value (JSON) }.
export async function projectSettings(env) {
  const { results } = await env.DB.prepare("SELECT channel, key, value FROM project_settings").all();
  return results;
}

export async function setProjectSetting(env, channel, key, value, user) {
  await env.DB.prepare(
    `INSERT INTO project_settings (channel, key, value, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (channel, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(channel, key, JSON.stringify(value), user)
    .run();
}

export async function clearProjectSetting(env, channel, key) {
  await env.DB.prepare("DELETE FROM project_settings WHERE channel = ? AND key = ?").bind(channel, key).run();
}

// The projects added with `/cade project init`, as { channel, name }.
export async function addedProjects(env) {
  const { results } = await env.DB.prepare("SELECT channel, name FROM projects ORDER BY rowid").all();
  return results;
}

export async function addProject(env, channel, name, user) {
  await env.DB.prepare("INSERT INTO projects (channel, name, created_by) VALUES (?, ?, ?)").bind(channel, name, user).run();
}

// The releases of many tasks (`keys`: [{ channel, ts }]) as a Map from "channel:ts" to their
// releases, as getTask gives them (those not NOT_APPROVED); a task with none is absent. D1 takes few
// values per query, so it asks in chunks.
export async function releasesOfTasks(env, keys) {
  const found = new Map();
  for (let i = 0; i < keys.length; i += 40) {
    const chunk = keys.slice(i, i + 40);
    const { results } = await env.DB.prepare(
      `SELECT r.*, t.channel AS task_channel, t.ts AS task_ts FROM releases r JOIN tasks t ON t.id = r.task_id
       WHERE r.status != 'NOT_APPROVED' AND (${chunk.map(() => "(t.channel = ? AND t.ts = ?)").join(" OR ")}) ORDER BY r.id`,
    )
      .bind(...chunk.flatMap(({ channel, ts }) => [channel, ts]))
      .all();
    for (const row of results) {
      const key = `${row.task_channel}:${row.task_ts}`;
      found.set(key, [...(found.get(key) ?? []), releaseFromRow(row)]);
    }
  }
  return found;
}

// The releases with one of `statuses` (PENDING_APPROVAL, APPROVED, NOT_APPROVED) of the posted tasks
// not deleted or archived, oldest first, as { channel, ts, title, release }.
export async function releasesWithStatus(env, statuses) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, t.channel AS task_channel, t.ts AS task_ts, t.title AS task_title FROM releases r JOIN tasks t ON t.id = r.task_id
     WHERE t.ts IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL AND r.status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY r.id`,
  )
    .bind(...statuses)
    .all();
  return results.map((row) => ({ channel: row.task_channel, ts: row.task_ts, title: row.task_title, release: releaseFromRow(row) }));
}

function releaseFromRow(row) {
  return {
    approver: row.approver,
    messageTs: row.message_ts,
    id: row.id,
    prs: JSON.parse(row.prs),
    note: row.note,
    status: row.status,
    sentBy: row.sent_by,
    sentAt: row.sent_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

// Remembers where a release's request was posted and who approves it.
export async function setReleaseMessage(env, id, messageTs, approver) {
  await env.DB.prepare("UPDATE releases SET message_ts = ?, approver = ? WHERE id = ?").bind(messageTs, approver, id).run();
}

// The release with `id` and the task it belongs to, as { channel, ts, title, release }, or null (also
// when the task was deleted or archived).
export async function releaseById(env, id) {
  const row = await env.DB.prepare(
    `SELECT r.*, t.channel AS task_channel, t.ts AS task_ts, t.title AS task_title FROM releases r JOIN tasks t ON t.id = r.task_id
     WHERE r.id = ? AND t.ts IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL`,
  )
    .bind(id)
    .first();
  return row ? { channel: row.task_channel, ts: row.task_ts, title: row.task_title, release: releaseFromRow(row) } : null;
}

// Changes the PRs and note of a release still waiting for approval; false if it is not any more
// (it was decided meanwhile).
export async function changeRelease(env, id, prs, note) {
  const row = await env.DB.prepare("UPDATE releases SET prs = ?, note = ? WHERE id = ? AND status = 'PENDING_APPROVAL' RETURNING id")
    .bind(JSON.stringify(prs), note, id)
    .first();
  return Boolean(row);
}
