import { addMessage, addMessages, keepName, keptNames, putTask } from "./db.ts";
import { threadUrl } from "./links.ts";
import { syncNotes } from "./notes.ts";
import { callSlack } from "./slack.ts";
import { loadTask, taskMessage } from "./tasks.ts";
import type { AppEnv } from "./env.ts";
import type { SlackEvent, SlackMessage, Task } from "./types.ts";

// A backup of each task's thread, kept in the database. Slack's free plan hides
// messages after 90 days, so this is the long-term copy; the thread's page on
// the Worker (see web.ts) shows it, and the task's card links to that page.
// The task keeps the page's address (`export` on the task, see db.ts).
//
// Messages are written as they come: a reply in a tracked thread is stored by
// the event itself (recordMessage). A new task's thread is read from Slack as
// the task is made (addPages), and `/cade resync <link>` reads it again for a
// task whose thread may have gaps (syncExport): what is stored already is left
// as it is, so it is safe to run any number of times.
const PAGE = 200;
const MAX_PAGES = 5;

async function readThread(env: AppEnv, channel: string, ts: string) {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await callSlack(env, "conversations.replies", { channel, ts, limit: PAGE, cursor });
    messages.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return messages;
}

// How long a kept name is trusted before Slack is asked again, in case the person was renamed.
export const NAME_REFRESH_DAYS = 30;

// Display names for the Slack user IDs, as a Map: the ones kept from an earlier
// look-up, and the rest looked up once each (and kept). A kept name older than
// NAME_REFRESH_DAYS is looked up again; if that fails (the person has left Slack)
// the name stays, and is not asked about again for another NAME_REFRESH_DAYS.
// For an ID that can't be named (no users:read scope, or one Slack doesn't know)
// the ID itself stands in.
export async function nameMap(env: AppEnv, ids: Iterable<string>) {
  const kept = await keptNames(env, ids, NAME_REFRESH_DAYS);
  const names = new Map([...kept].map(([id, { name }]) => [id, name]));
  await Promise.all(
    [...ids]
      .filter((id) => !kept.has(id) || kept.get(id)!.stale)
      .map(async (id) => {
        try {
          const { user } = await callSlack(env, "users.info", { user: id });
          const name = user.profile?.display_name || user.real_name || user.name || id;
          names.set(id, name);
          await keepName(env, id, name);
        } catch (error) {
          console.warn("Could not look up user", { id, error: error.message });
          if (kept.has(id)) await keepName(env, id, kept.get(id)!.name);
          else names.set(id, id);
        }
      }),
  );
  return names;
}

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

// Slack's markup as plain text: mentions and channels by name, links as
// "label (address)", and the escaped &, < and > as themselves.
export function plain(text: string, names: Map<string, string>) {
  return text
    .replace(MENTION, (_: string, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The user IDs in `messages`: their authors and whoever they mention.
export function userIds(messages: { user?: string; text?: string }[], ids = new Set<string>()) {
  for (const message of messages) {
    if (message.user) ids.add(message.user);
    for (const [, id] of (message.text ?? "").matchAll(MENTION)) ids.add(id);
  }
  return ids;
}

// Stores the messages of a thread read from Slack.
async function keep(env: AppEnv, channel: string, ts: string, messages: SlackMessage[]) {
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
export async function syncExport(env: AppEnv, channel: string, ts: string, task: Task) {
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
export async function addPages(env: AppEnv, channel: string, ts: string, task: Task) {
  syncNotes(env, channel, ts, task);
  await syncExport(env, channel, ts, task);
  if (!task.notes && !task.export) return;
  await putTask(env, channel, ts, task);
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
}

// Messages that are kept: people's, and Cade's and other apps', but not joins,
// edits and the like.
const KEPT_SUBTYPES = new Set<string | undefined>([undefined, "bot_message", "thread_broadcast", "file_share"]);

// Stores a reply in a tracked task's thread. Nothing is sent to Slack, so it
// is quick enough for the event itself.
export async function recordMessage(env: AppEnv, event: SlackEvent) {
  if (!event.thread_ts || event.thread_ts === event.ts || !KEPT_SUBTYPES.has(event.subtype)) return;
  if (!(await loadTask(env, event.channel!, event.thread_ts))) return;
  await addMessage(env, {
    channel: event.channel!,
    taskTs: event.thread_ts,
    ts: event.ts!,
    userId: event.user,
    username: event.username ?? event.bot_profile?.name,
    text: event.text,
    files: event.files?.map((file: { name?: string; permalink?: string }) => ({ name: file.name, permalink: file.permalink })),
  });
}
