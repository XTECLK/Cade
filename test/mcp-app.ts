// What the MCP server's tests share: the Worker with its own test environment and a simple fake Slack (mock), whose
// methods can answer with an error; API keys made as a person makes them (slash); JSON-RPC calls to the endpoint
// (rpc), and tool calls whose results are checked against the tool's outputSchema (tool). It is apart from app.ts,
// whose fake Slack and projects are the Slack side's.
import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import worker from "../src/index.ts";
import { TOOL_DEFS } from "../src/mcp-tools.ts";
import { fakeD1 } from "./d1.ts";
import { check } from "./schema.ts";
import type { AppEnv } from "../src/env.ts";
import type { TestContext } from "node:test";
import type { StoredTask } from "../src/types.ts";
import { EXAMPLE, SIGNING_SECRET, context, sign } from "./helpers.ts";
import { parsePrompt, promptsSql } from "../scripts/prompts.ts";

export const DB = fakeD1();
beforeEach(() => DB.reset());
// The Worker's environment for the tests: the settings they need, and no AI binding unless a test adds one.
export const env = {
  DB,
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  PROJECTS: [
    { name: "acme", channel: "CDEV" },
    { name: "bare", channel: "CBARE" },
  ],
} as unknown as AppEnv;

// A fake Slack API: `slack` maps a method to its result
// (or a function of its arguments); every call is recorded.
let recorded = [];
// Who is in each channel, unless a test says: everyone in the tests but CPRIV, a private channel only UBOB is in.
const IN_CHANNEL = (args) => ({ members: args.channel === "CPRIV" ? ["UBOB"] : ["UME", "UBOB"] });

export function mock(t: TestContext, slack: Record<string, unknown> = {}) {
  slack = { "conversations.members": IN_CHANNEL, ...slack };
  const calls = (recorded = []);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = new URL(url).pathname.split("/").pop();
    const args = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ method, args });
    const result = typeof slack[method] === "function" ? slack[method](args) : slack[method];
    if (result instanceof Error) return Response.json({ ok: false, error: result.message });
    return Response.json({ ok: true, ...result });
  };
  t.after(() => (globalThis.fetch = original));
  return calls;
}

export const ORIGIN = "https://worker.example.net";

// users.info: everyone is an active person, but UGHOST (not in the workspace), UGONE (deactivated) and UBOT (a bot).
export const WORKSPACE = (args) =>
  args.user === "UGHOST"
    ? new Error("user_not_found")
    : { user: { real_name: args.user, deleted: args.user === "UGONE", is_bot: args.user === "UBOT" } };

// Cade's AI agent modal (see commands/configure.js), as the slash command it replaced was used:
// "mcp status" opens it, "mcp init" presses Create key and "mcp revoke" presses Revoke key. Resolves to the
// modal Cade drew in answer, with its text.
const MCP_BUTTONS = { status: "home:mcp", init: "home:mcp:create", revoke: "home:mcp:revoke" };
export async function slash(text, user = "UME") {
  const [, name] = text.split(" ");
  const before = recorded.length;
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: user },
      trigger_id: "T1",
      view: { id: "V1" },
      actions: [{ action_id: MCP_BUTTONS[name], value: "" }],
    }),
  }).toString();
  const response = await worker.fetch(
    new Request(`${ORIGIN}/slack/interactions`, { method: "POST", headers: await sign(body), body }),
    env,
    context(),
  );
  assert.equal(response.status, 200);
  // The handler's work follows the answer to Slack, so give it a moment.
  for (let i = 0; i < 50 && !recorded.slice(before).some((call) => call.method.startsWith("views.")); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const drawn = recorded.slice(before).find((call) => call.method === "views.open" || call.method === "views.update");
  const view = JSON.parse(drawn.args.view);
  return { view, text: view.blocks.map((block) => block.text?.text ?? "").join("\n") };
}

// The API key the Create key button gives, from the modal (the endpoint is the same for everyone).
export const addressIn = (reply) => /\*API key\*[^\n]*\n```([\w-]{43})```/.exec(reply.text)[1];

// One JSON-RPC message to the endpoint with an API key (in the x-apikey header, if given); returns the Response.
export const rpc = (key, message, method = "POST", path = "/mcp", more = {}) =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(key && { "x-apikey": key }), ...more },
      body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", ...message }) : undefined,
    }),
    env,
    context(),
  );

// A tool's result: its text, and whether it is an error. Its data must match the tool's
// outputSchema, so every call in these tests checks that, and an error carries none.
export async function tool(url, name, args) {
  const { result } = await (
    await rpc(url, { id: 1, method: "tools/call", params: { name, arguments: args } })
  ).json<any>();
  const { outputSchema } = TOOL_DEFS.find((def) => def.name === name);
  if (result.isError) assert.equal(result.structuredContent, undefined, `${name} gave data with an error`);
  else
    assert.deepEqual(
      check(outputSchema, result.structuredContent),
      [],
      `${name}'s data doesn't match its outputSchema`,
    );
  return { text: result.content[0].text, isError: Boolean(result.isError), data: result.structuredContent };
}

// Saves prompts as `npm run prompts` does: the task-summary example, and a report with an optional argument.
export async function savePrompts(more: string[] = []) {
  const report =
    "---\ndescription: A client report.\narguments:\n  project: The project.\n  period?: When.\n---\n# Write a report\n\nSteps.\n";
  await DB.exec(
    promptsSql([
      parsePrompt("task-summary", EXAMPLE),
      parsePrompt("report", report),
      ...more.map((source, i) => parsePrompt(`more-${i}`, source)),
    ]),
  );
}

export const stored = (overrides: Partial<StoredTask> = {}): StoredTask => ({
  title: "Fix login",
  priority: "High",
  status: "TODO",
  dueDate: "",
  people: { owner: [], reviewer: [], tester: [] },
  prs: [],
  createdBy: "UCREATOR",
  completedAt: "",
  ...overrides,
});

// A kept message of the task CDEV:1000000000.000100's thread.
export const keep = (ts: string, user: string | null, text: string) =>
  DB.prepare("INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES ('CDEV', '1000000000.000100', ?, ?, ?)")
    .bind(ts, user, text)
    .run();
// Cade's copy of the first message of a thread moved into a task (see moveMessage in commands/move.ts).
export const MOVED =
  "Moved from <@UBOB>'s <https://acme.slack.com/archives/CPRIV/p1600000000000100|message>:\n> Login fails on Safari";

// The track form, submitted from a message: `move` is where it came from.
export async function submitTrack(origin, { callback = "track", user = "UCREATOR" } = {}) {
  const values = {
    title: { value: { value: "Fix login" } },
    due_date: { value: { selected_date: null } },
    priority: { value: { selected_option: { value: "High" } } },
  };
  const payload = {
    type: "view_submission",
    user: { id: user },
    view: {
      callback_id: callback,
      private_metadata: JSON.stringify(origin),
      state: { values: callback === "track" ? values : { title: values.title } },
    },
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(
    new Request(`${ORIGIN}/slack/interactions`, { method: "POST", headers: await sign(body), body }),
    env,
    context((promise) => {
      pending.push(promise);
    }),
  );
  const answer = response.headers.get("content-type")?.includes("json") ? await response.json<any>() : null;
  await Promise.all(pending);
  return answer;
}

export const SLACK_FOR_TASKS = {
  "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: args.channel, ts: "100.1" }),
  "chat.getPermalink": (args) => ({
    permalink: `https://acme.slack.com/archives/${args.channel}/p${args.message_ts.replace(".", "")}`,
  }),
};

export const PR1 = "https://github.com/acme/web/pull/1";
export const PR2 = "https://github.com/acme/web/pull/2";
export const PR3 = "https://github.com/acme/api/pull/3";
