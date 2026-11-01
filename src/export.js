import { findProject } from "./channels.js";
import { addPendingMessage, deletePendingMessages, pendingMessages, putTask, setExportSynced, tasksWithPending } from "./db.js";
import { docId } from "./doc.js";
import { callGoogle, googleEnabled } from "./google.js";
import { formatTime } from "./sheet.js";
import { callSlack } from "./slack.js";
import { loadTask, taskMessage } from "./tasks.js";

// A backup of each task's thread: plain text, in a page of its own in its
// project's Google Doc, to give to whatever summarizes it. Slack's free plan
// hides messages after 90 days, so the page is the long-term copy. Like a
// task's notes page (see notes.js) it is a tab under a tab of the Doc, here
// Export, but Cade writes this one. The task keeps the page's address and
// `synced`, the ts of the newest message on it (`export` on the task, see
// db.js).
//
// Messages are written as they come: a message in a tracked thread waits in
// pending_messages (bufferMessage), and the cron appends the waiting ones to
// their pages in batches and forgets them (flushPending). A new task's page is
// made as the task is (addExport); `/cade resync <link>` makes one for a task
// that has none, or whose page isn't known to be up to date (syncExport):
// either way the thread is read from Slack and written whole, and `synced` is
// set to its newest message, so what follows is only appended. It all goes
// through the Google web app (see google.js, google/Doc.gs).
export const EXPORT_TAB = "Export";

// The tab's title: the task's own, then " (thread)", as the title of a tab
// must be unique in the whole doc and the task's notes page (see notes.js) has
// the task's own. Kept to the 50 characters Google Docs allows in one (longer
// ones make addDocumentTab fail).
const TAB_TITLE_MAX = 50;
const TAB_SUFFIX = " (thread)";
const PAGE = 200;
const MAX_PAGES = 5;

export function tabTitle(task) {
  const room = TAB_TITLE_MAX - TAB_SUFFIX.length;
  const title = task.title.replace(/\s+/g, " ").trim();
  return `${title.length > room ? `${title.slice(0, room - 1).trimEnd()}…` : title}${TAB_SUFFIX}`;
}

async function readThread(env, channel, ts) {
  const messages = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await callSlack(env, "conversations.replies", { channel, ts, limit: PAGE, cursor });
    messages.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return messages;
}

// Display names for the Slack user IDs, looked up once each, as a Map. For an
// ID that can't be (no users:read scope, or one Slack doesn't know) the ID
// itself stands in.
async function nameMap(env, ids) {
  const names = new Map();
  await Promise.all(
    [...ids].map(async (id) => {
      try {
        const { user } = await callSlack(env, "users.info", { user: id });
        names.set(id, user.profile?.display_name || user.real_name || user.name || id);
      } catch (error) {
        console.warn("Could not look up user", { id, error: error.message });
        names.set(id, id);
      }
    }),
  );
  return names;
}

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// Slack's markup as plain text: mentions and channels by name, links as
// "label (address)", and the escaped &, < and > as themselves.
export function plain(text, names) {
  return text
    .replace(MENTION, (_, id) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The user IDs in `messages`: their authors and whoever they mention.
function userIds(messages, ids = new Set()) {
  for (const message of messages) {
    if (message.user) ids.add(message.user);
    for (const [, id] of (message.text ?? "").matchAll(MENTION)) ids.add(id);
  }
  return ids;
}

// A block per message, "Name · time" and its text.
function blocks(env, messages, names) {
  return messages.map((message) => {
    const who = message.user ? names.get(message.user) : (message.username ?? message.bot_profile?.name ?? "Someone");
    const when = formatTime(env, new Date(Number(message.ts) * 1000));
    let text = plain(message.text ?? "", names);
    if (message.files?.length) text += `${text ? "\n" : ""}(attachment: ${message.files.map((file) => (file.permalink ? `${file.name} ${file.permalink}` : file.name)).join(", ")})`;
    return `${who} · ${when}\n${text || "(no text)"}`;
  });
}

const heading = (task) => `Thread: ${task.title}\n\n`;

export async function threadText(env, channel, ts, task) {
  const messages = await readThread(env, channel, ts);
  const names = await nameMap(env, userIds(messages));
  return `${heading(task)}${blocks(env, messages, names).join("\n\n")}`;
}

function docOf(env, channel) {
  const id = docId(findProject(env, channel)?.doc);
  return id && googleEnabled(env) ? id : null;
}

// Writes `messages` (oldest first) after what's on the task's page, and
// records the newest as synced.
async function appendMessages(env, channel, ts, task, messages, names) {
  const id = docOf(env, channel);
  await callGoogle(env, { action: "doc.append", docId: id, tabId: task.export.tab, text: `\n\n${blocks(env, messages, names).join("\n\n")}` });
  const synced = messages.at(-1).ts;
  task.export.synced = synced;
  await setExportSynced(env, channel, ts, synced);
}

// Writes the task's thread to its page in the project's Doc, making the page
// if it has none, records its address and `synced` on the task, stores the
// task and returns the address. Returns null for a project without a `doc`,
// or without the Google web app. Throws if Slack or Google fails.
export async function exportThread(env, channel, ts, task) {
  const id = docOf(env, channel);
  if (!id) return null;
  const messages = await readThread(env, channel, ts);
  const names = await nameMap(env, userIds(messages));
  const text = `${heading(task)}${blocks(env, messages, names).join("\n\n")}`;
  const { url, tabId } = await callGoogle(env, {
    action: "doc.export",
    docId: id,
    parent: EXPORT_TAB,
    title: tabTitle(task),
    tabId: task.export?.tab,
    text,
  });
  task.export = { url, tab: tabId, synced: messages.at(-1)?.ts ?? ts };
  await putTask(env, channel, ts, task);
  return url;
}

// Makes the task's page and writes its thread, unless the page is known to be
// up to date (it has `synced`). Nothing is stored beyond that, and a failure
// is logged, not thrown, as the page is an extra: the task is still kept, and
// `/cade resync` tries again.
export async function syncExport(env, channel, ts, task) {
  if (task.export?.synced) return;
  try {
    await exportThread(env, channel, ts, task);
  } catch (error) {
    console.warn("Could not write the task's thread to the Doc", { ts, error: error.message });
  }
}

// For a task just posted: makes its page, then redraws the card with its link.
export async function addExport(env, channel, ts, task) {
  await syncExport(env, channel, ts, task);
  if (!task.export) return;
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
}

// Messages that are written to the Doc: people's, and Cade's and other
// apps', but not joins, edits and the like.
const KEPT_SUBTYPES = new Set([undefined, "bot_message", "thread_broadcast", "file_share"]);

// Adds a reply in a tracked task's thread to the messages waiting to be
// written to the Doc (see flushPending). Nothing is sent to Slack or Google,
// so it is quick enough for the event itself. Does nothing for a project
// without a Doc.
export async function bufferMessage(env, event) {
  if (!event.thread_ts || event.thread_ts === event.ts || !KEPT_SUBTYPES.has(event.subtype)) return;
  if (!docOf(env, event.channel) || !(await loadTask(env, event.channel, event.thread_ts))) return;
  await addPendingMessage(env, {
    channel: event.channel,
    taskTs: event.thread_ts,
    ts: event.ts,
    userId: event.user,
    username: event.username ?? event.bot_profile?.name,
    text: event.text,
    files: event.files?.map((file) => ({ name: file.name, permalink: file.permalink })),
  });
}

// How many tasks one run of the cron writes; the rest wait for the next.
const FLUSH_TASKS = 20;

// The cron: writes the waiting messages to the tasks' pages, one write per
// task, and forgets them. Each person is looked up once for the whole batch.
// A task whose write fails keeps its messages for the next run. With `only`,
// `{ channel, ts }`, just that task's are written (see resync.js).
export async function flushPending(env, only) {
  const due = [];
  const tasks = only ? [{ channel: only.channel, task_ts: only.ts }] : await tasksWithPending(env, FLUSH_TASKS);
  for (const { channel, task_ts: ts } of tasks) {
    const task = await loadTask(env, channel, ts);
    if (!task || !docOf(env, channel)) {
      await deletePendingMessages(env, channel, ts, "~");
      continue;
    }
    const waiting = await pendingMessages(env, channel, ts);
    // A task with no page, or one not known to be up to date, waits for
    // `/cade resync` (see syncExport).
    if (!task.export?.synced) continue;
    const fresh = waiting.filter((message) => message.ts > task.export.synced);
    if (!fresh.length) {
      await deletePendingMessages(env, channel, ts, "~");
      continue;
    }
    due.push({ channel, ts, task, waiting, fresh });
  }
  if (!due.length) return;
  const names = await nameMap(env, due.reduce((ids, { fresh }) => userIds(fresh, ids), new Set()));
  for (const { channel, ts, task, waiting, fresh } of due) {
    try {
      await appendMessages(env, channel, ts, task, fresh, names);
      await deletePendingMessages(env, channel, ts, waiting.at(-1).ts);
    } catch (error) {
      console.warn("Could not write a thread to the Doc", { channel, ts, error: error.message });
    }
  }
  console.log("Wrote threads to the Doc", { tasks: due.length });
}
