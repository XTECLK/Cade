// Reading Slack for the MCP tools: get_thread_history, get_channels and get_channel_threads, and how a
// thread's messages are given.
import { isMember, readableName } from "../access.ts";
import { projects } from "../channels.ts";
import { MOVED_REACTION } from "../commands/move.ts";
import { tasksMovedFrom } from "../db.ts";
import { DEFAULT_CHANNELS, DEFAULT_DAYS, DEFAULT_THREADS, MAX_CHANNELS, MAX_DAYS, MAX_PREVIEW, MAX_THREADS } from "../mcp-tools.ts";
import { callSlack, linkedThread, type SlackChannel } from "../slack.ts";
import type { GetChannelThreadsArgs, GetChannelsArgs, GetThreadHistoryArgs } from "../mcp-args.ts";
import type { AppEnv } from "../env.ts";
import type { SlackMessage } from "../types.ts";
import { ToolError, PAGE, MAX_PAGES, threadOf, threadIdOf, readableChannel } from "./common.ts";

// A message of a thread: from Slack, or as Cade kept it.
type ThreadMessage = { ts: string; user?: string; username?: string; bot_id?: string; text?: string; files?: { name?: string }[] };

// Reads a thread: every message of it, oldest first, up to MAX_PAGES pages.
async function readReplies(env: AppEnv, channel: string, ts: string) {
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

// A thread is read for someone in its channel, or for anyone who can read a task it was moved into:
// the team brought that conversation into the task, and its summary needs the rest of it.
export async function getThreadHistory(env: AppEnv, user: string, { thread_id: threadId, link }: GetThreadHistoryArgs) {
  const { channel, ts } = threadId !== undefined ? threadIdOf(threadId) : threadOf(link);
  return readSlackThread(env, user, channel, ts, () => movedIntoReadableTask(env, user, channel, ts));
}

// Whether the thread `channel`/`ts` was moved into a task whose channel `user` can read.
async function movedIntoReadableTask(env: AppEnv, user: string, channel: string, ts: string) {
  for (const task of await tasksMovedFrom(env, channel, ts)) {
    const from = movedFromOf(task.text);
    if (from?.channel === channel && from.ts === ts && (await readableName(env, task.channel, user)) !== null) return true;
  }
  return false;
}

// A thread read from Slack for `user`, as text, or a ToolError for why not.
async function readSlackThread(env: AppEnv, user: string, channel: string, ts: string, allowed?: () => Promise<boolean>) {
  const info = await readableChannel(env, user, channel, allowed);

  let messages: SlackMessage[];
  try {
    messages = await asMember(env, info, channel, () => readReplies(env, channel, ts));
  } catch (error) {
    if (/thread_not_found|message_not_found/.test(error.message)) throw new ToolError("I couldn't find that thread. It may have been deleted.");
    if (/not_in_channel/.test(error.message)) throw new ToolError("Cade isn't in that channel, so I can't read it: read it with your own Slack tools, as the person, if you can.");
    throw new ToolError(`Slack wouldn't give me that thread (${error.message}).`);
  }

  const text = [`Thread in #${info.name ?? channel} (${channel}), ${messages.length} message${messages.length === 1 ? "" : "s"}, oldest first:`, ...messageLines(messages)].join("\n");
  return { text, data: { thread_id: `${channel}:${ts}`, channel_name: info.name ?? channel, messages: messageData(messages) } };
}

// Runs a Slack call that needs Cade in `channel`. Anyone can join a public channel, so when the
// person is in one and Cade isn't, it joins, and runs the call again.
async function asMember<T>(env: AppEnv, info: SlackChannel, channel: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (info.is_private || !/not_in_channel/.test(error.message)) throw error;
    await callSlack(env, "conversations.join", { channel });
    return run();
  }
}

// Checks that `user` may read a thread and that it is there, with Cade in its channel to post in it, or a ToolError.
export async function reachableThread(env: AppEnv, user: string, channel: string, ts: string) {
  const info = await readableChannel(env, user, channel);
  try {
    await asMember(env, info, channel, () => callSlack(env, "conversations.replies", { channel, ts, limit: 1 }));
  } catch (error) {
    if (/thread_not_found|message_not_found/.test(error.message)) throw new ToolError("I couldn't find that thread. It may have been deleted.");
    throw new ToolError(`Slack wouldn't let me into that thread (${error.message}).`);
  }
}

// A thread's messages as data: who, when, what, the names of the files and the links in it.
export function messageData(messages: ThreadMessage[]) {
  return messages.map((message) => ({
    ts: String(message.ts),
    time: new Date(Number(message.ts) * 1000).toISOString().slice(0, 16).replace("T", " "),
    user_id: message.user ?? message.username ?? message.bot_id ?? "unknown",
    bot: Boolean(message.bot_id),
    text: message.text ?? "",
    files: (message.files ?? []).map((file) => file.name),
    links: linksIn(message.text ?? ""),
  }));
}

// Slack sends a link as <address> or <address|label>, with & < > escaped.
const SLACK_LINK = /<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g;

// The web addresses in a message's Slack markup, once each, in the order written. Cade doesn't open
// them: the agent reads them with its own tools, as the person, so a private one stays private.
function linksIn(text: string) {
  const links = [...text.matchAll(SLACK_LINK)].map(([, address]) => address!.replace(/&amp;/g, "&"));
  return [...new Set(links)];
}

// A thread's messages, a line each.
export function messageLines(messages: ThreadMessage[]) {
  return messageData(messages).map((message) => {
    const files = message.files.length ? ` [attached: ${message.files.join(", ")}]` : "";
    // A message's own lines are indented, so where the next one starts is plain.
    const text = message.text.replace(/\n/g, "\n    ");
    return `[${message.time} UTC] ${message.user_id}${message.bot ? " (bot)" : ""}: ${text}${files}`;
  });
}

// The thread a task was made from, as data, or null.
export const threadOut = (thread: { channel: string; ts: string; link: string } | null) => (thread ? { thread_id: `${thread.channel}:${thread.ts}`, link: thread.link } : null);

// The first message of a task's thread, when it was made from another
// thread, names that thread (see moveMessage in commands/move.ts).
const MOVED_FROM = /^Moved from <@[UW][A-Z0-9]+>'s <([^|>]+)\|message>/;

// The thread a message of a task's thread was moved from, if it is Cade's copy of one, as { channel,
// ts, link }, or null.
function movedFromOf(text: string | undefined) {
  const found = MOVED_FROM.exec(text ?? "");
  const thread = found && linkedThread(found[1]!);
  return thread ? { ...thread, link: found[1]!.replace(/&amp;/g, "&") } : null;
}

// The channel and ts of the thread a task was made from, named by the first
// moved message among its kept ones, or null.
export function sourceThreadOf(messages: { text?: string }[]) {
  return messages.map((message) => movedFromOf(message.text)).find(Boolean) ?? null;
}

// The channels Cade is in that `user` is in too, project channels first.
export async function getChannels(env: AppEnv, user: string, { limit }: GetChannelsArgs) {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_CHANNELS)) throw new ToolError(`limit is a whole number from 1 to ${MAX_CHANNELS}.`);
  const names = new Map(projects(env).map((project) => [project.channel, project.name]));
  const found: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await callSlack(env, "users.conversations", { types: "public_channel,private_channel", exclude_archived: true, limit: PAGE, cursor });
    found.push(...(data.channels ?? []));
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  const seen: { channel_id: string; name: string; private: boolean; project: string }[] = [];
  for (const channel of found) {
    if (channel.is_im || channel.is_mpim) continue;
    if (!(await isMember(env, channel.id, user))) continue;
    seen.push({ channel_id: channel.id, name: channel.name ?? channel.id, private: Boolean(channel.is_private), project: names.get(channel.id) ?? "" });
  }
  seen.sort((a, b) => Number(Boolean(b.project)) - Number(Boolean(a.project)) || a.name.localeCompare(b.name));
  const shown = seen.slice(0, limit ?? DEFAULT_CHANNELS);
  if (!seen.length) return { text: "Cade isn't in any channel you're in.", data: { total: 0, channels: [] } };
  const lines = shown.map((c, i) => `${i + 1}. #${c.name} (${c.channel_id})${c.private ? " [private]" : ""}${c.project ? ` — project ${c.project}` : ""}`);
  const more = seen.length > shown.length ? `\n…and ${seen.length - shown.length} more; raise limit (up to ${MAX_CHANNELS}).` : "";
  return { text: [`${seen.length} channel${seen.length === 1 ? "" : "s"} Cade is in:`, ...lines].join("\n") + more, data: { total: seen.length, channels: shown } };
}

const utc = (ts: string) => new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ");

// A channel's recent root messages from people that aren't tracked: Cade's own posts (the task
// cards) are skipped, and so are those already moved into a task, marked with MOVED_REACTION.
export async function getChannelThreads(env: AppEnv, user: string, { channel_id: channel, days, with_replies: withReplies, limit }: GetChannelThreadsArgs) {
  if (!/^[CG][A-Z0-9]+$/.test(String(channel ?? ""))) throw new ToolError("channel_id is a channel's ID such as C0123ABCD. get_channels gives them.");
  if (days !== undefined && !(Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) throw new ToolError(`days is a whole number from 1 to ${MAX_DAYS}.`);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_THREADS)) throw new ToolError(`limit is a whole number from 1 to ${MAX_THREADS}.`);
  const info = await readableChannel(env, user, channel);
  const oldest = String(Math.floor(Date.now() / 1000) - (days ?? DEFAULT_DAYS) * 86400);

  const history = async () => {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await callSlack(env, "conversations.history", { channel, oldest, limit: PAGE, cursor });
      messages.push(...(data.messages ?? []));
      cursor = data.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    return messages;
  };
  let messages: SlackMessage[];
  try {
    try {
      messages = await history();
    } catch (error) {
      if (info.is_private || !/not_in_channel/.test(error.message)) throw error;
      await callSlack(env, "conversations.join", { channel });
      messages = await history();
    }
  } catch (error) {
    throw new ToolError(`Slack wouldn't give me that channel's messages (${error.message}).`);
  }

  const mine = (message: SlackMessage) => message.bot_id || message.subtype === "bot_message";
  const people = messages
    .filter((message) => !mine(message) && message.user && (!message.subtype || message.subtype === "file_share"))
    .filter((message) => !(message.thread_ts && message.thread_ts !== message.ts))
    .filter((message) => !message.reactions?.some((reaction: { name: string }) => reaction.name === MOVED_REACTION))
    .filter((message) => (message.text ?? "").trim() || message.files?.length)
    .filter((message) => !withReplies || Number(message.reply_count) > 0)
    .sort((a, b) => Number(b.ts) - Number(a.ts));
  const shown = people.slice(0, limit ?? DEFAULT_THREADS);
  const threads = shown.map((message) => ({
    thread_id: `${channel}:${message.ts}`,
    time: utc(message.ts),
    user_id: message.user,
    text: (message.text ?? "").slice(0, MAX_PREVIEW),
    files: (message.files ?? []).map((file) => file.name),
    reply_count: Number(message.reply_count) || 0,
    last_reply: message.latest_reply && Number(message.reply_count) > 0 ? utc(message.latest_reply) : "",
  }));
  const name = info.name ?? channel;
  if (!threads.length) return { text: `No threads from people in #${name} in the last ${days ?? DEFAULT_DAYS} days${withReplies ? " had replies" : ""} that Cade isn't tracking.`, data: { channel_id: channel, channel_name: name, total: 0, threads: [] } };
  const lines = threads.map((thread, i) => `${i + 1}. [${thread.time} UTC] ${thread.user_id}, ${thread.reply_count} repl${thread.reply_count === 1 ? "y" : "ies"} (${thread.thread_id}): ${thread.text.replace(/\s+/g, " ")}${thread.files.length ? ` [attached: ${thread.files.join(", ")}]` : ""}`);
  const more = people.length > shown.length ? `\n…and ${people.length - shown.length} more; raise limit (up to ${MAX_THREADS}).` : "";
  return { text: [`${people.length} thread${people.length === 1 ? "" : "s"} in #${name} not tracked by Cade, newest first:`, ...lines].join("\n") + more, data: { channel_id: channel, channel_name: name, total: people.length, threads } };
}
