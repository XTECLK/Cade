import { addMessage, addMessages, keepName, keptNames, putTask } from "./db.js";
import { threadUrl } from "./links.js";
import { syncNotes } from "./notes.js";
import { callSlack } from "./slack.js";
import { loadTask, taskMessage } from "./tasks.js";

// A backup of each task's thread, kept in the database. Slack's free plan hides
// messages after 90 days, so this is the long-term copy; the thread's page on
// the Worker (see web.js) shows it, and the task's card links to that page.
// The task keeps the page's address (`export` on the task, see db.js).
//
// Messages are written as they come: a reply in a tracked thread is stored by
// the event itself (recordMessage). A new task's thread is read from Slack as
// the task is made (addPages), and `/cade resync <link>` reads it again for a
// task whose thread may have gaps (syncExport): what is stored already is left
// as it is, so it is safe to run any number of times.
const PAGE = 200;
const MAX_PAGES = 5;

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

// Display names for the Slack user IDs, as a Map: the ones kept from an earlier
// look-up, and the rest looked up once each (and kept). For an ID that can't be
// (no users:read scope, or one Slack doesn't know) the ID itself stands in.
export async function nameMap(env, ids) {
  const names = await keptNames(env, ids);
  await Promise.all(
    [...ids]
      .filter((id) => !names.has(id))
      .map(async (id) => {
        try {
          const { user } = await callSlack(env, "users.info", { user: id });
          const name = user.profile?.display_name || user.real_name || user.name || id;
          names.set(id, name);
          await keepName(env, id, name);
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
export function userIds(messages, ids = new Set()) {
  for (const message of messages) {
    if (message.user) ids.add(message.user);
    for (const [, id] of (message.text ?? "").matchAll(MENTION)) ids.add(id);
  }
  return ids;
}

// Stores the messages of a thread read from Slack.
async function keep(env, channel, ts, messages) {
  await addMessages(
    env,
    messages
      .filter((message) => KEPT_SUBTYPES.has(message.subtype))
      .map((message) => ({
        channel,
        taskTs: ts,
        ts: message.ts,
        userId: message.user,
        username: message.username ?? message.bot_profile?.name,
        text: message.text,
        files: message.files?.map((file) => ({ name: file.name, permalink: file.permalink })),
      })),
  );
}

// Reads the task's thread from Slack and stores what isn't stored yet, and
// gives the task the link to its page, in `task.export` (the caller saves the
// task). A failure is logged, not thrown, as the page is an extra: the task is
// still kept, and `/cade resync` tries again.
export async function syncExport(env, channel, ts, task) {
  try {
    await keep(env, channel, ts, await readThread(env, channel, ts));
  } catch (error) {
    console.warn("Could not store the task's thread", { ts, error: error.message });
  }
  if (task.export) return;
  const url = threadUrl(env, channel, ts);
  if (url) task.export = { url };
}

// For a task just posted: stores its thread, gives it the links to its notes
// page and its thread's, then saves it and redraws the card with them.
export async function addPages(env, channel, ts, task) {
  syncNotes(env, channel, ts, task);
  await syncExport(env, channel, ts, task);
  if (!task.notes && !task.export) return;
  await putTask(env, channel, ts, task);
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
}

// Messages that are kept: people's, and Cade's and other apps', but not joins,
// edits and the like.
const KEPT_SUBTYPES = new Set([undefined, "bot_message", "thread_broadcast", "file_share"]);

// Stores a reply in a tracked task's thread. Nothing is sent to Slack, so it
// is quick enough for the event itself.
export async function recordMessage(env, event) {
  if (!event.thread_ts || event.thread_ts === event.ts || !KEPT_SUBTYPES.has(event.subtype)) return;
  if (!(await loadTask(env, event.channel, event.thread_ts))) return;
  await addMessage(env, {
    channel: event.channel,
    taskTs: event.thread_ts,
    ts: event.ts,
    userId: event.user,
    username: event.username ?? event.bot_profile?.name,
    text: event.text,
    files: event.files?.map((file) => ({ name: file.name, permalink: file.permalink })),
  });
}
