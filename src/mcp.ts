import { promptByName, promptHashes, prompts } from "./db.ts";
import { mcpEnabled, tokenUser } from "./mcp-keys.ts";
import { MCP_CALLS_PER_MINUTE, mcpCallWait } from "./rate-limit.ts";
import { MAX_NAMES, TOOL_DEFS } from "./mcp-tools.ts";
import { nameMap } from "./export.ts";
import { INSTRUCTIONS } from "./guardrails.ts";
import { SERVER_DESCRIPTION, SERVER_VERSION } from "./mcp-about.ts";
import { validate } from "./validate.ts";
import type { GetServerInfoArgs, ToolArgs } from "./mcp-args.ts";
import type { AppEnv } from "./env.ts";
import { ToolError } from "./mcp/common.ts";
import { argumentsOf, promptWith, getPromptTool, getPromptsTool } from "./mcp/prompts.ts";
import { getThreadHistory, getChannels, getChannelThreads } from "./mcp/threads.ts";
import { getTaskHistory, ackTaskHistory, getTaskSummary, saveTaskSummary } from "./mcp/history.ts";
import { getTaskView, getProjects, getTasks } from "./mcp/tasks.ts";
import { createTaskTool, updateTask } from "./mcp/task-updates.ts";
import { requestApprovalTool, sendThreadMessage } from "./mcp/messages.ts";
import { resolveUserName, findUser, getUsers, getAvailability, getTeamAvailability } from "./mcp/people.ts";

// What a tool gives: its text, or its text and its data (structuredContent).
type ToolResult = string | { text: string; data: Record<string, unknown> };
// `loaded` is the version of the tool set the session loaded, `current` the server's (see toolsetVersion).
type ToolRunner<Args> = (
  env: AppEnv,
  user: string,
  args: Args,
  extra: { loaded: string; current: string },
) => Promise<ToolResult>;
// A JSON-RPC request's id.
type RpcId = string | number | null;
// A JSON-RPC message as an agent sends it. Nothing in it is trusted until answer and callTool have
// checked it, so its fields are unknown.
type RpcParams = { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
type RpcMessage = { jsonrpc?: unknown; id?: RpcId; method?: unknown; params?: RpcParams };

// Cade as an MCP server, so a person's own AI agent (Claude, Gemini, Cursor,
// Codex, …) can read a Slack thread and write what it makes of it into a
// task, with the model and subscription they already have. The tools:
//
//   get_task(task_id, fields?)         one task: its details, not its threads
//   get_thread_history(thread_id | link)
//                                      a whole thread, read from Slack
//   get_task_history(task_id)          the messages Cade kept of a task's
//                                      thread, from its own database
//   get_task_summary(task_id, full?)   a task's working summary and the
//                                      messages it doesn't cover yet
//   save_task_summary(task_id, summary, through)
//                                      saves it, for the next agent
//   get_tasks(assignees?, roles?, unassigned?, status?, limit?)
//                                      tasks they can read, most urgent first:
//                                      everyone's, or some people's ("me" for
//                                      their own), in some roles
//   get_user(user_id)                      a Slack user's name, for the IDs in it
//   get_channels(limit?)               the channels Cade is in that the person can read
//   get_channel_threads(channel_id, …) a channel's recent threads from people that
//                                      aren't tasks yet, to turn into tasks
//   create_task(title, …)              a task or incident, from a thread or from
//                                      scratch
//   get_projects()                     the projects, with the channel of each
//   get_users(limit?)                  the workspace's people and their IDs
//   find_user_by_name(name)            a Slack user's ID, by name, for assigning
//   send_thread_message(thread_id | link, text)
//                                      a message in a thread, a task's or any
//                                      other, as Cade, with a line saying it
//                                      is from the person
//   update_task(task_id, …)            a task's status, priority, due date,
//                                      people and pull requests, told to its
//                                      thread
//
// This file is the server: the protocol, the API key and the tool set's version. Each tool's function
// is in src/mcp/, by what it works on: tasks.ts and task-updates.ts, history.ts (a task's kept thread
// and summary), threads.ts (Slack's threads and channels), messages.ts (posting), people.ts and
// prompts.ts, with what they share in common.ts.
//
// It speaks MCP's Streamable HTTP in its simplest form: every POST to /mcp is
// one JSON-RPC message, or a batch of them, answered with JSON. There are no
// sessions and nothing is streamed.
//
// The API key is the person's own, made and ended with the Home tab's AI agent button
// (see commands/configure.ts), so every action is theirs: a
// private channel's thread is read only for someone in it. It is sent in the
// `x-apikey` header with every request, never in the address, which ends up
// in logs and histories. Only a hash of it is kept (see grantToken in mcp-keys.ts).
//
// A task's summary is a working one that people's agents keep (task_summaries): each reads the one
// saved and only the messages after it, and saves what it writes for the next (see getTaskSummary).
// It is never shown in Slack or on a page, so saving it needs no approval.
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// The API key a request sends in its `x-apikey` header, or "".
function apiKeyOf(request: Request) {
  return (request.headers.get("x-apikey") ?? "").trim();
}

// What the agent is told when it connects, and the rules it must keep, are in guardrails.ts. Besides the
// tools it offers prompts, the deployment's own workflows built on them, which a person picks (see getPrompt).

// Each tool's definition is in mcp-tools.ts; this adds the function that runs it.
// The function that runs each tool. Each takes its tool's arguments as src/mcp-args.ts types them,
// made from the same inputSchema they are checked against before it is called (see callTool).
const RUNNERS: { [Tool in keyof ToolArgs]: ToolRunner<ToolArgs[Tool]> } = {
  get_task: getTaskView,
  get_thread_history: getThreadHistory,
  get_task_history: getTaskHistory,
  get_task_summary: getTaskSummary,
  save_task_summary: saveTaskSummary,
  ack_task_history: ackTaskHistory,
  get_tasks: getTasks,
  get_channels: getChannels,
  get_channel_threads: getChannelThreads,
  create_task: createTaskTool,
  get_projects: getProjects,
  get_user: resolveUserName,
  get_users: getUsers,
  get_availability: getAvailability,
  get_team_availability: getTeamAvailability,
  find_user_by_name: findUser,
  send_thread_message: sendThreadMessage,
  update_task: updateTask,
  get_server_info: getServerInfo,
  send_approval_request: requestApprovalTool,
  get_prompts: getPromptsTool,
  get_prompt: getPromptTool,
};
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

// The version with the deployment's prompts in it, which `npm run prompts` changes without a deploy. A
// deployment without prompts has TOOLSET_VERSION itself.
async function toolsetVersion(env: AppEnv) {
  const saved = await promptHashes(env);
  return saved ? hashOf(`${TOOLSET_VERSION}|${saved}`) : TOOLSET_VERSION;
}

// A session ID holds the tool set the session loaded (the client sends it back on every request), so the
// server, which keeps nothing, can tell a session that is out of date.
const sessionIdFor = (current: string) => `cade-${current}-${crypto.randomUUID()}`;
const loadedVersionOf = (request: Request) =>
  /^cade-([0-9a-f]{8})-/.exec(request.headers.get("mcp-session-id") ?? "")?.[1] ?? "";

// The Worker's answer to a request for /mcp.
export async function handleMcp(request: Request, env: AppEnv) {
  const headers = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, x-apikey",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-expose-headers": "mcp-session-id",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  // There is no stream to open, as MCP lets a server say.
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { ...headers, allow: "POST" } });

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
  const versions = { loaded: loadedVersionOf(request), current: await toolsetVersion(env) };
  const answers = (await Promise.all(messages.map((message) => answer(env, user, message, versions)))).filter(Boolean);
  // Notifications and answers to us need none.
  if (!answers.length) return new Response(null, { status: 202, headers });
  // A session that connects is given an ID that names the tool set it loads.
  const connecting = messages.some((message) => (message as RpcMessage | null)?.method === "initialize");
  return Response.json(batch ? answers : answers[0], {
    headers: { ...headers, ...(connecting && { "mcp-session-id": sessionIdFor(versions.current) }) },
  });
}

const success = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function answer(env: AppEnv, user: string, raw: unknown, versions: { loaded: string; current: string }) {
  if (!raw || typeof raw !== "object" || (raw as RpcMessage).jsonrpc !== "2.0")
    return failure(null, -32600, "Invalid request");
  const message = raw as RpcMessage;
  // No id: a notification, or an answer to a request of ours (there are none).
  if (message.id === undefined || message.id === null) return null;
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return success(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string" && PROTOCOLS.includes(params.protocolVersion)
            ? params.protocolVersion
            : PROTOCOLS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: {
          name: "cade",
          title: "Cade",
          version: `${SERVER_VERSION}+${versions.current}`,
          description: SERVER_DESCRIPTION,
        },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, { tools: TOOLS.map(({ run, ...tool }) => tool) });
    case "tools/call":
      return callTool(env, user, id, params, versions);
    case "prompts/list":
      return success(id, {
        prompts: (await prompts(env)).map(({ text, ...prompt }) => ({ ...prompt, arguments: argumentsOf(prompt) })),
      });
    case "prompts/get":
      return getPrompt(env, id, params);
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

// A prompt, one of the deployment's (saved by `npm run prompts`, see scripts/prompts.ts): its
// instructions, then the arguments the person gave, as one message from them. It reads nothing and
// changes nothing; the tools it names do, with the same approval as ever.
async function getPrompt(env: AppEnv, id: RpcId, params: RpcParams | undefined) {
  const prompt = typeof params?.name === "string" ? await promptByName(env, params.name) : null;
  if (!prompt) return failure(id, -32602, `Unknown prompt: ${params?.name}`);
  const filled = promptWith(prompt, params?.arguments ?? {});
  if (filled.problem !== undefined) return failure(id, -32602, filled.problem);
  return success(id, {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text: filled.text } }],
  });
}

// Said at the end of a tool's text while the session has an older tool set than the server (get_server_info
// says it on its own).
const staleNotice = ({ loaded, current }: { loaded: string; current: string }) =>
  loaded && loaded !== current
    ? `\n\nCade's tools were updated after this session started (it loaded ${loaded}, the server has ${current}). Tell the person to disconnect and connect Cade again to load them.`
    : "";

async function callTool(
  env: AppEnv,
  user: string,
  id: RpcId,
  params: RpcParams | undefined,
  versions: { loaded: string; current: string },
) {
  const tool = TOOLS.find((candidate) => candidate.name === params?.name);
  if (!tool) return failure(id, -32602, `Unknown tool: ${params?.name}`);
  const notice = tool.name === "get_server_info" ? "" : staleNotice(versions);
  const reply = (text: string, isError?: boolean, data?: Record<string, unknown>) =>
    success(id, {
      content: [{ type: "text", text: text + notice }],
      ...(data && { structuredContent: data }),
      ...(isError && { isError: true }),
    });
  // Each person's agent has a limit of calls a minute (see rate-limit.ts); over it, it is told how long to wait.
  const wait = await mcpCallWait(env, user);
  if (wait) {
    console.log("MCP rate limit reached", { tool: tool.name, user });
    return reply(
      `Too many calls: your AI agent can make ${MCP_CALLS_PER_MINUTE} a minute. Wait ${wait} second${wait === 1 ? "" : "s"}, then try again.`,
      true,
    );
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
    const result = await tool.run(env, user, args, versions);
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
  const user_names = Object.fromEntries(
    ids.filter((id) => kept.get(id) && kept.get(id) !== id).map((id) => [id, kept.get(id)]),
  ) as Record<string, string>;
  const text = result.text.replace(
    /<@([UW][A-Z0-9]{2,})(?:\|[^>]*)?>|\b([UW][A-Z0-9]{8,})\b/g,
    (all: string, mention: string | undefined, bare: string) => {
      const id = mention ?? bare;
      return user_names[id] ? `${mention ? "@" : ""}${user_names[id]} (${id})` : all;
    },
  );
  return { text, data: { ...result.data, user_names } };
}

// Which version of the tool set this session loaded, against the one the server has now.
async function getServerInfo(
  env: AppEnv,
  user: string,
  args: GetServerInfoArgs,
  { loaded, current }: { loaded: string; current: string },
) {
  const status = !loaded ? "UNKNOWN" : loaded === current ? "CURRENT" : "OUTDATED";
  const text = [`Cade ${SERVER_VERSION}, tool set ${current}.`];
  if (status === "CURRENT") text.push("This session has the latest tools.");
  else if (status === "OUTDATED")
    text.push(
      `This session loaded tool set ${loaded}, so it doesn't have the latest tools. Tell the person to disconnect and connect Cade again to load them.`,
    );
  else
    text.push(
      "This client doesn't say which tool set it loaded, so I can't tell if it is the latest. Disconnecting and connecting Cade again loads the latest.",
    );
  return {
    text: text.join(" "),
    data: { server_version: SERVER_VERSION, toolset_version: current, session_toolset_version: loaded, status },
  };
}
