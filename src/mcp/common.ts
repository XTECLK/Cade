// What the MCP tools share: the error a tool gives the agent, and the checks of the IDs, people and
// text they are given.
import { isMember, readableName } from "../access.ts";
import { projects, type Project } from "../channels.ts";
import { callSlack, linkedMessage, type SlackChannel } from "../slack.ts";
import type { AppEnv } from "../env.ts";

// Thrown by a tool for what the agent should be told, as a result it can
// read and act on, rather than a failure of the call.
export class ToolError extends Error {}

// A list read from Slack: up to PAGE at a call, and at most MAX_PAGES calls.
export const PAGE = 200;
export const MAX_PAGES = 10;

// The channel and the ts of the thread a link points to (a link to a reply
// stands for its thread), or a ToolError for what's wrong with it.
export function threadOf(link: unknown) {
  const message = linkedMessage(String(link ?? ""));
  if (!message) throw new ToolError("That isn't a link to a Slack message. Use Copy link on a message in the thread.");
  return { channel: message.channel, ts: message.threadTs ?? message.ts };
}

// The channel and ts a thread ID names, or a ToolError.
export function threadIdOf(threadId: unknown) {
  const match = /^([CGD][A-Z0-9]+):(\d+\.\d+)$/.exec(String(threadId).trim());
  if (!match)
    throw new ToolError(
      "A thread ID is the channel and the message time joined by a colon, such as C0123ABCD:1700000000.000100.",
    );
  return { channel: match[1]!, ts: match[2]! };
}

// The channel's info from Slack when `user` may read it, or a ToolError for why not. Someone not in it
// may still read it when `allowed` says so.
export async function readableChannel(env: AppEnv, user: string, channel: string, allowed?: () => Promise<boolean>) {
  let info: SlackChannel;
  try {
    ({ channel: info } = await callSlack(env, "conversations.info", { channel }));
  } catch (error) {
    throw new ToolError(`I can't see that channel (${error.message}). Cade has to be in it.`);
  }
  if (info.is_im || info.is_mpim) throw new ToolError("I can't read direct messages, only channels Cade is in.");
  // A channel is read only for someone in it, public or private (see readableName).
  if (!(await isMember(env, channel, user)) && !(await allowed?.())) {
    throw new ToolError("You aren't in that channel, so I can't read it for you.");
  }
  return info;
}

// The channel and ts of the task a call names by its `task_id`, or a ToolError.
export function taskRef({ task_id: taskId }: { task_id?: string }) {
  if (taskId === undefined) throw new ToolError("Give a task_id, as get_tasks gives it.");
  const match = /^([CGD][A-Z0-9]+):(\d+\.\d+)$/.exec(String(taskId).trim());
  if (!match)
    throw new ToolError(
      "A task ID is the channel and the message time joined by a colon, such as C0123ABCD:1700000000.000100. get_tasks gives them.",
    );
  return { channel: match[1]!, ts: match[2]! };
}

// The channel of the project called `name` (any case), or a ToolError.
export function projectChannel(env: AppEnv, name: unknown) {
  const found = projects(env).find((project) => project.name.toLowerCase() === String(name).trim().toLowerCase());
  if (!found)
    throw new ToolError(
      `There is no project called "${name}". get_projects lists them: ${projects(env)
        .map((project) => project.name)
        .join(", ")}.`,
    );
  return found.channel;
}

// The DD/MM/YYYY date a due_date argument names, "" for none, or a ToolError.
export function dueDateOf(value: unknown) {
  const text = String(value).trim();
  if (text.toLowerCase() === "none") return "";
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [day, month, year] = dmy ? [dmy[1], dmy[2], dmy[3]] : ymd ? [ymd[3], ymd[2], ymd[1]] : [];
  const date = year && new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (!date || date.getUTCDate() !== Number(day) || date.getUTCMonth() !== Number(month) - 1) {
    throw new ToolError('due_date is a real date as DD/MM/YYYY or YYYY-MM-DD, or "none" to remove it.');
  }
  return `${day}/${month}/${year}`;
}

// The Slack user IDs in a role's add or remove list, or a ToolError.
export function userIds(role: string, list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ToolError(`${role} takes lists of user IDs.`);
  const ids = list.map((id) =>
    String(id)
      .trim()
      .replace(/^<@([^>|]+).*>$/, "$1"),
  );
  const bad = ids.find((id) => !/^[UW][A-Z0-9]{2,}$/.test(id));
  if (bad) throw new ToolError(`"${bad}" isn't a Slack user ID for ${role}. find_user_by_name gives them.`);
  return [...new Set(ids)];
}

// A ToolError unless every ID is an active person of the workspace: not a made-up ID, a bot or a
// deactivated account, which would be saved on a task or mentioned and notify no one.
export async function requireActiveUsers(env: AppEnv, ids: string[]) {
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const found = await callSlack(env, "users.info", { user: id }).catch((error) => {
        if (!/user_not_found/.test(error.message)) throw new ToolError(`I couldn't check ${id} (${error.message}).`);
        return null;
      });
      if (!found?.user || found.user.deleted || found.user.is_bot)
        throw new ToolError(`${id} isn't an active person in the workspace. find_user_by_name gives the IDs.`);
    }),
  );
}

// What a credential looks like, by the name it is refused under.
const SECRETS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe key", /\b[sr]k_live_[0-9A-Za-z]{16,}/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/],
  ["password", /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/i],
];

// A ToolError if `text` looks like it holds a credential: what is written to a task or thread is read
// by everyone who can read it, and stays there.
export function refuseSecrets(text: unknown, where: string) {
  const found = SECRETS.find(([, pattern]) => pattern.test(String(text ?? "")));
  if (found) throw new ToolError(`${where} looks like it contains a ${found[0]}. Leave secrets out and send it again.`);
}

// The project called `name` whose channel `user` can read, or a ToolError.
export async function readableProject(env: AppEnv, user: string, name: unknown): Promise<Project> {
  const channel = projectChannel(env, name);
  const group = projects(env).find((pair) => pair.channel === channel);
  if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that project's channel.");
  return group!;
}
