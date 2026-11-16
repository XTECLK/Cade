// A task's thread as Cade kept it, and its working summary: get_task_history, ack_task_history,
// get_task_summary and save_task_summary. Nothing is asked of Slack.
import { readableName } from "../access.ts";
import { getConsumer, getSummary, MAX_CONSUMERS, promptByName, putConsumer, putSummary, taskTitleOf, threadMessages } from "../db.ts";
import { MAX_SUMMARY } from "../mcp-tools.ts";
import type { AckTaskHistoryArgs, GetTaskHistoryArgs, GetTaskSummaryArgs, SaveTaskSummaryArgs } from "../mcp-args.ts";
import type { AppEnv } from "../env.ts";
import { ToolError, taskRef, refuseSecrets } from "./common.ts";
import { SUMMARY_PROMPT } from "./prompts.ts";
import { messageData, messageLines, threadOut, sourceThreadOf } from "./threads.ts";

// The messages Cade kept of a task's thread. Nothing is asked of Slack.
export async function getTaskHistory(env: AppEnv, user: string, args: GetTaskHistoryArgs) {
  const { channel, ts } = taskRef(args);
  const title = await taskTitleOf(env, channel, ts);
  if (title === null) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks.");
  if (args.since !== undefined && args.consumer !== undefined) throw new ToolError("Give since or consumer, not both.");
  // The same rule as for Slack itself: a private channel's only for its members, and never a direct message.
  const where = await readableName(env, channel, user);
  if (where === null) throw new ToolError("You aren't in that task's project channel, so I can't read it for you.");
  const [all, position] = await Promise.all([threadMessages(env, channel, ts), args.consumer ? getConsumer(env, channel, ts, args.consumer) : null]);
  // From a message given, or from where the consumer last acknowledged; never read, from the start.
  const after = args.since ?? position?.through;
  const { fresh: messages, through } = unread(all, after);
  const token = args.consumer ? through : "";
  const taskId = `${channel}:${ts}`;
  const original = threadOut(sourceThreadOf(all));
  const data = { task_id: taskId, title, messages: messageData(messages), original_thread: original, token };
  if (!all.length) {
    return { text: `No messages are kept for "${title}" yet. get_thread_history reads the thread from Slack, or someone can send /cade resync with the task's link to store it.`, data: { ...data, original_thread: null } };
  }
  const read = args.consumer ? (position ? ` not read yet by ${args.consumer} (last acknowledged by ${position.by} at ${position.at.slice(0, 16)} UTC)` : ` (${args.consumer} has read none yet)`) : after ? ` after ${after}` : "";
  const lines = [`Task "${title}" in #${where} (${channel}), ${messages.length} kept message${messages.length === 1 ? "" : "s"}${read}, oldest first:`, ...messageLines(messages)];
  // This thread is what was done about the task; the problem is in the thread it came from.
  if (original && !after) {
    lines.push("", `Note: "${title}" was made from another thread, where the problem was first raised; get_task names it and get_thread_history reads it. This thread is what was done about it.`);
  }
  if (args.consumer) lines.push("", `Token: ${token}. Once these are handled, ack_task_history with it, so ${args.consumer} reads only what comes after.`);
  return { text: lines.join("\n"), data };
}

// Moves a consumer's position in a task's thread on to the token get_task_history gave it, once what it read is
// handled, so the next read gives only what came after. It changes nothing on the task and is shown to no one, so,
// unlike the other writes, it isn't approved first.
export async function ackTaskHistory(env: AppEnv, user: string, args: AckTaskHistoryArgs) {
  const { channel, ts } = taskRef(args);
  if ((await taskTitleOf(env, channel, ts)) === null) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks.");
  if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't do that for you.");
  const token = String(args.token).trim();
  await requireKept(env, channel, ts, token, "the token get_task_history gave");
  const saved = await putConsumer(env, channel, ts, args.consumer, token, user);
  if (saved === "behind") throw new ToolError(`${args.consumer} has read further since, so its position wasn't moved back. Call get_task_history with consumer ${args.consumer} for what is new.`);
  if (saved === "full") throw new ToolError(`This task keeps positions for ${MAX_CONSUMERS} consumers already, so a new one can't be added.`);
  console.log("Task history acknowledged", { channel, ts, consumer: args.consumer, by: user, through: token });
  return { text: `${args.consumer} has read the task's thread up to ${token}: the next read gives only what comes after.`, data: { task_id: `${channel}:${ts}`, consumer: args.consumer, acked: true } };
}

// A task's working summary, as some agent saved it, and up to which message of its thread it covers: the
// messages after it are get_task_history's, with since. Nothing is asked of Slack.
export async function getTaskSummary(env: AppEnv, user: string, args: GetTaskSummaryArgs) {
  const { channel, ts } = taskRef(args);
  const title = await taskTitleOf(env, channel, ts);
  if (title === null) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks.");
  const where = await readableName(env, channel, user);
  if (where === null) throw new ToolError("You aren't in that task's project channel, so I can't read it for you.");
  const [saved, steps] = await Promise.all([getSummary(env, channel, ts), promptByName(env, SUMMARY_PROMPT)]);
  const taskId = `${channel}:${ts}`;
  const lines = [`Task "${title}" in #${where} (task ID ${taskId}).`];
  if (saved) {
    lines.push("", `Summary, saved by ${saved.by} at ${saved.at.slice(0, 16)} UTC, covering the task's thread up to message ${saved.through}:`, saved.summary);
    lines.push("", `The messages after it: get_task_history with since ${saved.through}.`);
  } else lines.push("", "No summary saved yet: the whole thread is get_task_history's.");
  // The team's steps for writing it, from its deploy repo: asked in plain words, an agent follows them as the
  // slash command would.
  if (steps) lines.push("", `The team's steps for a task's summary: get_prompt with name "${SUMMARY_PROMPT}" and arguments {"task": "${taskId}"}.`);
  return {
    text: lines.join("\n"),
    data: { task_id: taskId, title, summary: saved?.summary ?? "", summary_by: saved?.by ?? "", summary_at: saved ? saved.at.slice(0, 16) : "", through: saved?.through ?? "", prompt: steps ? SUMMARY_PROMPT : "" },
  };
}

// Saves a task's working summary, which covers its thread up to `through`, for the next agent. It is
// shown to no one but agents, so, unlike the other writes, it isn't approved first.
export async function saveTaskSummary(env: AppEnv, user: string, args: SaveTaskSummaryArgs) {
  const { channel, ts } = taskRef(args);
  if ((await taskTitleOf(env, channel, ts)) === null) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks.");
  if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't save it for you.");
  const summary = String(args.summary).trim();
  if (!summary) throw new ToolError("The summary is empty.");
  if (summary.length > MAX_SUMMARY) throw new ToolError(`The summary is ${summary.length} characters; keep it to ${MAX_SUMMARY} or fewer.`);
  refuseSecrets(summary, "The summary");
  const through = String(args.through).trim();
  await requireKept(env, channel, ts, through, "as through the ts of the last message get_task_history gave");
  if (!(await putSummary(env, channel, ts, summary, through, user))) {
    throw new ToolError("A summary covering more of the task's thread was saved since you read it, so this one wasn't. Call get_task_summary again and add to that one.");
  }
  console.log("Task summary saved", { channel, ts, by: user, through, characters: summary.length });
  return { text: "Saved the task's summary. The next agent reads it and only the messages after it.", data: { task_id: `${channel}:${ts}`, saved: true } };
}

// The messages of a thread after the one at `mark` (all of them with none), and the mark to save once
// they are read: the last of them, or `mark` when none is new.
// Slack's message times are all ten digits, a dot and six, so they compare as text.
function unread<M extends { ts: string }>(kept: M[], mark: string | undefined) {
  const fresh = mark ? kept.filter((message) => message.ts > mark) : kept;
  return { fresh, through: fresh.at(-1)?.ts ?? mark ?? "" };
}

// Whether `through` is a message of the task's kept thread, as a mark must be, or a ToolError saying `what` to
// pass instead.
async function requireKept(env: AppEnv, channel: string, ts: string, through: string, what: string) {
  if (!(await threadMessages(env, channel, ts)).some((message) => message.ts === through)) {
    throw new ToolError(`That isn't a message of the task's thread: pass ${what}.`);
  }
}
