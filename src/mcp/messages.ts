// Posting for the person: send_thread_message, and send_approval_request.
import { readableName } from "../access.ts";
import { nameOf } from "../notify.ts";
import { threadLink } from "../commands/tasks.ts";
import { MAX_MESSAGE } from "../mcp-tools.ts";
import { callSlack, escapeSlack, sentBy, viaAgent } from "../slack.ts";
import { requestApproval, usualRequest } from "../commands/status.ts";
import { loadTask, statusName } from "../tasks.ts";
import type { SendApprovalRequestArgs, SendThreadMessageArgs } from "../mcp-args.ts";
import type { AppEnv } from "../env.ts";
import { ToolError, threadOf, threadIdOf, taskRef, userIds, requireActiveUsers, refuseSecrets } from "./common.ts";
import { reachableThread } from "./threads.ts";

// Asks a person to approve a task in Client review, in its thread, with Approve and Not approve buttons only they can click.
export async function requestApprovalTool(env: AppEnv, user: string, args: SendApprovalRequestArgs) {
  const { channel, ts } = taskRef(args);
  const task = await loadTask(env, channel, ts);
  if (!task) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks, or the link to its message.");
  if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't post there for you.");
  // One ID in, one out: userIds throws for anything else.
  const [approver] = userIds("approver", [args.approver]) as [string];
  await requireActiveUsers(env, [approver]);
  if (task.status !== "CLIENT_REVIEW") throw new ToolError(`This task is ${statusName(task.status)}, so there's nothing to approve. Move it to Client review with update_task first.`);
  // The request in the person's words, when they changed it: checked as any message an agent posts.
  const message = args.message === undefined ? undefined : String(args.message).trim();
  if (message !== undefined) {
    if (!message) throw new ToolError("The message is empty: leave it out for the usual request.");
    if (message.length > MAX_MESSAGE) throw new ToolError(`The message is ${message.length} characters; keep it to ${MAX_MESSAGE} or fewer.`);
    refuseSecrets(message, "The message");
    await requireActiveUsers(env, [...message.matchAll(/<@([UW][A-Z0-9]{2,})>/g)].map((match) => match[1]!));
  }
  // The usual request sent as it is (update_task's suggested_message) is posted as Slack's form posts it.
  const request = message && !usualRequest(message, task.prs) ? withLinks(plainMessage(message)) : undefined;
  const problem = await requestApproval(env, channel, ts, approver, user, request);
  if (problem) throw new ToolError(problem);
  console.log("Approval requested by MCP", { channel, ts, by: user, approver });
  return {
    text: `Asked <@${approver}> to approve it, in the task's thread. Approving moves the task to Done; not approving sends it back to In progress.${task.link ? ` ${task.link}` : ""}`,
    data: { task_id: `${channel}:${ts}`, approver, link: task.link ?? "" },
  };
}

// The text of a message from an agent with only people's mentions left in it:
// everything else, such as <!channel> and links, is shown as typed.
function plainMessage(text: string) {
  return escapeSlack(text).replace(/&lt;@([UW][A-Z0-9]{2,})&gt;/g, "<@$1>");
}

// A plainMessage with its links kept as links, <https://…|label>, such as an approval request's pull
// requests (see approvalRequest in commands/status.ts).
function withLinks(text: string) {
  return text.replace(/&lt;(https?:\/\/[^\s|<>]+?)(\|[^<>\n]*?)?&gt;/g, (_, url: string, label = "") => `<${url.replace(/&amp;/g, "&")}${label}>`);
}

// Posts the person's message in a thread, as Cade, led by who sent it and ending with the "Sent
// using AI agent" footer:
// a task's thread, or any other in a channel the person can read.
export async function sendThreadMessage(env: AppEnv, user: string, args: SendThreadMessageArgs) {
  if (args.thread_id !== undefined && args.link !== undefined) throw new ToolError("Give thread_id or link, not both.");
  const { channel, ts } = args.thread_id !== undefined ? threadIdOf(args.thread_id) : threadOf(args.link);
  const task = await loadTask(env, channel, ts);
  if (task && (await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't post there for you.");
  const message = String(args.text ?? "").trim();
  if (!message) throw new ToolError("The message is empty.");
  if (message.length > MAX_MESSAGE) throw new ToolError(`The message is ${message.length} characters; keep it to ${MAX_MESSAGE} or fewer.`);
  refuseSecrets(message, "The message");
  await requireActiveUsers(env, [...message.matchAll(/<@([UW][A-Z0-9]{2,})>/g)].map((match) => match[1]!));
  if (!task) await reachableThread(env, user, channel, ts);
  const body = plainMessage(message);
  await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...viaAgent(sentBy(await nameOf(env, user), body)) });
  console.log(task ? "Task message sent" : "Thread message sent", { channel, ts, by: user, characters: message.length });
  // The person is told where it was posted, so a thread named by its ID gets a link too.
  const link = (task ? task.link : args.link) || (await linkToThread(env, channel, ts));
  return {
    text: `Posted in the ${task ? "task's " : ""}thread${link ? `: ${link}` : "."}`,
    data: { task_id: task ? `${channel}:${ts}` : "", thread_id: `${channel}:${ts}`, sent: true, link },
  };
}

// A link to a thread, made from the workspace's address, or "" when Slack won't give that.
async function linkToThread(env: AppEnv, channel: string, ts: string) {
  const { url } = await callSlack(env, "auth.test", {}).catch(() => ({}) as { url?: string });
  return url ? threadLink(url, channel, ts) : "";
}
