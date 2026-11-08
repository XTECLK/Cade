import { channelMembers, hashToken, isMember, newToken, readableName } from "./access.ts";
import { projects } from "./channels.ts";
import { applyChanges } from "./commands/changes.ts";
import { HEALTH, SummaryError, compareVersions, defaultPeriod, dayBoundary, docProblem, period, periodLabel, readSummaryDoc, writeSummary } from "./summaries.ts";
import { checkRoot, MOVED_REACTION } from "./commands/move.ts";
import { parseStatus } from "./commands/status.ts";
import { createTask } from "./commands/track.ts";
import { OPEN, byUrgency, threadLink, todayIn } from "./commands/tasks.ts";
import { getSummary, lastSummary, markSummaryInformed, putSummaryAfter, summariesOf, summaryItems, deleteMcpToken, getNotes, mcpTokenUser, notesOf, putMcpToken, putSummary, putTask, changeRelease, releaseById, releasesOfTasks, releasesWithStatus, taskTitleOf, tasksWithStatuses, threadMessages } from "./db.ts";
import { publicUrl } from "./links.ts";
import { MCP_CALLS_PER_MINUTE, mcpCallWait } from "./rate-limit.ts";
import { syncNotes } from "./notes.ts";
import { AVAILABILITY_FIELDS, DEFAULT_CHANNELS, DEFAULT_DAYS, DEFAULT_TASKS, DEFAULT_THREADS, DEFAULT_USERS, EXTRA_FIELDS, MAX_CALL_NOTES, MAX_CHANNELS, MAX_DAYS, MAX_EARLIER_SUMMARIES, MAX_ADDED_ITEMS, MAX_ITEM_NOTES, MAX_ITEM_TITLE, MAX_MATCHES, MAX_MESSAGE, MAX_NAMES, MAX_PRESENCE, MAX_PREVIEW, MAX_PROGRESS, MAX_RELEASE_NOTE, MAX_SUMMARY, MAX_SUMMARY_ITEMS, MAX_TASKS, MAX_THREADS, MAX_TITLE, MAX_USERS, TASK_FIELDS, TASK_VIEW_FIELDS, TOOL_DEFS, USER_FIELDS } from "./mcp-tools.ts";
import { callSlack, escapeSlack, linkedMessage, linkedThread, mentions, mrkdwn, type SlackChannel, type SlackUser } from "./slack.ts";
import { nameMap } from "./export.ts";
import { requestApproval } from "./commands/status.ts";
import { INSTRUCTIONS } from "./guardrails.ts";
import { SERVER_DESCRIPTION, SERVER_VERSION } from "./mcp-about.ts";
import { releaseRequest } from "./commands/release.ts";
import { INCIDENT, PRIORITIES, ROLES, STATUSES, loadTask, noPeople, parsePullRequest, prLink, statusName, taskMessage, unsentPrs } from "./tasks.ts";
import { validate } from "./validate.ts";
import type { CreateExecutiveSummaryArgs, CreateTaskArgs, FindUserByNameArgs, GetAvailabilityArgs, GetChannelThreadsArgs, GetChannelsArgs, GetExecutiveSummaryArgs, GetExecutiveSummaryDocArgs, GetProjectsArgs, GetReleasesArgs, GetServerInfoArgs, GetTaskArgs, GetTaskHistoryArgs, GetTasksArgs, GetTeamAvailabilityArgs, GetThreadHistoryArgs, GetUserArgs, GetUsersArgs, SendApprovalRequestArgs, SendThreadMessageArgs, UpdateExecutiveSummaryAfterCallArgs, UpdateReleaseArgs, UpdateTaskArgs, ToolArgs } from "./mcp-args.ts";
import type { AppEnv } from "./env.ts";
import type { Project } from "./channels.ts";
import type { TaskEntry } from "./commands/tasks.ts";
import type { Summary, SummaryItem } from "./db.ts";
import type { Changes, Priority, Release, ReleaseStatus, Role, SlackMessage, Status, Task } from "./types.ts";

// What a tool gives: its text, or its text and its data (structuredContent).
type ToolResult = string | { text: string; data: Record<string, unknown> };
type ToolRunner<Args> = (env: AppEnv, user: string, args: Args, extra: { loaded: string }) => Promise<ToolResult>;
// A JSON-RPC request's id.
type RpcId = string | number | null;
// A JSON-RPC message as an agent sends it. Nothing in it is trusted until answer and callTool have
// checked it, so its fields are unknown.
type RpcParams = { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
type RpcMessage = { jsonrpc?: unknown; id?: RpcId; method?: unknown; params?: RpcParams };
// A message of a thread: from Slack, or as Cade kept it.
type ThreadMessage = { ts: string; user?: string; username?: string; bot_id?: string; text?: string; files?: { name?: string }[] };
// A task in a list, before it has its link (see taskLines).
type ListedTask = Omit<TaskEntry, "link">;

// Cade as an MCP server, so a person's own AI agent (Claude, Gemini, Cursor,
// Codex, …) can read a Slack thread and write what it makes of it into a
// task, with the model and subscription they already have. Twenty-one tools:
//
//   get_task(task_id, fields?)         one task: its details, summary and
//                                      notes, not its threads
//   get_thread_history(thread_id | link)
//                                      a whole thread, read from Slack
//   get_task_history(task_id)          the messages Cade kept of a task's
//                                      thread, from its own database
//   get_tasks(assignees?, roles?, unassigned?, status?, limit?)
//                                      tasks they can read, most urgent first:
//                                      everyone's, or some people's ("me" for
//                                      their own), in some roles
//   get_user(user_id)                      a Slack user's name, for the IDs in it
//   get_channels(limit?)               the channels Cade is in that the person can read
//   get_channel_threads(channel_id, …) a channel's recent threads from people that
//                                      aren't tasks yet, to turn into tasks
//   create_task(title, …)              a task or incident, from a thread or from
//                                      scratch, with its summary
//   get_projects()                     the projects, with the channel of each
//   get_users(limit?)                  the workspace's people and their IDs
//   find_user_by_name(name)            a Slack user's ID, by name, for assigning
//   send_thread_message(thread_id | link, text)
//                                      a message in a thread, a task's or any
//                                      other, as Cade, with a line saying it
//                                      is from the person
//   update_task(task_id, …)            a task's status, priority, due date,
//                                      people and summary; the fields are told
//                                      to its thread, the summary is the one
//                                      at the top of the notes page
//
// It speaks MCP's Streamable HTTP in its simplest form: every POST to /mcp is
// one JSON-RPC message, or a batch of them, answered with JSON. There are no
// sessions and nothing is streamed.
//
// The API key is the person's own, made and ended with the Home tab's AI agent button
// (see commands/configure.ts), so every action is theirs: a
// private channel's thread is read only for someone in it. It is sent in the
// `x-apikey` header with every request, never in the address, which ends up
// in logs and histories. Only a hash of it is kept (see grantToken).
//
// The summary is kept in Cade's database (task_notes), and the team reads it,
// with the notes they write around it, on the task's notes page (see web.ts).
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PAGE = 200;
const MAX_PAGES = 10;

// Makes a new API key for `user`, ending any they had, and returns it. It
// can't be read again; revoking it ends it, and a new one follows.
export async function grantToken(env: AppEnv, user: string) {
  const token = newToken();
  await putMcpToken(env, user, await hashToken(token));
  return token;
}

// The address of the MCP endpoint, on the Worker.
export function endpointUrl(env: AppEnv) {
  return `${publicUrl(env)}/mcp`;
}

// Ends the user's token, and returns whether they had one.
export function revokeToken(env: AppEnv, user: string) {
  return deleteMcpToken(env, user);
}

// The user a token is for, or null.
async function tokenUser(env: AppEnv, token: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? mcpTokenUser(env, await hashToken(token)) : null;
}

// The API key a request sends in its `x-apikey` header, or "".
function apiKeyOf(request: Request) {
  return (request.headers.get("x-apikey") ?? "").trim();
}

// What the agent is told when it connects, and the rules it must keep, are in guardrails.ts.


// Each tool's definition is in mcp-tools.ts; this adds the function that runs it.
// The function that runs each tool. Each takes its tool's arguments as src/mcp-args.ts types them,
// made from the same inputSchema they are checked against before it is called (see callTool).
const RUNNERS: { [Tool in keyof ToolArgs]: ToolRunner<ToolArgs[Tool]> } = { get_releases: getReleases, update_release: updateRelease, get_task: getTaskView, get_thread_history: getThreadHistory, get_task_history: getTaskHistory, get_tasks: getTasks, get_channels: getChannels, get_channel_threads: getChannelThreads, create_task: createTaskTool, get_projects: getProjects, get_user: resolveUserName, get_users: getUsers, get_availability: getAvailability, get_team_availability: getTeamAvailability, find_user_by_name: findUser, send_thread_message: sendThreadMessage, update_task: updateTask, get_executive_summary: getExecutiveSummary, get_executive_summary_doc: getExecutiveSummaryDoc, create_executive_summary: createExecutiveSummary, update_executive_summary_after_call: updateAfterCall, get_server_info: getServerInfo, send_approval_request: requestApprovalTool };
// A tool with no function to run it is a mistake made here, so the Worker refuses to start.
const TOOLS = TOOL_DEFS.map((tool) => {
  // Called only with arguments checked against the tool's own inputSchema (see callTool), which is
  // what its runner's argument type is made from.
  const run = RUNNERS[tool.name as keyof ToolArgs] as ToolRunner<unknown> | undefined;
  if (!run) throw new Error(`The MCP tool ${tool.name} has no runner in RUNNERS`);
  return { ...tool, run };
});

// The version of the tool set: a short hash of everything a client loads when it connects, so it changes
// with any change to a tool, its description, the instructions or the summary, and can't be forgotten.
function hashOf(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}
export const TOOLSET_VERSION = hashOf(JSON.stringify([TOOL_DEFS, INSTRUCTIONS, SERVER_DESCRIPTION]));

// A session ID holds the tool set the session loaded (the client sends it back on every request), so the
// server, which keeps nothing, can tell a session that is out of date.
const sessionIdFor = () => `cade-${TOOLSET_VERSION}-${crypto.randomUUID()}`;
const loadedVersionOf = (request: Request) => /^cade-([0-9a-f]{8})-/.exec(request.headers.get("mcp-session-id") ?? "")?.[1] ?? "";

// Thrown by a tool for what the agent should be told, as a result it can
// read and act on, rather than a failure of the call.
class ToolError extends Error {}

// The Worker's answer to a request for /mcp.
// The names of the tools, for the AI agent modal.
export function mcpCatalog() {
  return { tools: TOOLS.map((tool) => tool.name) };
}

// Whether Cade's MCP endpoint is on. It is unless the Worker secret MCP is
// "off" (`mcp: false` in cade.config.json).
export function mcpEnabled(env: Pick<AppEnv, "MCP">) {
  return env.MCP !== "off";
}

export async function handleMcp(request: Request, env: AppEnv) {
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, x-apikey",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-expose-headers": "mcp-session-id",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  // There is no stream to open, as MCP lets a server say.
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: "POST" } });

  if (!mcpEnabled(env)) return new Response("The MCP endpoint is turned off", { status: 404, headers });
  const user = await tokenUser(env, apiKeyOf(request));
  if (!user) return new Response("Unauthorized", { status: 401, headers });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(failure(null, -32700, "Parse error"), { status: 400, headers });
  }
  const batch = Array.isArray(body);
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  const loaded = loadedVersionOf(request);
  const answers = (await Promise.all(messages.map((message) => answer(env, user, message, loaded)))).filter(Boolean);
  // Notifications and answers to us need none.
  if (!answers.length) return new Response(null, { status: 202, headers });
  // A session that connects is given an ID that names the tool set it loads.
  const connecting = messages.some((message) => (message as RpcMessage | null)?.method === "initialize");
  return Response.json(batch ? answers : answers[0], { headers: { ...headers, ...(connecting && { "mcp-session-id": sessionIdFor() }) } });
}

const success = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function answer(env: AppEnv, user: string, raw: unknown, loaded: string) {
  if (!raw || typeof raw !== "object" || (raw as RpcMessage).jsonrpc !== "2.0") return failure(null, -32600, "Invalid request");
  const message = raw as RpcMessage;
  // No id: a notification, or an answer to a request of ours (there are none).
  if (message.id === undefined || message.id === null) return null;
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return success(id, {
        protocolVersion: typeof params?.protocolVersion === "string" && PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "cade", title: "Cade", version: `${SERVER_VERSION}+${TOOLSET_VERSION}`, description: SERVER_DESCRIPTION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, { tools: TOOLS.map(({ run, ...tool }) => tool) });
    case "tools/call":
      return callTool(env, user, id, params, loaded);
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

// Said at the end of a tool's text while the session has an older tool set than the server (get_server_info
// says it on its own).
const staleNotice = (loaded: string) =>
  loaded && loaded !== TOOLSET_VERSION
    ? `\n\nCade's tools were updated after this session started (it loaded ${loaded}, the server has ${TOOLSET_VERSION}). Tell the person to disconnect and connect Cade again to load them.`
    : "";

async function callTool(env: AppEnv, user: string, id: RpcId, params: RpcParams | undefined, loaded: string) {
  const tool = TOOLS.find((candidate) => candidate.name === params?.name);
  if (!tool) return failure(id, -32602, `Unknown tool: ${params?.name}`);
  const notice = tool.name === "get_server_info" ? "" : staleNotice(loaded);
  const reply = (text: string, isError?: boolean, data?: Record<string, unknown>) => success(id, { content: [{ type: "text", text: text + notice }], ...(data && { structuredContent: data }), ...(isError && { isError: true }) });
  // Each person's agent has a limit of calls a minute (see rate-limit.ts); over it, it is told how long to wait.
  const wait = await mcpCallWait(env, user);
  if (wait) {
    console.log("MCP rate limit reached", { tool: tool.name, user });
    return reply(`Too many calls: your AI agent can make ${MCP_CALLS_PER_MINUTE} a minute. Wait ${wait} second${wait === 1 ? "" : "s"}, then try again.`, true);
  }
  // The arguments are checked against the tool's inputSchema, the one the agent was shown, before it
  // runs: an unknown argument, a wrong type or a value out of range is refused, saying which, so the
  // agent can correct it. The tool still checks what the schema can't say.
  const args = params?.arguments ?? {};
  const problem = validate(tool.inputSchema, args);
  if (problem) {
    console.log("MCP arguments refused", { tool: tool.name, problem });
    return reply(problem, true);
  }
  try {
    // A tool gives its text, or { text, data } to pass on its data as well.
    const result = await tool.run(env, user, args, { loaded });
    if (typeof result === "string") return reply(result);
    // A result that holds user IDs carries the names of those people too, so no lookup is needed to show them.
    const named = tool.outputSchema?.properties?.user_names ? await withUserNames(env, result) : result;
    return reply(named.text, false, named.data);
  } catch (error) {
    if (error instanceof ToolError) return reply(error.message, true);
    console.error("MCP tool failed", { tool: tool.name, error: error.message });
    return reply(`Something went wrong in ${tool.name}: ${error.message}`, true);
  }
}

// A user ID as a whole value, or a <@…> mention in any text.
const USER_ID_VALUE = /^[UW][A-Z0-9]{8,}$/;
const USER_MENTION = /<@([UW][A-Z0-9]{2,})(?:\|[^>]*)?>/g;

// Every user ID in `value`: the fields that hold one, and the mentions in what people wrote.
function userIdsIn(value: unknown, found = new Set<string>()) {
  if (typeof value === "string") {
    if (USER_ID_VALUE.test(value)) found.add(value);
    for (const mention of value.matchAll(USER_MENTION)) found.add(mention[1]!);
  } else if (Array.isArray(value)) {
    for (const item of value) userIdsIn(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) userIdsIn(item, found);
  }
  return found;
}

// `result` with `user_names` in its data (at most MAX_NAMES people), and each of those people in its text
// as "Name (ID)", or "@Name (ID)" for a mention. The IDs stay: the other tools take them.
async function withUserNames(env: AppEnv, result: { text: string; data: Record<string, unknown> }) {
  const ids = [...userIdsIn(result.data)].slice(0, MAX_NAMES);
  // The names kept in the database; Slack is asked only for a person not seen before. An ID with no name
  // (not a person Slack knows) stands in for itself there, and is left out here.
  const kept = await nameMap(env, ids);
  const user_names = Object.fromEntries(ids.filter((id) => kept.get(id) && kept.get(id) !== id).map((id) => [id, kept.get(id)])) as Record<string, string>;
  const text = result.text.replace(/<@([UW][A-Z0-9]{2,})(?:\|[^>]*)?>|\b([UW][A-Z0-9]{8,})\b/g, (all: string, mention: string | undefined, bare: string) => {
    const id = mention ?? bare;
    return user_names[id] ? `${mention ? "@" : ""}${user_names[id]} (${id})` : all;
  });
  return { text, data: { ...result.data, user_names } };
}

// Asks a person to approve a task in Client review, in its thread, with Approve and Not approve buttons only they can click.
async function requestApprovalTool(env: AppEnv, user: string, args: SendApprovalRequestArgs) {
  const { channel, ts } = taskRef(args);
  const task = await loadTask(env, channel, ts);
  if (!task) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks, or the link to its message.");
  if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't post there for you.");
  // One ID in, one out: userIds throws for anything else.
  const [approver] = userIds("approver", [args.approver]) as [string];
  await requireActiveUsers(env, [approver]);
  if (task.status !== "CLIENT_REVIEW") throw new ToolError(`This task is ${statusName(task.status)}, so there's nothing to approve. Move it to Client review with update_task first.`);
  const problem = await requestApproval(env, channel, ts, approver, user);
  if (problem) throw new ToolError(problem);
  console.log("Approval requested by MCP", { channel, ts, by: user, approver });
  return {
    text: `Asked <@${approver}> to approve it, in the task's thread. Approving moves the task to Done; not approving sends it back to In progress.${task.link ? ` ${task.link}` : ""}`,
    data: { task_id: `${channel}:${ts}`, approver, link: task.link ?? "" },
  };
}

// Which version of the tool set this session loaded, against the one the server has now.
async function getServerInfo(env: AppEnv, user: string, args: GetServerInfoArgs, { loaded = "" } = {}) {
  const status = !loaded ? "UNKNOWN" : loaded === TOOLSET_VERSION ? "CURRENT" : "OUTDATED";
  const text = [`Cade ${SERVER_VERSION}, tool set ${TOOLSET_VERSION}.`];
  if (status === "CURRENT") text.push("This session has the latest tools.");
  else if (status === "OUTDATED") text.push(`This session loaded tool set ${loaded}, so it doesn't have the latest tools. Tell the person to disconnect and connect Cade again to load them.`);
  else text.push("This client doesn't say which tool set it loaded, so I can't tell if it is the latest. Disconnecting and connecting Cade again loads the latest.");
  return { text: text.join(" "), data: { server_version: SERVER_VERSION, toolset_version: TOOLSET_VERSION, session_toolset_version: loaded, status } };
}

// The channel and the ts of the thread a link points to (a link to a reply
// stands for its thread), or a ToolError for what's wrong with it.
function threadOf(link: unknown) {
  const message = linkedMessage(String(link ?? ""));
  if (!message) throw new ToolError("That isn't a link to a Slack message. Use Copy link on a message in the thread.");
  return { channel: message.channel, ts: message.threadTs ?? message.ts };
}

// The channel and ts a thread ID names, or a ToolError.
function threadIdOf(threadId: unknown) {
  const match = /^([CGD][A-Z0-9]+):(\d+\.\d+)$/.exec(String(threadId).trim());
  if (!match) throw new ToolError("A thread ID is the channel and the message time joined by a colon, such as C0123ABCD:1700000000.000100.");
  return { channel: match[1]!, ts: match[2]! };
}

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

async function getThreadHistory(env: AppEnv, user: string, { thread_id: threadId, link }: GetThreadHistoryArgs) {
  const { channel, ts } = threadId !== undefined ? threadIdOf(threadId) : threadOf(link);
  return readSlackThread(env, user, channel, ts);
}

// The channel's info from Slack when `user` may read it, or a ToolError for why not.
async function readableChannel(env: AppEnv, user: string, channel: string) {
  let info: SlackChannel;
  try {
    ({ channel: info } = await callSlack(env, "conversations.info", { channel }));
  } catch (error) {
    throw new ToolError(`I can't see that channel (${error.message}). Cade has to be in it.`);
  }
  if (info.is_im || info.is_mpim) throw new ToolError("I can't read direct messages, only channels Cade is in.");
  // A channel is read only for someone in it, public or private (see readableName).
  if (!(await isMember(env, channel, user))) {
    throw new ToolError("You aren't in that channel, so I can't read it for you.");
  }
  return info;
}

// A thread read from Slack for `user`, as text, or a ToolError for why not.
async function readSlackThread(env: AppEnv, user: string, channel: string, ts: string) {
  const info = await readableChannel(env, user, channel);

  let messages: SlackMessage[];
  try {
    messages = await asMember(env, info, channel, () => readReplies(env, channel, ts));
  } catch (error) {
    if (/thread_not_found|message_not_found/.test(error.message)) throw new ToolError("I couldn't find that thread. It may have been deleted.");
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
async function reachableThread(env: AppEnv, user: string, channel: string, ts: string) {
  const info = await readableChannel(env, user, channel);
  try {
    await asMember(env, info, channel, () => callSlack(env, "conversations.replies", { channel, ts, limit: 1 }));
  } catch (error) {
    if (/thread_not_found|message_not_found/.test(error.message)) throw new ToolError("I couldn't find that thread. It may have been deleted.");
    throw new ToolError(`Slack wouldn't let me into that thread (${error.message}).`);
  }
}

// A thread's messages as data: who, when, what, and the names of the files.
function messageData(messages: ThreadMessage[]) {
  return messages.map((message) => ({
    ts: String(message.ts),
    time: new Date(Number(message.ts) * 1000).toISOString().slice(0, 16).replace("T", " "),
    user_id: message.user ?? message.username ?? message.bot_id ?? "unknown",
    bot: Boolean(message.bot_id),
    text: message.text ?? "",
    files: (message.files ?? []).map((file) => file.name),
  }));
}

// A thread's messages, a line each.
function messageLines(messages: ThreadMessage[]) {
  return messageData(messages).map((message) => {
    const files = message.files.length ? ` [attached: ${message.files.join(", ")}]` : "";
    // A message's own lines are indented, so where the next one starts is plain.
    const text = message.text.replace(/\n/g, "\n    ");
    return `[${message.time} UTC] ${message.user_id}${message.bot ? " (bot)" : ""}: ${text}${files}`;
  });
}

// The messages Cade kept of a task's thread. Nothing is asked of Slack.
async function getTaskHistory(env: AppEnv, user: string, args: GetTaskHistoryArgs) {
  const { channel, ts } = taskRef(args);
  const title = await taskTitleOf(env, channel, ts);
  if (title === null) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks.");
  // The same rule as for Slack itself: a private channel's only for its members, and never a direct message.
  const where = await readableName(env, channel, user);
  if (where === null) throw new ToolError("You aren't in that task's project channel, so I can't read it for you.");
  const messages = await threadMessages(env, channel, ts);
  const taskId = `${channel}:${ts}`;
  if (!messages.length) {
    return { text: `No messages are kept for "${title}" yet. get_thread_history reads the thread from Slack, or someone can send /cade resync with the task's link to store it.`, data: { task_id: taskId, title, messages: [], original_thread: null } };
  }
  const lines = [`Task "${title}" in #${where} (${channel}), ${messages.length} kept message${messages.length === 1 ? "" : "s"}, oldest first:`, ...messageLines(messages)];
  // This thread is what was done about the task; the problem is in the thread it came from.
  const original = sourceThreadOf(messages);
  if (original) {
    lines.push("", `Note: "${title}" was made from another thread, where the problem was first raised; get_task names it and get_thread_history reads it. This thread is what was done about it.`);
  }
  return { text: lines.join("\n"), data: { task_id: taskId, title, messages: messageData(messages), original_thread: threadOut(original) } };
}

// The thread a task was made from, as data, or null.
const threadOut = (thread: { channel: string; ts: string; link: string } | null) => (thread ? { thread_id: `${thread.channel}:${thread.ts}`, link: thread.link } : null);

// A task as data, `link` being its link for the tools to give.
function taskData(env: AppEnv, channel: string, ts: string, task: Task, link: string) {
  const name = projects(env).find((pair) => pair.channel === channel)?.name ?? channel;
  return {
    task_id: `${channel}:${ts}`,
    title: task.title,
    project: name,
    channel_id: channel,
    status: task.status,
    priority: task.priority,
    due_date: task.dueDate || "",
    incident: Boolean(task.incident),
    has_subtasks: Boolean(task.subtasks),
    blocked: Boolean(task.blocked),
    blocked_reason: task.blockedReason || "",
    link,
    owner: task.people.owner,
    reviewer: task.people.reviewer,
    tester: task.people.tester,
  };
}

// A release as data, with its time as YYYY-MM-DD HH:MM in UTC.
const releaseData = (release: Release) => ({
  release_id: release.id,
  prs: release.prs,
  note: release.note,
  status: release.status,
  sent_by: release.sentBy ?? "",
  sent_at: release.sentAt ? release.sentAt.slice(0, 16).replace("T", " ") : "",
  decided_by: release.decidedBy ?? "",
  decided_at: release.decidedAt ? release.decidedAt.slice(0, 16).replace("T", " ") : "",
});

// A task's pull requests with where each is, and its releases, as data: a PR is pending until it is
// sent to the client with a release, then pending_approval, then approved (all are, once the task is
// Done). `releases` are the task's, not counting those turned down.
function prData(task: Task, releases: Release[] = task.releases ?? []) {
  const sentWith = new Map<string, Release>();
  for (const release of releases) for (const url of release.prs) sentWith.set(url, release);
  const prs = task.prs!.map((url) => {
    const pr = parsePullRequest(url);
    const release = sentWith.get(url);
    const approved = release?.status === "APPROVED";
    return {
      url,
      label: pr ? `${pr.repo}/${pr.number}` : url,
      state: task.status === "DONE" || approved ? "APPROVED" : release ? "PENDING_APPROVAL" : "PENDING",
      release: release ? { release_id: release.id, note: release.note, status: release.status } : null,
    };
  });
  return { prs, releases: releases.map(releaseData) };
}

// One task: its details, summary and notes, without its threads, or only the `fields` asked
// for. Nothing is asked of Slack.
async function getTaskView(env: AppEnv, user: string, args: GetTaskArgs) {
  const { channel, ts } = taskRef(args);
  const { fields } = args;
  if (fields !== undefined && !(Array.isArray(fields) && fields.every((field) => TASK_VIEW_FIELDS.includes(field)))) throw new ToolError(`fields is a list of: ${TASK_VIEW_FIELDS.join(", ")}.`);
  const task = await loadTask(env, channel, ts);
  if (!task) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks, or the link to its message.");
  const where = await readableName(env, channel, user);
  if (where === null) throw new ToolError("You aren't in that task's project channel, so I can't read it for you.");
  // Only what is asked for is read.
  const want = (...names: NonNullable<GetTaskArgs["fields"]>) => !fields || names.some((name) => fields.includes(name));
  const [notes, kept] = await Promise.all([
    want("summary", "summary_by", "notes") ? getNotes(env, channel, ts) : ({} as Partial<Awaited<ReturnType<typeof getNotes>>>),
    want("original_thread", "original_thread_state") ? threadMessages(env, channel, ts) : [],
  ]);
  const original = sourceThreadOf(kept);
  const state = original ? "found" : kept.length ? "none" : "unknown";
  const all: Record<string, unknown> = {
    ...taskData(env, channel, ts, task, task.link ?? ""),
    created_by: task.createdBy ?? "",
    completed_at: task.completedAt ? task.completedAt.slice(0, 16).replace("T", " ") : "",
    notes_link: task.notes?.url ?? "",
    summary: notes.summary ?? "",
    summary_by: notes.summaryBy ?? "",
    notes: notes.body ?? "",
    original_thread_state: state,
    original_thread: threadOut(original),
    ...prData(task),
  };
  const data = fields ? Object.fromEntries(["task_id", ...fields].map((field: string) => [field, all[field]])) : all;

  const people = (Object.entries(ROLES) as [Role, string][]).map(([key, label]) => `${label.toLowerCase()}: ${task.people[key].join(", ") || "—"}`).join("; ");
  const lines = [`Task "${task.title}" in #${where}`, `Task ID: ${channel}:${ts}`];
  if (want("status", "priority", "due_date", "incident")) {
    lines.push(`Status: ${statusName(task.status)}  ·  Priority: ${task.priority}${task.incident ? " (incident)" : ""}  ·  Due: ${task.dueDate || "—"}`);
  }
  if (want("owner", "reviewer", "tester", "created_by")) lines.push(`People: ${people}; raised by ${task.createdBy ?? "unknown"}`);
  if (want("link", "notes_link")) lines.push(`Links: ${[task.link && `thread ${task.link}`, task.notes?.url && `notes ${task.notes.url}`].filter(Boolean).join("; ") || "—"}`);
  if (want("summary", "summary_by")) {
    lines.push("", "Summary of the issue" + (notes.summary && notes.summaryBy ? ` (written by ${notes.summaryBy})` : "") + ":", notes.summary || "(none yet)");
  }
  if (want("notes")) lines.push("", "Notes written by people:", notes.body || "(none)");
  if (want("prs", "releases")) {
    const { prs, releases } = prData(task);
    lines.push("", "Pull requests:", ...(prs.length ? prs.map((pr) => `- ${pr.label} (${pr.state.toLowerCase().replace("_", " ")}): ${pr.url}`) : ["(none linked)"]));
    for (const release of releases) lines.push(`Release ${release.release_id} (${release.status.toLowerCase().replace("_", " ")}), sent by ${release.sent_by}${release.decided_by ? `, decided by ${release.decided_by}` : ""}: ${release.note} [${release.prs.length} PR${release.prs.length === 1 ? "" : "s"}]`);
  }
  if (want("original_thread", "original_thread_state")) {
    lines.push(
      "",
      original
        ? `Original thread (where the problem was first raised): thread ID ${original.channel}:${original.ts}, ${original.link}. Read it with get_thread_history.`
        : kept.length
          ? "Original thread: none, the task wasn't made from another thread."
          : "Original thread: unknown, no messages are kept for the task yet. Someone can send /cade resync with the task's link.",
    );
  }
  if (!fields) lines.push("Task thread (what was done about it): read it with get_task_history.");
  return { text: lines.join("\n"), data };
}

// The channel and ts of the task a call names by its `task_id`, or a ToolError.
function taskRef({ task_id: taskId }: { task_id?: string }) {
  if (taskId === undefined) throw new ToolError("Give a task_id, as get_tasks gives it.");
  const match = /^([CGD][A-Z0-9]+):(\d+\.\d+)$/.exec(String(taskId).trim());
  if (!match) throw new ToolError("A task ID is the channel and the message time joined by a colon, such as C0123ABCD:1700000000.000100. get_tasks gives them.");
  return { channel: match[1]!, ts: match[2]! };
}

// The first message of a task's thread, when it was made from another
// thread, names that thread (see moveMessage in commands/move.ts).
const MOVED_FROM = /^Moved from <@[UW][A-Z0-9]+>'s <([^|>]+)\|message>/;

// The channel and ts of the thread a task was made from, named by the first
// moved message among its kept ones, or null.
function sourceThreadOf(messages: { text?: string }[]) {
  const found = messages.map((message) => MOVED_FROM.exec(message.text ?? "")).find(Boolean);
  return found ? { ...linkedThread(found[1]!)!, link: found[1]!.replace(/&amp;/g, "&") } : null;
}

// The releases (PRs sent to the client for approval) of the tasks `user` can read, oldest first.
async function getReleases(env: AppEnv, user: string, { status, task_id: taskId, project, limit }: GetReleasesArgs) {
  const wanted = status ?? "PENDING_APPROVAL";
  const statuses: ReleaseStatus[] | null = wanted === "all" ? ["PENDING_APPROVAL", "APPROVED", "NOT_APPROVED"] : ["PENDING_APPROVAL", "APPROVED", "NOT_APPROVED"].includes(wanted) ? [wanted] : null;
  if (!statuses) throw new ToolError("status is PENDING_APPROVAL, APPROVED, NOT_APPROVED or all.");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_TASKS)) throw new ToolError(`limit is a whole number from 1 to ${MAX_TASKS}.`);
  const only = taskId === undefined ? null : taskRef({ task_id: taskId });
  const channel = project === undefined ? null : projectChannel(env, project);
  const found = (await releasesWithStatus(env, statuses)).filter((row) => (!only || (row.channel === only.channel && row.ts === only.ts)) && (!channel || row.channel === channel));
  const readable = new Map<string, boolean>();
  const visible: typeof found = [];
  for (const row of found) {
    if (!readable.has(row.channel)) readable.set(row.channel, (await readableName(env, row.channel, user)) !== null);
    if (readable.get(row.channel)) visible.push(row);
  }
  const shown = visible.slice(0, limit ?? DEFAULT_TASKS);
  const releases = shown.map(({ channel: c, ts, title, release }) => {
    const project = projects(env).find((pair) => pair.channel === c)?.name ?? c;
    return {
      ...releaseData(release),
      prs: release.prs.map((url) => ({ url, label: (({ repo, number }: { repo?: string; number?: string } = {}) => (repo ? `${repo}/${number}` : url))(parsePullRequest(url) ?? {}) })),
      task_id: `${c}:${ts}`,
      title,
      project,
    };
  });
  const label = wanted.toLowerCase().replace("_", " ");
  if (!releases.length) return { text: `There are no releases ${wanted === "all" ? "" : `${label} `}to show.`.replace("  ", " "), data: { total: 0, releases: [] } };
  const lines = releases.map((r, i) => `${i + 1}. ${r.project}: ${r.title} (${r.task_id}) — ${r.status.toLowerCase().replace("_", " ")}, sent by ${r.sent_by}${r.decided_by ? `, decided by ${r.decided_by}` : ""}\n   ${r.note}\n   PRs: ${r.prs.map((pr) => `${pr.label} ${pr.url}`).join(", ")}`);
  const more = visible.length > shown.length ? `\n…and ${visible.length - shown.length} more; raise limit (up to ${MAX_TASKS}).` : "";
  return { text: [`${visible.length} release${visible.length === 1 ? "" : "s"}, oldest first:`, ...lines].join("\n") + more, data: { total: visible.length, releases } };
}

// The channels Cade is in that `user` is in too, project channels first.
async function getChannels(env: AppEnv, user: string, { limit }: GetChannelsArgs) {
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
async function getChannelThreads(env: AppEnv, user: string, { channel_id: channel, days, with_replies: withReplies, limit }: GetChannelThreadsArgs) {
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

// Makes a task or incident for the person, from a thread or from scratch.
async function createTaskTool(env: AppEnv, user: string, args: CreateTaskArgs) {
  const title = String(args.title ?? "").trim().replace(/\s+/g, " ");
  if (!title) throw new ToolError("The title is empty.");
  if (title.length > MAX_TITLE) throw new ToolError(`The title is ${title.length} characters; keep it to ${MAX_TITLE} or fewer.`);
  const incident = args.incident === true;
  if (args.incident !== undefined && typeof args.incident !== "boolean") throw new ToolError("incident is true or false.");
  if (incident && (args.priority !== undefined || args.due_date !== undefined)) throw new ToolError("An incident is always Urgent and due immediately, so leave out priority and due_date.");
  if (args.priority !== undefined && !PRIORITIES[args.priority as Priority]) throw new ToolError(`priority is one of ${Object.keys(PRIORITIES).join(", ")}.`);
  const dueDate = args.due_date !== undefined ? dueDateOf(args.due_date) : "";
  let summary: string | undefined;
  if (args.summary !== undefined) {
    summary = String(args.summary).trim();
    if (!summary) throw new ToolError("The summary is empty.");
    if (summary.length > MAX_SUMMARY) throw new ToolError(`The summary is ${summary.length} characters; keep it to ${MAX_SUMMARY} or fewer.`);
    refuseSecrets(summary, "The summary");
  }

  // The thread to move into the task: one the person can read, that isn't a task or moved already.
  let source: { channel: string; ts: string } | undefined;
  if (args.thread_id !== undefined && args.link !== undefined) throw new ToolError("Give thread_id or link, not both.");
  if (args.thread_id !== undefined || args.link !== undefined) {
    source = args.thread_id !== undefined ? threadIdOf(args.thread_id) : threadOf(args.link);
    await readableChannel(env, user, source.channel);
    const { problem, moved } = await checkRoot(env, source.channel, source.ts);
    if (problem || moved) throw new ToolError(`I can't make a task from that thread: ${problem ?? moved}`);
  }

  // The project: named, or the one the thread is in, or the only one.
  const all = projects(env);
  let project: Project | undefined;
  if (args.project !== undefined) project = all.find((candidate) => candidate.name.toLowerCase() === String(args.project).trim().toLowerCase());
  else project = (source && all.find((candidate) => candidate.channel === source!.channel)) || (all.length === 1 ? all[0] : undefined);
  if (!project) {
    throw new ToolError(args.project !== undefined ? `There is no project called "${args.project}". They are: ${all.map((candidate) => candidate.name).join(", ")}.` : `Say which project to make it in with project: ${all.map((candidate) => candidate.name).join(", ")}. get_projects lists them.`);
  }
  if ((await readableName(env, project.channel, user)) === null) throw new ToolError("You aren't in that project's channel, so I can't make a task there for you.");

  if (!source) {
    const same = (await tasksWithStatuses(env, OPEN)).find((entry) => entry.channel === project!.channel && entry.task.title.trim().toLowerCase() === title.toLowerCase());
    if (same) throw new ToolError(`${project.name} already has an open ${same.task.incident ? "incident" : "task"} called "${same.task.title}" (${same.channel}:${same.ts}). Use it, or give this one a different title.`);
  }
  const task: Task = { title, status: "TODO", ...(incident ? { ...INCIDENT, incident: true } : { priority: (args.priority ?? "Medium") as Priority, dueDate }), people: noPeople(), createdBy: user };
  const ts = await createTask(env, task, { channel: project.channel, move: source });
  if (!ts) throw new ToolError(`Slack wouldn't take the ${incident ? "incident" : "task"} just now. Cade tries again in a few minutes, but without the summary, so check ${project.name}'s channel before trying again.`);

  const told = [`Created the ${incident ? "incident" : "task"} "${title}" in ${project.name}${source ? ", and asked for the thread to be moved into it" : ""}.`];
  if (summary !== undefined) told.push(await saveSummary(env, user, project.channel, ts, summary!));
  const made = await loadTask(env, project.channel, ts);
  console.log("Task created by MCP", { channel: project.channel, ts, by: user, incident, fromThread: Boolean(source), summary: summary?.length });
  return {
    text: `${told.join(" ")}${made?.link ? ` ${made.link}` : ""}`.trim(),
    data: { task_id: `${project.channel}:${ts}`, link: made?.link ?? "", project: project.name, incident, summary_saved: summary !== undefined, notes_link: made?.notes?.url ?? "" },
  };
}

// The projects whose channel `user` is in, one per line.
async function getProjects(env: AppEnv, user: string, _args: GetProjectsArgs) {
  const seen: { name: string; channel_id: string }[] = [];
  for (const project of projects(env)) {
    if ((await readableName(env, project.channel, user)) !== null) seen.push({ name: project.name, channel_id: project.channel });
  }
  const lines = seen.map((project) => `- ${project.name}: <#${project.channel_id}> (${project.channel_id})`);
  const text = lines.length ? [`${lines.length} project${lines.length === 1 ? "" : "s"}:`, ...lines].join("\n") : "There are no projects whose channel you're in.";
  return { text, data: { total: seen.length, projects: seen } };
}

// The channel of the project called `name` (any case), or a ToolError.
function projectChannel(env: AppEnv, name: unknown) {
  const found = projects(env).find((project) => project.name.toLowerCase() === String(name).trim().toLowerCase());
  if (!found) throw new ToolError(`There is no project called "${name}". get_projects lists them: ${projects(env).map((project) => project.name).join(", ")}.`);
  return found.channel;
}

// get_tasks' arguments, with what it works out from them for getAllTasks: the project's channel, which
// tasks done in the days asked count, whether those not done come first, and whose tasks they are.
type ListArgs = GetTasksArgs & { channel?: string; completed?: (task: Task) => boolean; openFirst?: boolean; assigned?: (task: Task) => boolean };

// The tasks the arguments ask for, of those in the channels the person can read.
async function getTasks(env: AppEnv, user: string, args: ListArgs) {
  const { assignees, roles, unassigned, limit, project, fields } = args;
  if (fields !== undefined && !(Array.isArray(fields) && fields.every((field) => TASK_FIELDS.includes(field)))) throw new ToolError(`fields is a list of: ${TASK_FIELDS.join(", ")}.`);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_TASKS)) throw new ToolError(`limit is a whole number from 1 to ${MAX_TASKS}.`);
  if (roles !== undefined && assignees === undefined) throw new ToolError('roles goes with assignees, the people to have them. Give assignees: ["me"] for your own.');
  if (unassigned && assignees !== undefined) throw new ToolError("unassigned can't be combined with assignees.");
  if (assignees !== undefined) {
    // "me" is whoever's API key it is; anyone else has to be someone in the workspace.
    const ids = new Set(assignees.map((id) => (id === "me" ? user : id)));
    await requireActiveUsers(env, [...ids].filter((id) => id !== user));
    const wanted = (roles ?? Object.keys(ROLES)) as Role[];
    args = { ...args, assigned: (task: Task) => wanted.some((role) => task.people[role].some((id) => ids.has(id))) };
  }
  if (project !== undefined) args = { ...args, channel: projectChannel(env, project) };
  if (args.completed_from !== undefined || args.completed_to !== undefined) {
    const day = (value: unknown, name: string) => (value === undefined ? undefined : dayOf(value, name));
    const [first, last] = [day(args.completed_from, "completed_from"), day(args.completed_to, "completed_to")];
    const inRange = ({ completedAt }: Task) => Boolean(completedAt) && (!first || completedAt!.slice(0, 10) >= first) && (!last || completedAt!.slice(0, 10) <= last);
    if (args.include_open) {
      if (args.status !== undefined && args.status !== "all") throw new ToolError("include_open can't be combined with status. It gives the tasks not done, and those done in the days.");
      // Open tasks as well as those done in the days; the open ones come first.
      args = { ...args, status: "all", completed: (task: Task) => OPEN.includes(task.status) || inRange(task), openFirst: true };
    } else {
      args = { ...args, status: args.status ?? "DONE", completed: inRange };
    }
  } else if (args.include_open) {
    throw new ToolError("include_open goes with completed_from or completed_to. Without them, open tasks are listed anyway.");
  }
  return getAllTasks(env, user, args);
}

// Orders tasks not done before those done (the sort is stable, so urgency holds within each).
const byOpenFirst = (a: { task: Task }, b: { task: Task }) => Number(!OPEN.includes(a.task.status)) - Number(!OPEN.includes(b.task.status));

// The tasks in the projects whose channels you can read, most urgent first: everyone's, or those
// `assigned` picks.
async function getAllTasks(env: AppEnv, user: string, { limit, status, assigned, unassigned, channel, fields, completed, openFirst }: ListArgs) {
  const { wanted, statuses } = statusFilter(status);
  const max = limit ?? DEFAULT_TASKS;
  const everyone = (task: Task) => (Object.keys(ROLES) as Role[]).flatMap((role) => task.people[role]);
  const found = (await tasksWithStatuses(env, statuses))
    .filter((entry) => !channel || entry.channel === channel)
    .filter(({ task }) => !completed || completed(task))
    .filter(({ task }) => (!assigned || assigned(task)) && (!unassigned || !everyone(task).length))
    .map(({ channel, ts, task }) => ({ channel, ts, task, incident: task.incident }))
    .sort(byUrgency)
    .sort(openFirst ? byOpenFirst : () => 0);

  // A channel's tasks are for those who can read it, so each is asked about once, as the tasks come.
  const readable = new Map<string, boolean>();
  const shown: typeof found = [];
  let allowed = 0;
  for (const entry of found) {
    if (!readable.has(entry.channel)) readable.set(entry.channel, (await readableName(env, entry.channel, user)) !== null);
    if (!readable.get(entry.channel)) continue;
    allowed++;
    if (shown.length < max) shown.push(entry);
  }
  if (!allowed) return { text: `There are no ${wanted === "open" ? "open " : ""}tasks you can see${statuses.length === 1 ? ` in ${statusName(wanted as Status)}` : ""}.`, data: { total: 0, tasks: [] } };
  const people = ({ task }: ListedTask) =>
    (Object.entries(ROLES) as [Role, string][]).map(([key, label]) => `${label.toLowerCase()}: ${task.people[key].join(", ") || "—"}`).join("; ");
  const more = allowed > shown.length ? `\n…and ${allowed - shown.length} more; raise limit (up to ${MAX_TASKS}) or filter by status to see them.` : "";
  const { lines, items } = await taskLines(env, shown, people, fields);
  return { text: [`${allowed} task${allowed === 1 ? "" : "s"}, showing the ${shown.length} most urgent:`, ...lines].join("\n") + more, data: { total: allowed, tasks: items } };
}

// A status argument as { wanted, statuses }: open (the default), all, or one status.
function statusFilter(status: unknown): { wanted: string; statuses: Status[] } {
  const wanted = (status ?? "open") as string;
  if (!["open", "all"].includes(wanted) && !STATUSES[wanted as Status]) throw new ToolError(`status is open, all or one of ${Object.keys(STATUSES).join(", ")}.`);
  return { wanted, statuses: wanted === "open" ? OPEN : wanted === "all" ? (Object.keys(STATUSES) as Status[]) : [wanted as Status] };
}

// The entries as sections, one per project (in PROJECTS order, then any other channel), each a
// "*Project*" line over its tasks: a numbered entry each (numbers run on across sections) with
// its priority, title, status and due date, `about(entry)`, its ID and its link. Gives
// { lines, items }: the text, and the tasks as data in the same order.
async function taskLines(env: AppEnv, entries: ListedTask[], about: (entry: ListedTask) => string, fields: string[] | undefined) {
  // A task made before its link was kept gets one built from the workspace's address.
  let base: string | undefined;
  const named = projects(env);
  const order = (channel: string) => {
    const at = named.findIndex((pair) => pair.channel === channel);
    return at < 0 ? named.length : at;
  };
  const sorted = entries.map((entry, i) => ({ entry, i })).sort((x, y) => order(x.entry.channel) - order(y.entry.channel) || x.i - y.i);
  const lines: string[] = [];
  const items: Record<string, unknown>[] = [];
  // The notes pages are read only when summary, notes or the like are asked for.
  const wantsNotes = (fields ?? []).some((field) => ["summary", "summary_by", "notes", "notes_link"].includes(field));
  const pages = wantsNotes ? await notesOf(env, entries.map(({ channel, ts }) => ({ channel, ts }))) : new Map();
  // Releases are read only when the pull requests are asked for.
  const releases = (fields ?? []).includes("prs") ? await releasesOfTasks(env, entries.map(({ channel, ts }) => ({ channel, ts }))) : new Map<string, Release[]>();
  let section: string | undefined;
  for (const [n, { entry }] of sorted.entries()) {
    const { channel, ts, task } = entry;
    if (section !== channel) {
      section = channel;
      lines.push(`*${named.find((pair) => pair.channel === channel)?.name ?? channel}*`);
    }
    if (!task.link && base === undefined) base = (await callSlack(env, "auth.test", {}).catch(() => ({}) as { url?: string })).url ?? "";
    const link = task.link || (base ? threadLink(base, channel, ts) : `${channel}/${ts}`);
    const due = task.dueDate ? `, due ${task.dueDate}` : "";
    lines.push(`${n + 1}. [${task.priority}]${task.incident ? " [Incident]" : ""} ${task.title} — ${statusName(task.status)}${due} (${about(entry)})\n   Task ID: ${channel}:${ts}\n   ${link}`);
    const page = pages.get(`${channel}:${ts}`);
    const all: Record<string, unknown> = {
      ...taskData(env, channel, ts, task, link),
      summary: page?.summary ?? "",
      summary_by: page?.summaryBy ?? "",
      notes: page?.body ?? "",
      notes_link: task.notes?.url ?? "",
      created_by: task.createdBy ?? "",
      prs: fields?.includes("prs") ? prData(task, releases.get(`${channel}:${ts}`) ?? []).prs : [],
      completed_at: task.completedAt ? task.completedAt.slice(0, 16).replace("T", " ") : "",
    };
    // Only the fields asked for, or the base ones.
    const item = fields ? Object.fromEntries(["task_id", ...fields].map((field) => [field, all[field]])) : Object.fromEntries(Object.entries(all).filter(([field]) => !(field in EXTRA_FIELDS)));
    items.push(item);
    for (const field of ["summary", "notes"]) if (fields?.includes(field)) lines.push(`   ${field === "summary" ? "Summary" : "Notes"}: ${String(all[field] || "(none)").replace(/\n/g, "\n   ")}`);
  }
  return { lines, items };
}

async function resolveUserName(env: AppEnv, user: string, { user_id: id, profile: withProfile }: GetUserArgs) {
  const match = /\b[UW][A-Z0-9]{2,}\b/.exec(String(id ?? ""));
  if (!match) throw new ToolError("That isn't a Slack user ID. They look like U0123ABCD.");
  try {
    const { user: found } = await callSlack(env, "users.info", { user: match[0] });
    const name = found.real_name || found.profile?.real_name || found.profile?.display_name || found.name || match[0];
    const handle = found.profile?.display_name;
    const shown = handle && handle !== name ? `${name} (${handle})` : name;
    const data: { user_id: string; name: string; handle: string; profile: { email: string; phone: string; title: string } | null } = { user_id: match[0], name, handle: handle && handle !== name ? handle : "", profile: null };
    if (!withProfile) return { text: shown, data };
    data.profile = { email: found.profile?.email ?? "", phone: found.profile?.phone ?? "", title: found.profile?.title ?? "" };
    const lines = [shown, `Email: ${data.profile.email || "(none)"}`, `Phone: ${data.profile.phone || "(none)"}`, `Title: ${data.profile.title || "(none)"}`];
    return { text: lines.join("\n"), data };
  } catch (error) {
    throw new ToolError(`I couldn't look up ${match[0]} (${error.message}).`);
  }
}

// The people of the workspace, up to `max` of those `keep(names)` accepts, as
// { line, total }: a "Name (handle): ID" line each, and how many there were in
// all (not counted past the pages read). Bots and deactivated accounts are left out.
async function workspacePeople(env: AppEnv, keep: (names: string[]) => boolean, max: number, fields: string[] | undefined) {
  const lines: string[] = [];
  const users: Record<string, unknown>[] = [];
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await callSlack(env, "users.list", { limit: PAGE, ...(cursor && { cursor }) }).catch((error) => {
      throw new ToolError(`I couldn't list the workspace's people (${error.message}).`);
    });
    for (const member of result.members ?? []) {
      if (member.deleted || member.is_bot || member.id === "USLACKBOT") continue;
      const names = [member.real_name, member.profile?.real_name, member.profile?.display_name, member.name].filter((name): name is string => Boolean(name));
      if (!keep(names)) continue;
      total++;
      if (lines.length < max) {
        const person: Record<string, string | undefined> = { user_id: member.id, name: names[0], username: member.name ?? names.at(-1) };
        const shown = fields ?? USER_FIELDS;
        const label = shown.includes("name") && shown.includes("username") ? `${person.name} (${person.username}): ` : shown.length ? `${person[shown[0]!]}: ` : "";
        lines.push(`${label}${member.id}`);
        users.push(fields ? Object.fromEntries(["user_id", ...fields].map((field) => [field, person[field]])) : person);
      }
    }
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return { lines, users, total };
}

// A ToolError unless `fields` is undefined or a list of USER_FIELDS.
function checkUserFields(fields: unknown) {
  if (fields !== undefined && !(Array.isArray(fields) && fields.every((field) => USER_FIELDS.includes(field)))) throw new ToolError(`fields is a list of: ${USER_FIELDS.join(", ")}.`);
}

// Slack users whose name matches, to give a user ID to assign.
async function findUser(env: AppEnv, user: string, { name, fields }: FindUserByNameArgs) {
  checkUserFields(fields);
  const wanted = String(name ?? "").trim().toLowerCase().replace(/^@/, "");
  if (wanted.length < 2) throw new ToolError("Give at least two letters of the person's name.");
  const { lines, users, total } = await workspacePeople(env, (names) => names.some((candidate) => candidate.toLowerCase().includes(wanted)), MAX_MATCHES, fields);
  if (!total) return { text: `No one in the workspace matches "${name}".`, data: { total: 0, users: [] } };
  return { text: [`${total} match${total === 1 ? "" : "es"}${total > lines.length ? `, showing ${lines.length}` : ""}:`, ...lines].join("\n"), data: { total, users } };
}

// The people of the workspace, by name, with their user IDs.
async function getUsers(env: AppEnv, user: string, { limit, fields }: GetUsersArgs) {
  checkUserFields(fields);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_USERS)) throw new ToolError(`limit is a whole number from 1 to ${MAX_USERS}.`);
  const { lines, users, total } = await workspacePeople(env, () => true, limit ?? DEFAULT_USERS, fields);
  if (!total) return { text: "No one is in the workspace.", data: { total: 0, users: [] } };
  return { text: [`${total} ${total === 1 ? "person" : "people"}${total > lines.length ? `, showing the first ${lines.length}; raise limit (up to ${MAX_USERS}) or use find_user_by_name` : ""}:`, ...lines].join("\n"), data: { total, users } };
}

// Slack status text that means the person is not around.
const AWAY_STATUS = /vacation|holiday|leave|sick|ill\b|ooo|out of office|off work|away|travell?ing|day off|pto/i;

// One person's room for work, as getTeamAvailability gives it for the team.
async function getAvailability(env: AppEnv, user: string, { user_id, project, fields }: GetAvailabilityArgs) {
  if (!/^[UW][A-Z0-9]{2,}$/.test(String(user_id ?? ""))) throw new ToolError("user_id is a Slack user ID such as U0123ABCD. find_user_by_name gives them.");
  const result = await getTeamAvailability(env, user, { users: [user_id], project, fields });
  if (!result.data.people.length) throw new ToolError(project !== undefined ? `${user_id} isn't in ${project}'s channel, or isn't an active person in the workspace.` : `There is no active person ${user_id} in the workspace.`);
  return { text: result.text.split("\n").slice(1).join("\n").replace(/^1\. /, ""), data: { person: result.data.people[0] } };
}

// Who in the team has room for work: each person's open tasks, their Slack status and, if asked, presence.
async function getTeamAvailability(env: AppEnv, user: string, { users, project, fields, limit }: GetTeamAvailabilityArgs) {
  if (fields !== undefined && !(Array.isArray(fields) && fields.every((field) => AVAILABILITY_FIELDS.includes(field)))) throw new ToolError(`fields is a list of: ${AVAILABILITY_FIELDS.join(", ")}.`);
  const presence = fields?.includes("presence") ?? false;
  const shown = fields ?? AVAILABILITY_FIELDS.filter((field) => field !== "presence");
  if (users !== undefined && !(Array.isArray(users) && users.every((id) => /^[UW][A-Z0-9]{2,}$/.test(String(id))))) throw new ToolError("users is a list of Slack user IDs such as U0123ABCD. find_user_by_name gives them.");
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_USERS)) throw new ToolError(`limit is a whole number from 1 to ${MAX_USERS}.`);
  // A project's people are those in its channel (a private one's only for someone in it to ask about), and
  // asking for others in it finds no one.
  const channel = project !== undefined ? (await readableProject(env, user, project)).channel : undefined;
  const team = channel ? await channelMembers(env, channel).catch((error) => {
    throw new ToolError(`I couldn't read who is in ${project}'s channel (${error.message}).`);
  }) : null;
  const wanted = team ? new Set<string>((users ?? team).filter((id: string) => team.includes(id))) : users ? new Set<string>(users) : null;

  const members: SlackUser[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await callSlack(env, "users.list", { limit: PAGE, ...(cursor && { cursor }) }).catch((error) => {
      throw new ToolError(`I couldn't list the workspace's people (${error.message}).`);
    });
    for (const member of result.members ?? []) {
      if (member.deleted || member.is_bot || member.id === "USLACKBOT") continue;
      if (wanted && !wanted.has(member.id)) continue;
      members.push(member);
    }
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  // Every open task counts, in channels you aren't in too: someone's load is all their work, and only
  // numbers are given, never which tasks. With a project, only its channel's.
  const today = todayIn(env);
  const load = new Map<string, { owner: number; reviewer: number; tester: number; overdue: Set<string>; hot: Set<string>; all: Set<string> }>();
  for (const { channel: where, ts, task } of await tasksWithStatuses(env, OPEN)) {
    if (channel && where !== channel) continue;
    const due = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(task.dueDate ?? "");
    const late = Boolean(due) && `${due![3]}-${due![2]}-${due![1]}` < today;
    for (const role of Object.keys(ROLES) as Role[]) {
      for (const id of task.people[role]) {
        const mine = load.get(id) ?? { owner: 0, reviewer: 0, tester: 0, overdue: new Set<string>(), hot: new Set<string>(), all: new Set<string>() };
        const key = where + ts;
        mine[role]++;
        mine.all.add(key);
        if (late) mine.overdue.add(key);
        if (["Urgent", "High"].includes(task.priority)) mine.hot.add(key);
        load.set(id, mine);
      }
    }
  }

  const now = Date.now() / 1000;
  let people: { user_id: string; name: string; open_tasks: number; owner: number; reviewer: number; tester: number; overdue: number; urgent_or_high: number; status: string; status_until: string; time_zone: string; away: boolean; presence?: string }[] = members.map((member) => {
    const mine = load.get(member.id);
    const status = member.profile?.status_text ?? "";
    const until = member.profile?.status_expiration;
    const active = status && (!until || until > now);
    return {
      user_id: member.id,
      name: member.real_name ?? member.profile?.real_name ?? member.name ?? "",
      open_tasks: mine?.all.size ?? 0,
      owner: mine?.owner ?? 0,
      reviewer: mine?.reviewer ?? 0,
      tester: mine?.tester ?? 0,
      overdue: mine?.overdue.size ?? 0,
      urgent_or_high: mine?.hot.size ?? 0,
      status: active ? status : "",
      status_until: active && until ? new Date(until * 1000).toISOString().slice(0, 10) : "",
      time_zone: member.tz ?? "",
      away: Boolean(active && AWAY_STATUS.test(status)),
    };
  });
  const total = people.length;
  // Booleans subtract as 0 and 1: those away go last.
  people.sort((a, b) => Number(a.away) - Number(b.away) || a.open_tasks - b.open_tasks || a.urgent_or_high - b.urgent_or_high || a.overdue - b.overdue || a.name.localeCompare(b.name));
  people = people.slice(0, limit ?? DEFAULT_USERS);

  if (presence) {
    if (people.length > MAX_PRESENCE) throw new ToolError(`presence looks up each person in Slack, so it takes at most ${MAX_PRESENCE} people. Pass users or a smaller limit.`);
    await Promise.all(people.map(async (person) => {
      const result = await callSlack(env, "users.getPresence", { user: person.user_id }).catch(() => null);
      person.presence = result?.presence === "active" ? "active" : result?.presence === "away" ? "away" : "unknown";
    }));
  }
  if (!people.length) return { text: "No one matches.", data: { total: 0, people: [] } };
  const lines = people.map((person, index) => {
    const has = (field: string) => shown.includes(field);
    const parts: string[] = [];
    if (has("open_tasks")) parts.push(`${person.open_tasks} open${has("owner") || has("reviewer") || has("tester") ? ` (owner ${person.owner}, reviewer ${person.reviewer}, tester ${person.tester})` : ""}`);
    if (has("overdue") && person.overdue) parts.push(`${person.overdue} overdue`);
    if (has("urgent_or_high") && person.urgent_or_high) parts.push(`${person.urgent_or_high} urgent/high`);
    if (has("status") && person.status) parts.push(`status: ${person.status}${has("status_until") && person.status_until ? ` until ${person.status_until}` : ""}`);
    if (has("away") && person.away) parts.push("away");
    if (person.presence) parts.push(person.presence);
    if (has("time_zone") && person.time_zone) parts.push(person.time_zone);
    return `${index + 1}. ${has("name") ? `${person.name} (${person.user_id})` : person.user_id}${parts.length ? `: ${parts.join("; ")}` : ""}`;
  });
  const more = total > people.length ? `\n…and ${total - people.length} more; raise limit or pass users.` : "";
  const out = people.map((person) => Object.fromEntries(Object.entries(person).filter(([key]) => key === "user_id" || shown.includes(key))));
  return { text: [`${people.length} ${people.length === 1 ? "person" : "people"}, least loaded first:`, ...lines].join("\n") + more, data: { total, people: out } };
}

// The text of a message from an agent with only people's mentions left in it:
// everything else, such as <!channel> and links, is shown as typed.
function plainMessage(text: string) {
  return escapeSlack(text).replace(/&lt;@([UW][A-Z0-9]{2,})&gt;/g, "<@$1>");
}

// Posts the person's message in a thread, as Cade, led by who sent it and ending with (via AI agent):
// a task's thread, or any other in a channel the person can read.
async function sendThreadMessage(env: AppEnv, user: string, args: SendThreadMessageArgs) {
  if (args.thread_id !== undefined && args.link !== undefined) throw new ToolError("Give thread_id or link, not both.");
  const { channel, ts } = args.thread_id !== undefined ? threadIdOf(args.thread_id) : threadOf(args.link);
  const task = await loadTask(env, channel, ts);
  if (task && (await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't post there for you.");
  const message = String(args.text ?? "").trim();
  if (!message) throw new ToolError("The message is empty.");
  if (message.length > MAX_MESSAGE) throw new ToolError(`The message is ${message.length} characters; keep it to ${MAX_MESSAGE} or fewer.`);
  // A message telling the thread what a client call decided is sent once, and marks the task as told.
  const summaryId = args.summary_id;
  if (summaryId !== undefined) {
    if (!task) throw new ToolError("summary_id is only for a task's thread, and that thread isn't a task Cade tracks. Send without summary_id.");
    const item = Number.isInteger(summaryId) ? (await summaryItems(env, summaryId)).after.find((entry) => entry.channel === channel && entry.ts === ts) : undefined;
    if (!item) throw new ToolError(`Summary #${summaryId} has no after-call entry for that task. Record the call first with update_executive_summary_after_call, or send without summary_id.`);
    if (item.informedAt) throw new ToolError(`That task's thread was already told about summary #${summaryId} on ${timeOf(item.informedAt)} UTC, so I haven't sent it again. Send without summary_id to post anyway.`);
  }
  refuseSecrets(message, "The message");
  await requireActiveUsers(env, [...message.matchAll(/<@([UW][A-Z0-9]{2,})>/g)].map((match) => match[1]!));
  if (!task) await reachableThread(env, user, channel, ts);
  const body = plainMessage(message);
  const from = `<@${user}> sent:`;
  const via = "_(via AI agent)_";
  await callSlack(env, "chat.postMessage", {
    channel,
    thread_ts: ts,
    text: `${from}\n${body}\n${via}`,
    blocks: [
      { type: "section", text: mrkdwn(`${from}\n${body}`) },
      { type: "context", elements: [mrkdwn(via)] },
    ],
  });
  if (summaryId !== undefined) await markSummaryInformed(env, summaryId, channel, ts, user);
  console.log(task ? "Task message sent" : "Thread message sent", { channel, ts, by: user, characters: message.length });
  // The person is told where it was posted, so a thread named by its ID gets a link too.
  const link = (task ? task.link : args.link) || (await linkToThread(env, channel, ts));
  return {
    text: `Posted in the ${task ? "task's " : ""}thread${link ? `: ${link}` : "."}${summaryId !== undefined ? ` Marked as told for summary #${summaryId}.` : ""}`,
    data: { task_id: task ? `${channel}:${ts}` : "", thread_id: `${channel}:${ts}`, sent: true, link },
  };
}

// A link to a thread, made from the workspace's address, or "" when Slack won't give that.
async function linkToThread(env: AppEnv, channel: string, ts: string) {
  const { url } = await callSlack(env, "auth.test", {}).catch(() => ({}) as { url?: string });
  return url ? threadLink(url, channel, ts) : "";
}

// The DD/MM/YYYY date a due_date argument names, "" for none, or a ToolError.
function dueDateOf(value: unknown) {
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
function userIds(role: string, list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ToolError(`${role} takes lists of user IDs.`);
  const ids = list.map((id) => String(id).trim().replace(/^<@([^>|]+).*>$/, "$1"));
  const bad = ids.find((id) => !/^[UW][A-Z0-9]{2,}$/.test(id));
  if (bad) throw new ToolError(`"${bad}" isn't a Slack user ID for ${role}. find_user_by_name gives them.`);
  return [...new Set(ids)];
}

// A ToolError unless every ID is an active person of the workspace: not a made-up ID, a bot or a
// deactivated account, which would be saved on a task or mentioned and notify no one.
async function requireActiveUsers(env: AppEnv, ids: string[]) {
  await Promise.all([...new Set(ids)].map(async (id) => {
    const found = await callSlack(env, "users.info", { user: id }).catch((error) => {
      if (!/user_not_found/.test(error.message)) throw new ToolError(`I couldn't check ${id} (${error.message}).`);
      return null;
    });
    if (!found?.user || found.user.deleted || found.user.is_bot) throw new ToolError(`${id} isn't an active person in the workspace. find_user_by_name gives the IDs.`);
  }));
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
function refuseSecrets(text: unknown, where: string) {
  const found = SECRETS.find(([, pattern]) => pattern.test(String(text ?? "")));
  if (found) throw new ToolError(`${where} looks like it contains a ${found[0]}. Leave secrets out and send it again.`);
}

// The pull request addresses in a list of links, without duplicates, or a ToolError.
function prLinksOf(list: unknown, name: string): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ToolError(`${name} is a list of pull request links.`);
  return [...new Set(list.map((link) => {
    const pr = parsePullRequest(String(link).trim().replace(/^<|>$/g, ""));
    if (!pr) throw new ToolError(`"${link}" doesn't look like a pull request link (GitHub, GitLab or Bitbucket).`);
    return pr.url;
  }))];
}

// Changes the PRs, or what it completes, of a release waiting for approval, and tells its thread. It
// is never decided here: that is the approver's click (see release.ts).
async function updateRelease(env: AppEnv, user: string, { release_id: id, prs, note }: UpdateReleaseArgs) {
  if (!Number.isInteger(id) || id < 1) throw new ToolError("release_id is the number get_releases gives each release.");
  const found = await releaseById(env, id);
  if (!found) throw new ToolError("There is no such release, or its task is gone. get_releases lists them.");
  const { channel, ts, release } = found;
  if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't change its release for you.");
  if (release.status !== "PENDING_APPROVAL") throw new ToolError(`That release is already ${release.status === "APPROVED" ? "approved" : "decided"}; only one waiting for approval can be changed.`);
  if (!release.messageTs || !release.approver) throw new ToolError("I don't have that release's request message, so I can't change it. Change it in the task's thread in Slack.");

  const task = (await loadTask(env, channel, ts))!;
  const add = prLinksOf(prs?.add, "prs.add");
  const remove = prLinksOf(prs?.remove, "prs.remove");
  if (add.some((url) => remove.includes(url))) throw new ToolError("prs: the same pull request is in add and remove.");
  const elsewhere = new Set(task.releases!.filter((other) => other.id !== id).flatMap((other) => other.prs));
  const unlinked = add.filter((url) => !task.prs!.includes(url));
  if (unlinked.length) throw new ToolError(`${unlinked.join(", ")} ${unlinked.length === 1 ? "isn't" : "aren't"} linked to the task yet. Link ${unlinked.length === 1 ? "it" : "them"} first with update_task (prs.add).`);
  const taken = add.filter((url) => elsewhere.has(url));
  if (taken.length) throw new ToolError(`${taken.join(", ")} ${taken.length === 1 ? "is" : "are"} in another release already.`);
  const missing = remove.filter((url) => !release.prs.includes(url));
  if (missing.length) throw new ToolError(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in this release.`);
  let text = release.note;
  if (note !== undefined) {
    text = String(note).trim();
    if (!text) throw new ToolError("The note is empty.");
    if (text.length > MAX_RELEASE_NOTE) throw new ToolError(`The note is ${text.length} characters; keep it to ${MAX_RELEASE_NOTE} or fewer.`);
  }
  const next = [...release.prs.filter((url) => !remove.includes(url)), ...add.filter((url) => !release.prs.includes(url))];
  if (!next.length) throw new ToolError("A release needs at least one pull request. To take it back, tell the person to settle it in the task's thread.");

  const taskId = `${channel}:${ts}`;
  const unchanged = next.length === release.prs.length && next.every((url) => release.prs.includes(url)) && text === release.note;
  const updated = { ...release, prs: next, note: text };
  if (!unchanged) {
    if (!(await changeRelease(env, id, next, text))) throw new ToolError("That release was decided just now, so it can't be changed.");
    task.releases = task.releases!.map((other) => (other.id === id ? updated : other));
    await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
    // The request the approver sees, with its buttons; and a reply, since mentions in an edit notify no one.
    await callSlack(env, "chat.update", { channel, ts: release.messageTs, ...releaseRequest({ channel, ts, id, approver: release.approver!, sentBy: release.sentBy, prs: next, note: text }) });
    const reply = `${mentions([...new Set([release.approver, release.sentBy])])}: <@${user}> changed this release. It now has ${next.map(prLink).join(", ")}.\n*Completes:* ${escapeSlack(text)}\n_(via AI agent)_`;
    await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: reply, blocks: [{ type: "section", text: mrkdwn(reply) }] });
    console.log("Release changed", { channel, ts, id, by: user, prs: next.length });
  }
  const data = { release_id: id, task_id: taskId, changed: !unchanged, release: releaseData(updated) };
  return { text: unchanged ? "The release already has those PRs and that note." : `Done. The release now has ${next.length} PR${next.length === 1 ? "" : "s"}; the approver's request and the thread are updated.`, data };
}

// Changes a task's fields for the person, and tells its thread.
async function updateTask(env: AppEnv, user: string, args: UpdateTaskArgs) {
  const { channel, ts } = taskRef(args);
  const task = await loadTask(env, channel, ts);
  if (!task) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks, or the link to its message.");
  if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't change it for you.");

  const changes: Changes = {};
  if (args.status !== undefined) {
    const status = parseStatus(String(args.status));
    if (!status) throw new ToolError(`status is one of ${Object.keys(STATUSES).join(", ")}.`);
    if (task.status === "CLIENT_REVIEW" && status !== task.status) throw new ToolError("This task is in Client review: it waits for the client's approver, who approves it or sends it back in the task's thread in Slack. Tell the person, and don't change its status here.");
    changes.status = status;
  }
  if (args.priority !== undefined) {
    if (!PRIORITIES[args.priority as Priority]) throw new ToolError(`priority is one of ${Object.keys(PRIORITIES).join(", ")}.`);
    changes.priority = args.priority;
  }
  if (args.due_date !== undefined) changes.dueDate = dueDateOf(args.due_date);
  if (args.has_subtasks !== undefined) {
    if (typeof args.has_subtasks !== "boolean") throw new ToolError("has_subtasks is true or false.");
    changes.subtasks = args.has_subtasks;
  }
  if (args.blocked !== undefined || args.blocked_reason !== undefined) {
    if (args.blocked !== undefined && typeof args.blocked !== "boolean") throw new ToolError("blocked is true or false.");
    if (args.blocked_reason !== undefined && typeof args.blocked_reason !== "string") throw new ToolError("blocked_reason is text.");
    if (args.blocked === false && args.blocked_reason) throw new ToolError("blocked_reason goes with blocked: true.");
    if (args.blocked === undefined && !task.blocked) throw new ToolError("blocked_reason needs blocked: true, as the task isn't blocked.");
    changes.blocked = args.blocked === false ? { on: false } : { on: true, reason: args.blocked_reason };
  }
  for (const role of Object.keys(ROLES) as Role[]) {
    if (args[role] === undefined) continue;
    const add = userIds(role, args[role].add);
    const remove = userIds(role, args[role].remove);
    if (add.some((id) => remove.includes(id))) throw new ToolError(`${role}: the same person is in add and remove.`);
    changes.people = { ...changes.people, [role]: { add, remove } };
  }
  await requireActiveUsers(env, Object.values(changes.people ?? {}).flatMap(({ add = [] }) => add));
  const prs = args.prs;
  if (prs !== undefined) {
    const links = (name: "add" | "remove") => prLinksOf(prs[name], `prs.${name}`);
    const add = links("add");
    const remove = links("remove");
    if (add.some((url) => remove.includes(url))) throw new ToolError("prs: the same pull request is in add and remove.");
    // One sent to the client is part of a release; whether it stands is theirs and the team's to settle in Slack.
    const sent = remove.filter((url) => !unsentPrs(task).includes(url) && task.prs!.includes(url));
    if (sent.length) throw new ToolError(`${sent.join(", ")} ${sent.length === 1 ? "was" : "were"} sent to the client for approval, so I can't unlink ${sent.length === 1 ? "it" : "them"}. Tell the person to settle it in the task's thread.`);
    changes.prs = { add, remove };
  }
  let summary: string | undefined;
  if (args.summary !== undefined) {
    summary = String(args.summary).trim();
    if (!summary) throw new ToolError("The summary is empty.");
    if (summary.length > MAX_SUMMARY) throw new ToolError(`The summary is ${summary.length} characters; keep it to ${MAX_SUMMARY} or fewer.`);
    refuseSecrets(summary, "The summary");
  }
  if (!Object.keys(changes).length && summary === undefined) throw new ToolError("Nothing to change: give a status, priority, due_date, has_subtasks, blocked, owner, reviewer, tester, prs or summary.");

  const skipped = task.incident && ("priority" in changes || "dueDate" in changes) ? " An incident's priority and due date never change, so those were left alone." : "";
  const told: string[] = [];
  let changed = false;
  if (Object.keys(changes).length) {
    // The thread says it was an AI agent, and Slack shows the person no private prompt: they are not looking at it.
    changed = await applyChanges(env, { channel, ts }, changes, user, { source: "mcp" });
    told.push(changed ? `The change is posted in the task's thread.${skipped}` : `The task already had those values.${skipped}`);
    if (changed && changes.status === "CLIENT_REVIEW") told.push("It is in Client review now: ask the person who should approve it, then call send_approval_request.");
  }
  if (summary !== undefined) told.push(await saveSummary(env, user, channel, ts, summary));
  console.log("Task updated", { channel, ts, by: user, fields: Object.keys(changes), summary: summary?.length });
  const now = await loadTask(env, channel, ts);
  return {
    text: `${changed || summary !== undefined ? "Done." : "Nothing changed."} ${told.join(" ")}`,
    data: { task_id: `${channel}:${ts}`, changed, summary_saved: summary !== undefined, notes_link: now?.notes?.url ?? "" },
  };
}

// The project called `name` whose channel `user` can read, or a ToolError.
async function readableProject(env: AppEnv, user: string, name: unknown): Promise<Project> {
  const channel = projectChannel(env, name);
  const group = projects(env).find((pair) => pair.channel === channel);
  if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that project's channel.");
  return group!;
}

// A day argument (YYYY-MM-DD) as given, or a ToolError.
function dayOf(value: unknown, name: string) {
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text) {
    throw new ToolError(`${name} is a day written YYYY-MM-DD, such as 2026-11-06.`);
  }
  return text;
}

const timeOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "");
const taskIdOf = (item: { channel?: string; ts?: string }) => (item.channel ? `${item.channel}:${item.ts}` : "");
const docError = (env: AppEnv, group: Project) => {
  const problem = docProblem(env, group);
  if (problem) throw new ToolError(problem);
};

// A summary as the tools give it, with its two versions side by side.
async function summaryData(env: AppEnv, summary: Summary) {
  const rows = compareVersions(await summaryItems(env, summary.id));
  const days = period(env, summary);
  return {
    summary_id: summary.id,
    created_at: timeOf(summary.createdAt),
    created_by: summary.createdBy,
    from: days.from,
    to: days.to,
    doc_url: summary.docUrl ?? "",
    call: summary.callAt ? { notes: summary.callNotes ?? "", recorded_by: summary.callBy ?? "", recorded_at: timeOf(summary.callAt) } : null,
    items: rows.map((row) => ({ task_id: taskIdOf(row), title: row.title, status: row.status, incident: row.incident, kind: row.kind, before: row.before, after: row.after, change: row.change, informed_at: timeOf(row.informedAt) })),
  };
}

// One side of an item as a line of text.
const said = (version: { included?: boolean; health?: string | null; progress?: string; notes?: string } | null | undefined) => (version ? `${version.included ? "" : "left out · "}${[version.health, version.progress].filter(Boolean).join(" · ")}${version.notes ? ` — ${version.notes.replace(/\n+/g, " / ")}` : ""}` || "included" : "—");

// An executive summary Cade kept: the last, or the one in force on a day, with what it said before and after the call.
async function getExecutiveSummary(env: AppEnv, user: string, { project, date }: GetExecutiveSummaryArgs) {
  const group = await readableProject(env, user, project);
  const found = date === undefined ? await lastSummary(env, group.name) : (await summariesOf(env, group.name, { onOrBefore: dayBoundary(env, dayOf(date, "date"), { end: true }), limit: 1 }))[0];
  const others = (await summariesOf(env, group.name, { limit: MAX_EARLIER_SUMMARIES + 1 })).filter((other) => other.id !== found?.id).slice(0, MAX_EARLIER_SUMMARIES);
  const earlier = others.map((other) => ({ summary_id: other.id, created_at: timeOf(other.createdAt), from: period(env, other).from, to: period(env, other).to }));
  if (!found) {
    const text = date === undefined ? `${group.name} has no executive summary yet. Write one with create_executive_summary.` : `${group.name} has no executive summary written on or before ${date}.`;
    return { text: earlier.length ? `${text} Others: ${earlier.map((other) => `#${other.summary_id} (${other.from} to ${other.to})`).join(", ")}.` : text, data: { project: group.name, summary: null, earlier } };
  }
  const data = await summaryData(env, found);
  const lines = [`${group.name} executive summary #${data.summary_id}, ${periodLabel(env, found)}, written ${data.created_at} UTC: ${data.doc_url}`];
  lines.push(data.call ? `The client call was recorded ${data.call.recorded_at} UTC${data.call.notes ? `: ${data.call.notes}` : "."}` : "No client call is recorded for it yet.");
  for (const kind of ["COMPLETED", "ACTIVE", "ADDED"]) {
    const these = data.items.filter((item) => item.kind === kind);
    if (!these.length) continue;
    lines.push("", `${({ COMPLETED: "Completed", ACTIVE: "Not done", ADDED: "Added in the call" } as Record<string, string>)[kind]} (${these.length}):`);
    for (const item of these) {
      const told = item.change === "pending" || item.change === "unchanged" || !item.task_id ? "" : item.informed_at ? `, thread told ${item.informed_at}` : ", thread not told yet";
      lines.push(`- ${item.incident ? "[Incident] " : ""}${item.title}${item.task_id ? ` (${item.task_id})` : ""} — ${item.change}${told}\n    before: ${said(item.before)}${item.after ? `\n    after:  ${said(item.after)}` : ""}`);
    }
  }
  if (earlier.length) lines.push("", `Earlier: ${earlier.map((other) => `#${other.summary_id} (${other.from} to ${other.to})`).join(", ")}.`);
  return { text: lines.join("\n"), data: { project: group.name, summary: data, earlier } };
}

// A summary's section as it reads in the Google Doc now.
async function getExecutiveSummaryDoc(env: AppEnv, user: string, { project, summary_id: id }: GetExecutiveSummaryDocArgs) {
  const group = await readableProject(env, user, project);
  docError(env, group);
  const found = id === undefined ? await lastSummary(env, group.name) : await getSummary(env, Number.isInteger(id) ? id : 0);
  if (!found || found.project !== group.name || !found.publishedAt) throw new ToolError(id === undefined ? `${group.name} has no executive summary yet. create_executive_summary writes one.` : `${group.name} has no summary #${id}. get_executive_summary lists them.`);
  const lines = await readSummaryDoc(env, found);
  if (!lines) throw new ToolError(`I couldn't find summary #${found.id} in its Google Doc any more. Was its heading deleted?`);
  const text = [`Summary #${found.id} as it reads in the Google Doc now (${found.docUrl}). [new] marks a line people added:`, ...lines.map((line) => `${"  ".repeat(line.level)}${line.type === "heading" ? "# " : line.type === "item" ? "- " : ""}${line.text}${line.task_id ? ` (${line.task_id})` : ""}${line.written ? "" : "  [new]"}`)];
  return { text: text.join("\n"), data: { project: group.name, summary_id: found.id, doc_url: found.docUrl, lines } };
}

// The health, progress and notes an agent gave a task, checked, with only what it gave.
function choiceOf(item: { included?: boolean; health?: string; progress?: string; notes?: string }) {
  refuseSecrets(`${item.progress ?? ""}\n${item.notes ?? ""}`, "The progress or notes");
  if (item.health !== undefined && !HEALTH[item.health as keyof typeof HEALTH]) throw new ToolError(`health is one of ${Object.keys(HEALTH).join(", ")}.`);
  return {
    ...(item.included !== undefined && { included: Boolean(item.included) }),
    ...(item.health !== undefined && { health: item.health }),
    ...(item.progress !== undefined && { progress: String(item.progress).trim().slice(0, MAX_PROGRESS) }),
    ...(item.notes !== undefined && { notes: String(item.notes).trim().slice(0, MAX_ITEM_NOTES) }),
  };
}

// Writes an executive summary to the project's Google Doc, with what the person chose for each task.
async function createExecutiveSummary(env: AppEnv, user: string, { project, from, to, items = [] }: CreateExecutiveSummaryArgs) {
  const group = await readableProject(env, user, project);
  docError(env, group);
  if (!Array.isArray(items)) throw new ToolError("items is a list of { task_id, included?, health?, progress?, notes? }.");
  if (items.length > MAX_SUMMARY_ITEMS) throw new ToolError(`items has ${items.length} entries; give at most ${MAX_SUMMARY_ITEMS}. A task not listed keeps what the last summary said.`);
  const base = await defaultPeriod(env, group);
  const days = { from: from === undefined ? base.from : dayOf(from, "from"), to: to === undefined ? base.to : dayOf(to, "to") };
  if (days.from > days.to) throw new ToolError(`The period starts ${days.from}, after it ends ${days.to}. Give from and to, YYYY-MM-DD, with from first.`);
  const choices = items.map((item) => ({ ...taskRef(item), ...choiceOf(item) }));
  const { url } = await callSlack(env, "auth.test", {});
  let written: Awaited<ReturnType<typeof writeSummary>>;
  try {
    written = await writeSummary(env, group, { user, since: dayBoundary(env, days.from), until: dayBoundary(env, days.to, { end: true }), choices, url });
  } catch (error) {
    if (error instanceof SummaryError) throw new ToolError(error.message);
    console.warn("Could not add the executive summary to the doc", { project: group.name, error: error.message });
    throw new ToolError("I couldn't add the summary to the Google Doc just now. Try again.");
  }
  const carried = written.carried.map((entry) => `${entry.channel}:${entry.ts}`);
  console.log("Executive summary written", { id: written.summary.id, project: group.name, user });
  const text = [`Wrote summary #${written.summary.id} for ${days.from} to ${days.to} to ${group.name}'s Google Doc: ${written.address}`];
  if (written.carried.length) text.push(`Not listed, so they kept what the last summary said: ${written.carried.map((entry) => entry.title).join("; ")}.`);
  text.push("After the client call, read the doc back (get_executive_summary_doc) and compare it with get_executive_summary.");
  return { text: text.join("\n"), data: { project: group.name, summary_id: written.summary.id, from: days.from, to: days.to, doc_url: written.address, carried_over: carried } };
}

// Records the summary as agreed in the client call, next to the one that was written.
async function updateAfterCall(env: AppEnv, user: string, { summary_id: id, items = [], added = [], notes }: UpdateExecutiveSummaryAfterCallArgs) {
  const summary = Number.isInteger(id) ? await getSummary(env, id) : null;
  if (!summary || !summary.publishedAt) throw new ToolError("There is no such summary. get_executive_summary lists them.");
  const group = projects(env).find((pair) => pair.name === summary.project);
  if (!group || (await readableName(env, group.channel, user)) === null) throw new ToolError("You aren't in that summary's project channel.");
  if (!Array.isArray(items) || !Array.isArray(added)) throw new ToolError("items and added are lists.");
  if (items.length > MAX_SUMMARY_ITEMS) throw new ToolError(`items has ${items.length} entries; give at most ${MAX_SUMMARY_ITEMS}.`);
  if (added.length > MAX_ADDED_ITEMS) throw new ToolError(`added has ${added.length} entries; give at most ${MAX_ADDED_ITEMS}.`);

  const { before } = await summaryItems(env, id);
  const overrides = new Map(items.map((item): [string, ReturnType<typeof choiceOf>] => {
    const { channel, ts } = taskRef(item);
    if (!before.some((was) => was.channel === channel && was.ts === ts)) throw new ToolError(`${item.task_id} isn't in summary #${id}. Something the call added goes in added.`);
    return [`${channel}:${ts}`, choiceOf(item)];
  }));
  const after: SummaryItem[] = before.map((was) => ({ ...was, ...overrides.get(`${was.channel}:${was.ts}`), informedAt: undefined, informedBy: undefined }));
  for (const item of added) {
    const title = String(item.title ?? "").trim().slice(0, MAX_ITEM_TITLE);
    if (!title) throw new ToolError("Each item in added needs a title.");
    let task: { channel?: string; ts?: string; status?: Status; incident?: boolean } = {};
    if (item.task_id !== undefined) {
      const { channel, ts } = taskRef(item);
      const found = channel === group.channel ? await loadTask(env, channel, ts) : null;
      if (!found) throw new ToolError(`${item.task_id} isn't a ${group.name} task. create_task makes one.`);
      if (before.some((was) => was.channel === channel && was.ts === ts)) throw new ToolError(`${item.task_id} is in the summary already; change it in items.`);
      task = { channel, ts, status: found.status, incident: Boolean(found.incident) };
    }
    after.push({ kind: "ADDED", title, included: true, health: "ON_TRACK", progress: "", notes: "", ...task, ...choiceOf(item) });
  }
  refuseSecrets(notes, "The notes on the call");
  await putSummaryAfter(env, id, after, { notes: String(notes ?? "").trim().slice(0, MAX_CALL_NOTES), user });

  const rows = compareVersions(await summaryItems(env, id));
  const changed = rows.filter((row) => ["changed", "removed"].includes(row.change)).map(taskIdOf).filter(Boolean);
  const addedCount = rows.filter((row) => row.change === "added").length;
  console.log("Executive summary call recorded", { id, project: group.name, user, changed: changed.length, added: addedCount });
  const text = `Recorded the call for summary #${id}: ${changed.length} task${changed.length === 1 ? "" : "s"} changed or taken out, ${addedCount} added. get_executive_summary shows both versions and which threads still need telling.`;
  return { text, data: { summary_id: id, changed, added: addedCount } };
}

// Saves the summary on the task's notes page, and returns what to tell the person.
async function saveSummary(env: AppEnv, user: string, channel: string, ts: string, text: string) {
  // The task as it is now: the fields may just have changed it.
  const task = (await loadTask(env, channel, ts))!;
  await putSummary(env, channel, ts, text, user);
  // A task from before it had a notes page gets its link now, on its card.
  const had = task.notes?.url;
  syncNotes(env, channel, ts, task);
  if (task.notes?.url !== had) {
    await putTask(env, channel, ts, task);
    await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
  }
  console.log("Task summary written", { channel, ts, by: user, characters: text.length });
  return `The summary is at the top of the task's notes page${task.notes ? `: ${task.notes.url}` : "."}`;
}
