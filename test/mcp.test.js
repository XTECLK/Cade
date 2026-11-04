import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import worker from "../src/index.js";
import { getTask, putSummary, putTask } from "../src/db.js";
import { fakeD1 } from "./d1.js";

const SIGNING_SECRET = "test-signing-secret";
const GOOGLE_URL = "https://script.google.com/macros/s/test/exec";
const DB = fakeD1();
beforeEach(() => DB.reset());
const env = {
  DB,
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  GOOGLE_URL,
  GOOGLE_SECRET: "g",
  CHANNEL_PAIRS: [{ name: "acme", tasks: "CDEV" }, { name: "bare", tasks: "CBARE" }],
};

async function sign(body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": `v0=${hex}` };
}

// A fake Slack API and Google web app: `slack` maps a method to its result
// (or a function of its arguments); every call is recorded.
function mock(t, slack = {}, google = { ok: true }) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === GOOGLE_URL) {
      const body = JSON.parse(init.body);
      calls.push({ method: `google:${body.action}`, args: body });
      return Response.json(typeof google === "function" ? google(body) : google);
    }
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

const ORIGIN = "https://worker.example.net";

// A slash command, as Slack sends it, and the reply it gets.
async function slash(text, user = "UME") {
  const body = new URLSearchParams({ command: "/cade", text, user_id: user, channel_id: "CDEV", trigger_id: "T1", response_url: "https://hooks.example/x" }).toString();
  const response = await worker.fetch(
    new Request(`${ORIGIN}/slack/commands`, { method: "POST", headers: await sign(body), body }),
    env,
    { waitUntil() {} },
  );
  return response.json();
}

// The API key /cade mcp init gives, from its reply (the endpoint is the same for everyone).
const addressIn = (reply) => /\*API key\*[^\n]*\n```([\w-]{43})```/.exec(reply.text)[1];
const ENDPOINT = `${ORIGIN}/mcp`;

// One JSON-RPC message to the endpoint with an API key (in the x-apikey header, if given); returns the Response.
const rpc = (key, message, method = "POST", path = "/mcp") =>
  worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...(key && { "x-apikey": key }) }, body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", ...message }) : undefined }),
    env,
    { waitUntil() {} },
  );

// A tool's result: its text, and whether it is an error.
async function tool(url, name, args) {
  const { result } = await (await rpc(url, { id: 1, method: "tools/call", params: { name, arguments: args } })).json();
  return { text: result.content[0].text, isError: Boolean(result.isError), data: result.structuredContent };
}

test("/cade mcp init gives an API key for the caller, and revoke ends it", async (t) => {
  mock(t);
  const reply = await slash("mcp init");
  const first = addressIn(reply);
  assert.match(first, /^[\w-]{43}$/);
  // The reply gives the endpoint, without the key in it, and says to send the key in the x-apikey header.
  assert.match(reply.text, /\*Endpoint\*\n```https:\/\/worker\.example\.net\/mcp```/);
  assert.ok(!reply.text.includes(`/mcp/${first}`));
  assert.match(reply.text, /claude mcp add --transport http cade https:\/\/worker\.example\.net\/mcp --header "x-apikey: [\w-]{43}"/);
  const list = async (url) => (await rpc(url, { id: 1, method: "tools/list" })).status;
  assert.equal(await list(first), 200);

  // While there is one, init makes none: it can't be shown again, so changing it is revoke, then init.
  assert.match((await slash("mcp init")).text, /API key already.*send `\/cade mcp revoke`.*then `\/cade mcp init`/);
  assert.equal(await list(first), 200);

  // Only a hash is kept.
  const { token_hash: stored } = await DB.prepare("SELECT token_hash FROM mcp_tokens WHERE user_id = ?").bind("UME").first();
  assert.ok(!first.includes(stored));

  assert.match((await slash("mcp revoke")).text, /no longer works/);
  assert.equal(await list(first), 401);
  const second = addressIn(await slash("mcp init"));
  assert.notEqual(second, first);
  assert.equal(await list(first), 401);
  assert.equal(await list(second), 200);

  assert.match((await slash("mcp revoke")).text, /no longer works/);
  assert.equal(await list(second), 401);
  assert.match((await slash("mcp revoke")).text, /no API key to revoke/);
  assert.match((await slash("mcp")).text, /mcp init/);
});

test("the MCP server offers the summarize_task prompt, for a task's issue only", async (t) => {
  mock(t);
  const url = addressIn(await slash("mcp init"));
  const { result: list } = await (await rpc(url, { id: 1, method: "prompts/list" })).json();
  assert.deepEqual(list.prompts.map((prompt) => [prompt.name, prompt.arguments.map((arg) => [arg.name, arg.required])]), [["summarize_task", [["task_id", false]]], ["triage_tasks", [["task_id", false]]], ["explain_task", [["task_id", false]]], ["plan_my_work", []]]);
  assert.ok(list.prompts.every((prompt) => !("steps" in prompt)));

  const { result } = await (await rpc(url, { id: 2, method: "prompts/get", params: { name: "summarize_task", arguments: { task_id: "CDEV:1700000000.000100" } } })).json();
  assert.equal(result.messages[0].role, "user");
  const text = result.messages[0].content.text;
  assert.match(text, /^Write the issue summary of the Cade task CDEV:1700000000\.000100\./);
  assert.match(text, /get_thread_history.*get_task_history instead/s);
  assert.match(text, /Only the issue\./);

  // Without a task, the agent is told to ask which one, from the person's own tasks.
  for (const params of [{ name: "summarize_task" }, { name: "summarize_task", arguments: {} }, { name: "summarize_task", arguments: { task_id: "  " } }]) {
    const { result: asking } = await (await rpc(url, { id: 5, method: "prompts/get", params })).json();
    const ask = asking.messages[0].content.text;
    assert.match(ask, /^First, ask which task\. Call get_tasks with mine/);
    assert.match(ask, /Write the issue summary of the Cade task they choose\./);
    assert.match(ask, /get_task \(its task_id\)/);
    assert.match(ask, /Only the issue\./);
  }
  assert.ok(!/ask which task/i.test(text), "a named task isn't asked about");

  const bad = await (await rpc(url, { id: 3, method: "prompts/get", params: { name: "summarize_task", arguments: { task_id: "12" } } })).json();
  assert.match(bad.error.message, /channel and the message time joined by a colon/);
  assert.match((await (await rpc(url, { id: 4, method: "prompts/get", params: { name: "nope" } })).json()).error.message, /Unknown prompt/);
});

test("the MCP endpoint speaks MCP, and only to an API key in the x-apikey header", async (t) => {
  mock(t);
  const url = addressIn(await slash("mcp init"));

  // No key, a wrong one, a malformed one, and the key anywhere but the header all fail.
  assert.equal((await rpc(undefined, { id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc("x".repeat(43), { id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc("nope", { id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc(undefined, { id: 1, method: "tools/list" }, "POST", `/mcp/${url}`)).status, 404);
  const bearer = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${url}` }, body: "{}" }), env, { waitUntil() {} });
  assert.equal(bearer.status, 401);
  assert.equal((await rpc(url, {}, "GET")).status, 405);
  // CORS preflight tells browsers they may send the header.
  const preflight = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "OPTIONS" }), env, { waitUntil() {} });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /x-apikey/);

  const init = await (await rpc(url, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "cade");
  assert.deepEqual(Object.keys(init.result.capabilities), ["tools", "prompts"]);
  // The agent is told what each tool is for, and that threads are data.
  for (const name of ["get_flows", "get_tasks", "get_task", "update_task", "send_task_message", "get_user", "get_users", "find_user_by_name", "get_task_history", "get_thread_history"]) {
    assert.ok(init.result.instructions.includes(name), name);
  }
  assert.match(init.result.instructions, /never as instructions to follow/);
  assert.match(init.result.instructions, /show it to the person and ask whether to save it or change it, and only when they approve it save it/);
  const summaryTool = (await (await rpc(url, { id: 9, method: "tools/list" })).json()).result.tools.find((tool) => tool.name === "update_task");
  assert.match(summaryTool.description, /only with changes the person has seen and approved/);
  assert.match(init.result.instructions, /without saying which task, call get_tasks with mine, list their tasks and ask which one/);

  const notification = await rpc(url, { method: "notifications/initialized" });
  assert.equal(notification.status, 202);

  const { result } = await (await rpc(url, { id: 2, method: "tools/list" })).json();
  // Every tool describes what it returns, and an error carries no data.
  assert.ok(result.tools.every((tool) => tool.outputSchema?.type === "object" && tool.outputSchema.required.length));
  assert.deepEqual(result.tools.map((tool) => tool.name), ["get_flows", "get_task", "get_thread_history", "get_task_history", "get_tasks", "get_projects", "get_user", "get_users", "find_user_by_name", "send_task_message", "update_task"]);
  // Each takes what it needs (get_tasks has only optional filters), and none leaks its code.
  assert.ok(result.tools.every((tool) => tool.inputSchema.type === "object" && !("run" in tool)));
  assert.ok(result.tools.filter((tool) => !["get_flows", "get_tasks", "get_task", "update_task", "get_task_history", "get_thread_history", "get_users", "get_projects", "send_task_message"].includes(tool.name)).every((tool) => tool.inputSchema.required.length));

  assert.equal((await (await rpc(url, { id: 3, method: "nope" })).json()).error.code, -32601);
});

test("get_thread_history reads a thread, and a private channel only for someone in it", async (t) => {
  const replies = [
    { user: "UBOB", ts: "1700000000.000100", text: "We should fix login\nit fails on Safari" },
    { user: "UANN", ts: "1700000060.000200", text: "I'll take it, <@UBOB>", files: [{ name: "log.txt" }] },
    { bot_id: "B1", username: "deploybot", ts: "1700000120.000300", text: "deployed" },
  ];
  const calls = mock(t, {
    "conversations.info": (args) => ({ channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : args.channel === "D1" ? { is_im: true } : { name: "dev" } }),
    "conversations.members": { members: ["UBOB"] },
    "conversations.replies": { messages: replies },
  });
  const link = "https://acme.slack.com/archives/CDEV/p1700000000000100";

  const mine = addressIn(await slash("mcp init", "UME"));
  const { text, isError } = await tool(mine, "get_thread_history", { link });
  assert.equal(isError, false, text);
  assert.equal(
    text,
    [
      "Thread in #dev (CDEV), 3 messages, oldest first:",
      "[2023-11-14 22:13 UTC] UBOB: We should fix login\n    it fails on Safari",
      "[2023-11-14 22:14 UTC] UANN: I'll take it, <@UBOB> [attached: log.txt]",
      "[2023-11-14 22:15 UTC] deploybot (bot): deployed",
    ].join("\n"),
  );
  assert.deepEqual(calls.find((call) => call.method === "conversations.replies").args.ts, "1700000000.000100");

  // A link to a reply stands for its thread.
  await tool(mine, "get_thread_history", { link: `${link.replace("p1700000000000100", "p1700000060000200")}?thread_ts=1700000000.000100&cid=CDEV` });
  assert.equal(calls.filter((call) => call.method === "conversations.replies").at(-1).args.ts, "1700000000.000100");

  // UME isn't in the private channel; UBOB is.
  const priv = "https://acme.slack.com/archives/CPRIV/p1700000000000100";
  assert.match((await tool(mine, "get_thread_history", { link: priv })).text, /aren't in that channel/);
  const bob = addressIn(await slash("mcp init", "UBOB"));
  assert.equal((await tool(bob, "get_thread_history", { link: priv })).isError, false);

  assert.match((await tool(mine, "get_thread_history", { link: "https://example.com" })).text, /isn't a link to a Slack message/);
  assert.match((await tool(mine, "get_thread_history", { link: "https://acme.slack.com/archives/D1/p1700000000000100" })).text, /direct messages/);
});

test("get_thread_history joins a public channel Cade isn't in", async (t) => {
  let joined = false;
  const calls = mock(t, {
    "conversations.info": { channel: { name: "dev" } },
    "conversations.join": () => ((joined = true), {}),
    "conversations.replies": () => (joined ? { messages: [{ user: "UBOB", ts: "1.1", text: "hi" }] } : new Error("not_in_channel")),
  });
  const url = addressIn(await slash("mcp init"));
  const { isError, text } = await tool(url, "get_thread_history", { link: "https://acme.slack.com/archives/CDEV/p1700000000000100" });
  assert.equal(isError, false, text);
  assert.ok(calls.some((call) => call.method === "conversations.join"));
});

test("get_user gives a user's name from an ID or a mention", async (t) => {
  mock(t, { "users.info": (args) => (args.user === "UBOB" ? { user: { real_name: "Bob Jones", profile: { display_name: "bobby" } } } : new Error("user_not_found")) });
  const url = addressIn(await slash("mcp init"));
  assert.equal((await tool(url, "get_user", { id: "UBOB" })).text, "Bob Jones (bobby)");
  assert.equal((await tool(url, "get_user", { id: "<@UBOB>" })).text, "Bob Jones (bobby)");
  assert.match((await tool(url, "get_user", { id: "bob" })).text, /isn't a Slack user ID/);
  assert.match((await tool(url, "get_user", { id: "UGONE" })).text, /couldn't look up UGONE/);
});

const stored = (overrides = {}) => ({
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

test("update_task saves the summary, which it keeps the summary in the database, on the task's notes page", async (t) => {
  await putTask(env, "CDEV", "1000000000.000100", stored({ notes: { url: `${ORIGIN}/n/CDEV/1000000000.000100` } }));
  const calls = mock(t, { "conversations.info": { channel: { name: "dev" } } });
  const url = addressIn(await slash("mcp init", "UME"));

  const link = "https://acme.slack.com/archives/CDEV/p1000000000000100";
  const result = await tool(url, "update_task", { link, summary: "  Fix login on Safari.\n- Ann owns it  " });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /top of the task's notes page: https:\/\/worker\.example\.net\/n\/CDEV\/1000000000\.000100/);
  const row = await DB.prepare("SELECT summary, summary_by FROM task_notes").first();
  assert.deepEqual({ ...row }, { summary: "Fix login on Safari.\n- Ann owns it", summary_by: "UME" });
  // Nothing is posted in the thread or sent to Google, and the card has its link already.
  assert.deepEqual(calls.map((call) => call.method).filter((method) => method.startsWith("chat.") || method.startsWith("google:")), []);

  // A later summary replaces it.
  await tool(url, "update_task", { link, summary: "Second" });
  assert.equal((await DB.prepare("SELECT summary FROM task_notes").first()).summary, "Second");
});

test("update_task with a summary links the notes page of an older task on its card, and says what's wrong with a call", async (t) => {
  await putTask(env, "CDEV", "1000000000.000100", stored());
  const calls = mock(t, { "chat.update": {}, "conversations.info": { channel: { name: "dev" } } });
  const url = addressIn(await slash("mcp init"));

  const made = await tool(url, "update_task", { link: "https://acme.slack.com/archives/CDEV/p1000000000000100", summary: "Summary" });
  assert.equal(made.isError, false, made.text);
  assert.deepEqual((await getTask(env, "CDEV", "1000000000.000100")).notes, { url: `${ORIGIN}/n/CDEV/1000000000.000100` });
  assert.ok(calls.some((call) => call.method === "chat.update"), "its card links the page");

  assert.match((await tool(url, "update_task", { link: "https://acme.slack.com/archives/CDEV/p9000000000000100", summary: "S" })).text, /isn't a task Cade tracks/);
  assert.match((await tool(url, "update_task", { link: "https://acme.slack.com/archives/CDEV/p1000000000000100", summary: " " })).text, /empty/);
  assert.match((await tool(url, "update_task", { link: "https://acme.slack.com/archives/CDEV/p1000000000000100", summary: "x".repeat(8001) })).text, /8001 characters/);
});

test("get_thread_history reads only from Slack, even for a task Cade keeps messages of", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  await DB.prepare("INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES ('CDEV', '1700000000.000100', '1700000060.000200', 'UBOB', 'Kept reply')").run();
  let slack = { messages: [{ user: "UBOB", ts: "1700000000.000100", text: "We should fix login" }] };
  mock(t, { "conversations.info": { channel: { name: "dev" } }, "conversations.replies": () => slack });
  const url = addressIn(await slash("mcp init"));
  const link = "https://acme.slack.com/archives/CDEV/p1700000000000100";

  // What Slack gives is what comes back; the kept reply isn't added.
  const fromSlack = await tool(url, "get_thread_history", { link });
  assert.equal(fromSlack.isError, false, fromSlack.text);
  assert.match(fromSlack.text, /1 message,/);
  assert.ok(!fromSlack.text.includes("Kept reply"));

  // Slack has dropped the thread: it's not found here, while get_task_history still has it.
  slack = new Error("thread_not_found");
  assert.match((await tool(url, "get_thread_history", { link })).text, /couldn't find that thread/);
  assert.match((await tool(url, "get_task_history", { link })).text, /Kept reply/);
});

test("get_tasks with mine lists the open tasks you are owner, reviewer or tester of, most urgent first, and filters by role and status", async (t) => {
  const people = (owner = [], reviewer = [], tester = []) => ({ owner, reviewer, tester });
  await putTask(env, "CDEV", "1000000000.000100", stored({ title: "Mine, low", priority: "Low", people: people(["UME"]), link: "https://acme.slack.com/archives/CDEV/p1000000000000100" }));
  await putTask(env, "CDEV", "1000000001.000100", stored({ title: "Review me", priority: "Urgent", status: "IN_REVIEW", dueDate: "31/12/2026", people: people(["UBOB"], ["UME"]), link: "https://acme.slack.com/archives/CDEV/p1000000001000100" }));
  await putTask(env, "CBARE", "1000000002.000100", stored({ title: "Test me too", priority: "High", status: "IN_TESTING", people: people(["UME"], ["UBOB"], ["UME"]), link: "https://acme.slack.com/archives/CBARE/p1000000002000100" }));
  await putTask(env, "CDEV", "1000000003.000100", stored({ title: "Done one", status: "DONE", people: people(["UME"]) }));
  await putTask(env, "CDEV", "1000000004.000100", stored({ title: "Not mine", people: people(["UBOB"]) }));
  mock(t);
  const url = addressIn(await slash("mcp init", "UME"));

  const open = await tool(url, "get_tasks", { mine: true });
  assert.equal(open.isError, false, open.text);
  assert.match(open.text, /^3 tasks, most urgent first:/);
  // Urgent first, then High, then Low; done and other people's tasks left out.
  assert.deepEqual([...open.text.matchAll(/^\d\. \[(\w+)\] (.*?) —/gm)].map(([, priority, title]) => [priority, title]), [["Urgent", "Review me"], ["Low", "Mine, low"], ["High", "Test me too"]]);
  assert.match(open.text, /Review me — .*In review, due 31\/12\/2026 \(you: reviewer\)\n   Task ID: CDEV:1000000001.000100\n   https:\/\/acme\.slack\.com\/archives\/CDEV\/p1000000001000100/);
  assert.match(open.text, /Test me too — .*\(you: owner, tester\)/);
  assert.ok(!open.text.includes("Done one") && !open.text.includes("Not mine"));

  assert.match((await tool(url, "get_tasks", { mine: true, role: "reviewer" })).text, /^1 task, most urgent first:\n\*\w+\*\n1\. \[Urgent\] Review me/);
  assert.match((await tool(url, "get_tasks", { mine: true, status: "all" })).text, /^4 tasks/);
  assert.match((await tool(url, "get_tasks", { mine: true, status: "DONE" })).text, /Done one/);
  assert.match((await tool(url, "get_tasks", { mine: true, role: "tester", status: "TODO" })).text, /^You have no tasks as tester in .*To do\./);
  assert.match((await tool(url, "get_tasks", { mine: true, role: "boss" })).text, /role is one of owner, reviewer, tester/);
  assert.match((await tool(url, "get_tasks", { mine: true, status: "soon" })).text, /status is open, all or one of/);

  // Someone with no tasks is told so, and only sees their own.
  const nobody = addressIn(await slash("mcp init", "UNOBODY"));
  assert.match((await tool(nobody, "get_tasks", { mine: true })).text, /^You have no open tasks\./);
});

test("get_task gives one task without its threads, only for a channel you can read", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  await putTask(env, "CPRIV", "1700000000.000100", stored({ title: "Secret" }));
  await DB.prepare("INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES ('CDEV', '1700000000.000100', '1700000000.000100', 'UBOB', 'Fixed it')").run();
  await DB.prepare("INSERT INTO task_notes (channel, task_ts, summary, summary_by, body) VALUES ('CDEV', '1700000000.000100', 'Login fails on Safari', 'UME', 'Check the cache')").run();
  mock(t, {
    "conversations.info": (args) => ({ channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" } }),
    "conversations.members": { members: ["UBOB"] },
  });
  const url = addressIn(await slash("mcp init", "UME"));

  const text = (await tool(url, "get_task", { task_id: "CDEV:1700000000.000100" })).text;
  assert.match(text, /Task ".*" in #dev/);
  assert.match(text, /Task ID: CDEV:1700000000.000100/);
  assert.match(text, /Status: /);
  assert.match(text, /Login fails on Safari/);
  assert.match(text, /Check the cache/);
  assert.doesNotMatch(text, /Fixed it/);
  assert.match(text, /get_task_history/);

  // fields gives only what is asked for, in the text and the data.
  const some = await tool(url, "get_task", { task_id: "CDEV:1700000000.000100", fields: ["status", "summary"] });
  assert.deepEqual(some.data, { task_id: "CDEV:1700000000.000100", status: "TODO", summary: "Login fails on Safari" });
  assert.match(some.text, /Login fails on Safari/);
  assert.doesNotMatch(some.text, /Check the cache|People:|Original thread/);
  assert.match((await tool(url, "get_task", { task_id: "CDEV:1700000000.000100", fields: ["nope"] })).text, /fields is a list of: title, project/);
  assert.equal((await tool(url, "get_task", { task_id: "CDEV:1700000000.000100" })).data.notes, "Check the cache");

  assert.match((await tool(url, "get_task", { task_id: "CPRIV:1700000000.000100" })).text, /can't read that task's channel/);
  assert.match((await tool(url, "get_task", { task_id: "CDEV:1600000000.000100" })).text, /isn't a task Cade tracks/);
  assert.match((await tool(url, "get_task", {})).text, /Give a task_id/);
});

test("get_tasks filters by assignee and unassigned", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored({ title: "Rex's", people: { owner: ["UREX"], reviewer: [], tester: [] } }));
  await putTask(env, "CDEV", "1700000001.000100", stored({ title: "Nobody's", people: { owner: [], reviewer: [], tester: [] } }));
  mock(t, { "conversations.info": { channel: { name: "dev" } }, "auth.test": { url: "https://acme.slack.com/" } });
  const url = addressIn(await slash("mcp init", "UME"));
  const rex = (await tool(url, "get_tasks", { assignee: "UREX" })).text;
  assert.match(rex, /Rex's/);
  assert.doesNotMatch(rex, /Nobody's/);
  const none = (await tool(url, "get_tasks", { unassigned: true })).text;
  assert.match(none, /Nobody's/);
  assert.doesNotMatch(none, /Rex's/);
  assert.match((await tool(url, "get_tasks", { assignee: "rex" })).text, /assignee is a Slack user ID/);
  assert.match((await tool(url, "get_tasks", { unassigned: true, mine: true })).text, /can't be combined/);
});

test("send_task_message posts in the task's thread as Cade, marked as sent by the person", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored({ link: "https://acme.slack.com/archives/CDEV/p1700000000000100" }));
  await putTask(env, "CPRIV", "1700000000.000100", stored({ title: "Secret" }));
  const calls = mock(t, {
    "conversations.info": (args) => ({ channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" } }),
    "conversations.members": { members: ["UBOB"] },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const TASK = "CDEV:1700000000.000100";

  const sent = await tool(url, "send_task_message", { task_id: TASK, text: "  Hi <@UANN> & <!channel>, see <https://evil.example|this>.  " });
  assert.equal(sent.isError, false, sent.text);
  assert.match(sent.text, /^Posted in the task's thread: https:\/\/acme\.slack\.com\/archives\/CDEV/);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.channel, "CDEV");
  assert.equal(post.thread_ts, "1700000000.000100");
  const blocks = JSON.parse(post.blocks);
  // Only a person's mention is kept; @channel and links are shown as typed.
  assert.equal(blocks[0].text.text, "Hi <@UANN> &amp; &lt;!channel&gt;, see &lt;https://evil.example|this&gt;.");
  assert.equal(blocks[1].elements[0].text, "Sent by <@UME>");
  assert.match(post.text, /Sent by <@UME>/);

  const before = calls.length;
  assert.match((await tool(url, "send_task_message", { task_id: TASK, text: "  " })).text, /message is empty/);
  assert.match((await tool(url, "send_task_message", { task_id: TASK, text: "x".repeat(3001) })).text, /3001 characters/);
  assert.match((await tool(url, "send_task_message", { task_id: "CPRIV:1700000000.000100", text: "hi" })).text, /can't read that task's channel/);
  assert.match((await tool(url, "send_task_message", { task_id: "CDEV:1600000000.000100", text: "hi" })).text, /isn't a task Cade tracks/);
  assert.match((await tool(url, "send_task_message", { text: "hi" })).text, /Give a task_id/);
  assert.equal(calls.slice(before).filter((call) => call.method === "chat.postMessage").length, 0);
});

test("/cade mcp info shows how MCP is set up, never the key", async (t) => {
  mock(t, SLACK_FOR_TASKS);
  const before = JSON.stringify(await slash("mcp info", "UME"));
  assert.match(before, /Status:\* on/);
  assert.match(before, /worker\.example\.net\/mcp/);
  assert.match(before, /Your API key:\* none yet/);
  assert.match(before, /`get_tasks`.*`send_task_message`/);
  assert.match(before, /`triage_tasks`/);

  const key = addressIn(await slash("mcp init", "UME"));
  const after = JSON.stringify(await slash("mcp info", "UME"));
  assert.match(after, /Your API key:\* made \d{4}-\d{2}-\d{2}/);
  assert.ok(!after.includes(key));
  assert.match(JSON.stringify(await slash("mcp info", "UOTHER")), /none yet/);

  env.MCP = "off";
  t.after(() => delete env.MCP);
  assert.match(JSON.stringify(await slash("mcp info", "UME")), /Status:\* off/);
});

test("turning MCP off ends the endpoint, gives no keys and drops the prompt, but still revokes keys", async (t) => {
  mock(t, SLACK_FOR_TASKS);
  const url = addressIn(await slash("mcp init", "UME"));
  assert.equal((await rpc(url, { id: 1, method: "tools/list" })).status, 200);

  env.MCP = "off";
  t.after(() => delete env.MCP);
  assert.equal((await rpc(url, { id: 1, method: "tools/list" })).status, 404);
  const init = await slash("mcp init", "UNEW");
  assert.match(JSON.stringify(init), /AI agent access is turned off/);
  assert.doesNotMatch(JSON.stringify(init), /x-apikey/);
  const move = { channel: "CGEN", ts: "500.1", link: "https://acme.slack.com/archives/CGEN/p5001" };
  assert.deepEqual(await submitTrack({ channel: "CDEV", move }), { response_action: "clear" });
  assert.match(JSON.stringify(await slash("mcp revoke", "UME")), /no longer works/);

  env.MCP = "on";
  assert.equal((await slash("mcp init", "UME")).text?.includes("API key"), true);
});

test("get_users lists the people of the workspace, up to a limit", async (t) => {
  const calls = mock(t, {
    "users.list": {
      members: [
        { id: "UANN", name: "ann.lee", real_name: "Ann Lee" },
        { id: "UBOT", name: "robot", real_name: "A Bot", is_bot: true },
        { id: "UGONE", name: "old", real_name: "Old", deleted: true },
        { id: "UBOB", name: "bob", real_name: "Bob" },
        { id: "UCAT", name: "cat", real_name: "Cat" },
      ],
    },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  assert.equal((await tool(url, "get_users", {})).text, ["3 people:", "Ann Lee (ann.lee): UANN", "Bob (bob): UBOB", "Cat (cat): UCAT"].join("\n"));
  // fields gives only what is asked for; user_id is always there.
  const named = await tool(url, "get_users", { fields: ["name"] });
  assert.deepEqual(named.data.users, [{ user_id: "UANN", name: "Ann Lee" }, { user_id: "UBOB", name: "Bob" }, { user_id: "UCAT", name: "Cat" }]);
  assert.equal(named.text, ["3 people:", "Ann Lee: UANN", "Bob: UBOB", "Cat: UCAT"].join("\n"));
  assert.deepEqual((await tool(url, "get_users", { fields: [] })).data.users.map((person) => Object.keys(person)), [["user_id"], ["user_id"], ["user_id"]]);
  assert.deepEqual((await tool(url, "find_user_by_name", { name: "ann", fields: ["username"] })).data.users, [{ user_id: "UANN", username: "ann.lee" }]);
  assert.match((await tool(url, "get_users", { fields: ["email"] })).text, /fields is a list of: name, username/);
  assert.match((await tool(url, "get_users", { limit: 2 })).text, /^3 people, showing the first 2; raise limit \(up to 200\) or use find_user_by_name:\nAnn Lee/);
  for (const limit of [0, 201, 2.5, "5"]) assert.match((await tool(url, "get_users", { limit })).text, /limit is a whole number from 1 to 200/);
  assert.ok(calls.every((call) => call.method === "users.list"));
});

test("find_user_by_name gives the IDs of people by name", async (t) => {
  mock(t, {
    "users.list": {
      members: [
        { id: "UANN", name: "ann.lee", real_name: "Ann Lee", profile: { display_name: "annl" } },
        { id: "UBOT", name: "robot", real_name: "Ann Bot", is_bot: true },
        { id: "UGONE", name: "ann.old", real_name: "Ann Old", deleted: true },
        { id: "UBOB", name: "bob", real_name: "Bob" },
      ],
    },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const found = (await tool(url, "find_user_by_name", { name: "ann" })).text;
  assert.match(found, /1 match:\nAnn Lee \(ann\.lee\): UANN/);
  assert.match((await tool(url, "find_user_by_name", { name: "zed" })).text, /No one in the workspace matches/);
  assert.match((await tool(url, "find_user_by_name", { name: "a" })).text, /at least two letters/);
});

test("update_task changes a task for the person and tells its thread, only with valid input", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  await putTask(env, "CPRIV", "1700000000.000100", stored({ title: "Secret" }));
  const calls = mock(t, {
    "conversations.info": (args) => ({ channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" } }),
    "conversations.members": { members: ["UBOB"] },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const TASK = "CDEV:1700000000.000100";

  const done = (await tool(url, "update_task", { task_id: TASK, priority: "Urgent", due_date: "2030-01-31", owner: { add: ["UREX"] } })).text;
  assert.match(done, /^Done\./);
  const task = await getTask(env, "CDEV", "1700000000.000100");
  assert.equal(task.priority, "Urgent");
  assert.equal(task.dueDate, "31/01/2030");
  assert.deepEqual(task.people.owner, ["UREX"]);
  const posted = calls.find((call) => call.method === "chat.postMessage");
  assert.match(posted.args.text, /<@UME> set the priority/);
  assert.match(posted.args.text, /<@UME> assigned <@UREX> as owner/);

  assert.match((await tool(url, "update_task", { task_id: TASK, priority: "Urgent" })).text, /^Nothing changed/);
  assert.match((await tool(url, "update_task", { task_id: TASK, due_date: "none" })).text, /^Done/);
  assert.equal((await getTask(env, "CDEV", "1700000000.000100")).dueDate, "");

  assert.match((await tool(url, "update_task", { task_id: TASK, status: "soon" })).text, /status is one of/);
  assert.match((await tool(url, "update_task", { task_id: TASK, priority: "Huge" })).text, /priority is one of/);
  assert.match((await tool(url, "update_task", { task_id: TASK, due_date: "31/02/2030" })).text, /real date/);
  assert.match((await tool(url, "update_task", { task_id: TASK, owner: { add: ["rex"] } })).text, /isn't a Slack user ID/);
  assert.match((await tool(url, "update_task", { task_id: TASK, owner: { add: ["UREX"], remove: ["UREX"] } })).text, /add and remove/);
  assert.match((await tool(url, "update_task", { task_id: TASK })).text, /Nothing to change/);
  // Fields and a summary go in one call: the fields are told to the thread, the summary is saved.
  const both = (await tool(url, "update_task", { task_id: TASK, priority: "Low", summary: "The issue." })).text;
  assert.match(both, /^Done\. The change is posted in the task's thread\. The summary is at the top/);
  assert.equal((await DB.prepare("SELECT summary FROM task_notes WHERE channel = 'CDEV'").first()).summary, "The issue.");
  assert.equal((await getTask(env, "CDEV", "1700000000.000100")).priority, "Low");
  assert.match((await tool(url, "update_task", { task_id: "CPRIV:1700000000.000100", priority: "Low" })).text, /can't read that task's channel/);
  assert.match((await tool(url, "update_task", { task_id: "CDEV:1600000000.000100", priority: "Low" })).text, /isn't a task Cade tracks/);
  assert.equal((await getTask(env, "CPRIV", "1700000000.000100")).priority, stored().priority);
});

test("get_task_history gives the messages Cade kept, only for a task it tracks and a channel you can read", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  await putTask(env, "CPRIV", "1700000000.000100", stored({ title: "Secret" }));
  await putTask(env, "CBARE", "1700000000.000100", stored({ title: "Quiet" }));
  const keep = (channel, ts, user, text) => DB.prepare("INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES (?, '1700000000.000100', ?, ?, ?)").bind(channel, ts, user, text).run();
  await keep("CDEV", "1700000000.000100", "UBOB", "We should fix login\nit fails on Safari");
  await keep("CDEV", "1700000060.000200", "UANN", "I'll take it");
  await keep("CPRIV", "1700000000.000100", "UBOB", "hush");
  const calls = mock(t, {
    "conversations.info": (args) => ({ channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" } }),
    "conversations.members": { members: ["UBOB"] },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const link = "https://acme.slack.com/archives/CDEV/p1700000000000100";

  const result = await tool(url, "get_task_history", { link });
  assert.equal(result.isError, false, result.text);
  assert.equal(
    result.text,
    [
      'Task "Fix login" in #dev (CDEV), 2 kept messages, oldest first:',
      "[2023-11-14 22:13 UTC] UBOB: We should fix login\n    it fails on Safari",
      "[2023-11-14 22:14 UTC] UANN: I'll take it",
    ].join("\n"),
  );
  // It is read from the database: Slack is only asked whether you may read the channel.
  assert.ok(!calls.some((call) => call.method === "conversations.replies"));

  // A reply's link stands for its thread.
  assert.match((await tool(url, "get_task_history", { link: `${link.replace("p1700000000000100", "p1700000060000200")}?thread_ts=1700000000.000100&cid=CDEV` })).text, /2 kept messages/);
  // A private channel is for its members only: UME isn't in it, UBOB is.
  const priv = "https://acme.slack.com/archives/CPRIV/p1700000000000100";
  assert.match((await tool(url, "get_task_history", { link: priv })).text, /can't read that task's channel/);
  const bob = addressIn(await slash("mcp init", "UBOB"));
  assert.match((await tool(bob, "get_task_history", { link: priv })).text, /Task "Secret" in #secret.*hush/s);
  // A task with nothing kept, a thread that isn't a task, and a bad link.
  assert.match((await tool(url, "get_task_history", { link: "https://acme.slack.com/archives/CBARE/p1700000000000100" })).text, /No messages are kept for "Quiet"/);
  assert.match((await tool(url, "get_task_history", { link: "https://acme.slack.com/archives/CDEV/p1600000000000100" })).text, /isn't to a task Cade tracks/);
  assert.match((await tool(url, "get_task_history", { link: "https://example.com" })).text, /isn't a link to a Slack message/);

  // By task ID, the form get_tasks gives: the same messages, and the same rules.
  const byId = await tool(url, "get_task_history", { task_id: "CDEV:1700000000.000100" });
  assert.equal(byId.isError, false, byId.text);
  assert.equal(byId.text, result.text);
  assert.match((await tool(url, "get_task_history", { task_id: " CDEV:1700000000.000100 " })).text, /2 kept messages/);
  assert.match((await tool(url, "get_task_history", { task_id: "CPRIV:1700000000.000100" })).text, /can't read that task's channel/);
  assert.match((await tool(bob, "get_task_history", { task_id: "CPRIV:1700000000.000100" })).text, /hush/);
  assert.match((await tool(url, "get_task_history", { task_id: "CDEV:1600000000.000100" })).text, /isn't to a task Cade tracks/);
  assert.match((await tool(url, "get_task_history", { task_id: "12" })).text, /channel and the message time joined by a colon/);
  assert.match((await tool(url, "get_task_history", {})).text, /Give a task_id, or a link/);
});

test("get_task names the thread a task was made from, which get_thread_history reads", async (t) => {
  const TASK = "1700000000.000100";
  await putTask(env, "CDEV", TASK, stored());
  await putTask(env, "CBARE", TASK, stored({ title: "Typed in" }));
  await putTask(env, "CEMPTY", TASK, stored({ title: "Nothing kept" }));
  const keep = (channel, ts, text) => DB.prepare("INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES (?, ?, ?, 'UBOT', ?)").bind(channel, TASK, ts, text).run();
  const moved = (channel) => `Moved from <@UANN>'s <https://acme.slack.com/archives/${channel}/p1699990000000100?thread_ts=1699990000.000100&amp;cid=${channel}|message>:\n> Login fails on Safari`;
  await keep("CDEV", TASK, "Fix login");
  await keep("CDEV", "1700000001.000200", moved("CCLIENT"));
  await keep("CBARE", TASK, "Typed in");
  await keep("CBARE", "1700000001.000200", "just a reply");
  const calls = mock(t, {
    "conversations.info": (args) => ({ channel: { CSECRET: { name: "client-secret", is_private: true } }[args.channel] ?? { name: args.channel === "CCLIENT" ? "client" : "dev" } }),
    "conversations.members": { members: ["UBOB"] },
    "conversations.replies": { messages: [{ user: "UANN", ts: "1699990000.000100", text: "Login fails on Safari" }, { user: "UBOB", ts: "1699990060.000200", text: "Same here" }] },
  });
  const url = addressIn(await slash("mcp init", "UME"));

  // get_task names it, by ID and link, without reading it.
  const task = (await tool(url, "get_task", { task_id: `CDEV:${TASK}` })).text;
  assert.match(task, /Original thread \(where the problem was first raised\): thread ID CCLIENT:1699990000\.000100, https:\/\/acme\.slack\.com\/archives\/CCLIENT\/p1699990000000100\?thread_ts=1699990000\.000100&cid=CCLIENT\. Read it with get_thread_history/);
  assert.ok(!calls.some((call) => call.method === "conversations.replies"));
  assert.match((await tool(url, "get_task", { task_id: `CBARE:${TASK}` })).text, /Original thread: none, the task wasn't made from another thread/);
  assert.match((await tool(url, "get_task", { task_id: `CEMPTY:${TASK}` })).text, /Original thread: unknown, no messages are kept/);

  // get_thread_history reads it by that ID.
  const read = await tool(url, "get_thread_history", { thread_id: "CCLIENT:1699990000.000100" });
  assert.equal(read.isError, false, read.text);
  assert.equal(
    read.text,
    ["Thread in #client (CCLIENT), 2 messages, oldest first:", "[2023-11-14 19:26 UTC] UANN: Login fails on Safari", "[2023-11-14 19:27 UTC] UBOB: Same here"].join("\n"),
  );
  const asked = calls.filter((call) => call.method === "conversations.replies").at(-1).args;
  assert.deepEqual({ channel: asked.channel, ts: asked.ts }, { channel: "CCLIENT", ts: "1699990000.000100" });
  assert.match((await tool(url, "get_thread_history", { thread_id: "nope" })).text, /A thread ID is the channel and the message time/);
  assert.match((await tool(url, "get_thread_history", {})).text, /isn't a link to a Slack message/);

  // The task's own thread points to the one it came from; a typed-in task has no such note.
  assert.match((await tool(url, "get_task_history", { task_id: `CDEV:${TASK}` })).text, /\n\nNote: "Fix login" was made from another thread.*get_task names it and get_thread_history reads it\./s);
  assert.ok(!(await tool(url, "get_task_history", { task_id: `CBARE:${TASK}` })).text.includes("get_thread_history"));
});

test("get_tasks lists every project's tasks you can read, most urgent first, up to a limit", async (t) => {
  const people = (owner = [], reviewer = [], tester = []) => ({ owner, reviewer, tester });
  await putTask(env, "CDEV", "1000000000.000100", stored({ title: "Low one", priority: "Low", people: people(["UBOB"]) }));
  await putTask(env, "CDEV", "1000000001.000100", stored({ title: "Urgent one", priority: "Urgent", status: "IN_REVIEW", dueDate: "31/12/2026", people: people(["UBOB"], ["UANN"], ["UTOM"]) }));
  await putTask(env, "CBARE", "1000000002.000100", stored({ title: "High one", priority: "High" }));
  await putTask(env, "CPRIV", "1000000003.000100", stored({ title: "Secret one", priority: "Urgent" }));
  await putTask(env, "CDEV", "1000000004.000100", stored({ title: "Done one", status: "DONE" }));
  const calls = mock(t, {
    "conversations.info": (args) => ({ channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" } }),
    "conversations.members": (args) => ({ members: args.channel === "CPRIV" ? ["UBOB"] : [] }),
    "auth.test": { url: "https://acme.slack.com/" },
  });
  const url = addressIn(await slash("mcp init", "UME"));

  const all = await tool(url, "get_tasks", {});
  assert.equal(all.isError, false, all.text);
  // Done tasks and the private channel's (UME isn't in it) are left out.
  assert.match(all.text, /^3 tasks, showing the 3 most urgent:/);
  assert.deepEqual([...all.text.matchAll(/^\d\. \[(\w+)\] (.*?) —/gm)].map(([, priority, title]) => [priority, title]), [["Urgent", "Urgent one"], ["Low", "Low one"], ["High", "High one"]]);
  assert.match(all.text, /Urgent one — .*In review, due 31\/12\/2026 \(owner: UBOB; reviewer: UANN; tester: UTOM\)\n   Task ID: CDEV:1000000001\.000100\n   https:\/\/acme\.slack\.com\/archives\/CDEV\//);
  assert.match(all.text, /High one — .*\(owner: —; reviewer: —; tester: —\)/);
  assert.ok(!all.text.includes("Secret one") && !all.text.includes("Done one"));
  // Each channel is asked about once, however many tasks it has.
  assert.equal(calls.filter((call) => call.method === "conversations.info" && call.args.channel === "CDEV").length, 1);

  // A limit keeps the most urgent, and says how many more there are.
  const two = await tool(url, "get_tasks", { limit: 2 });
  assert.match(two.text, /^3 tasks, showing the 2 most urgent:/);
  assert.ok(two.text.includes("Urgent one") && two.text.includes("High one") && !two.text.includes("Low one"));
  assert.match(two.text, /…and 1 more; raise limit/);
  // A member of the private channel sees its tasks too; a status narrows the list.
  const bob = addressIn(await slash("mcp init", "UBOB"));
  assert.match((await tool(bob, "get_tasks", {})).text, /^4 tasks/);
  assert.match((await tool(url, "get_tasks", { status: "DONE" })).text, /^1 task, showing the 1 most urgent:\n\*\w+\*\n1\. .*Done one/);
  assert.match((await tool(url, "get_tasks", { status: "TODO", limit: 1 })).text, /^2 tasks, showing the 1 most urgent:\n\*\w+\*\n1\. \[High\] High one/);
  assert.match((await tool(url, "get_tasks", { status: "CLIENT_REVIEW" })).text, /^There are no tasks you can see in .*Client review\./);

  // A project narrows the list, by name in any case; an unknown one is an error.
  const bare = await tool(url, "get_tasks", { project: "BARE" });
  assert.match(bare.text, /^1 task, showing the 1 most urgent:\n\*\w+\*\n1\. \[High\] High one/);
  assert.ok(!bare.text.includes("Urgent one"));
  assert.match((await tool(url, "get_tasks", { project: "acme", mine: true })).text, /^You have no open tasks\./);
  assert.match((await tool(url, "get_tasks", { project: "nope" })).text, /There is no project called "nope"\. get_projects lists them: acme, bare/);
  // get_projects lists the projects whose channel you can read.
  assert.match((await tool(url, "get_projects", {})).text, /^2 projects:\n- acme: <#CDEV> \(CDEV\)\n- bare: <#CBARE> \(CBARE\)$/);

  // The same tasks come as data, grouped by project, to pass on to other tools.
  assert.deepEqual(all.data.tasks.map((task) => [task.task_id, task.project, task.status, task.owner]), [
    ["CDEV:1000000001.000100", "acme", "IN_REVIEW", ["UBOB"]],
    ["CDEV:1000000000.000100", "acme", "TODO", ["UBOB"]],
    ["CBARE:1000000002.000100", "bare", "TODO", []],
  ]);
  assert.equal(all.data.total, 3);
  // fields picks what each task gives: task_id always, and summary or notes on request.
  await putSummary(env, "CDEV", "1000000001.000100", "The login fails.", "UANN");
  const picked = await tool(url, "get_tasks", { project: "acme", fields: ["title", "summary"] });
  assert.deepEqual(picked.data.tasks.map((task) => Object.keys(task)), [["task_id", "title", "summary"], ["task_id", "title", "summary"]]);
  assert.deepEqual(picked.data.tasks.map((task) => task.summary), ["The login fails.", ""]);
  assert.match(picked.text, /Summary: The login fails\./);
  assert.ok(!("summary" in all.data.tasks[0]));
  assert.match((await tool(url, "get_tasks", { fields: ["nope"] })).text, /fields is a list of: title, project/);
  assert.deepEqual((await tool(url, "get_projects", {})).data.projects, [{ name: "acme", channel: "CDEV" }, { name: "bare", channel: "CBARE" }]);

  for (const limit of [0, 101, 2.5, "5"]) assert.match((await tool(url, "get_tasks", { limit })).text, /limit is a whole number from 1 to 100/);
  assert.match((await tool(url, "get_tasks", { status: "soon" })).text, /status is open, all or one of/);
});

test("get_flows lists the flows and gives the steps of one, the same as the prompts", async (t) => {
  mock(t);
  const url = addressIn(await slash("mcp init"));
  const TASK = "CDEV:1700000000.000100";

  const list = await tool(url, "get_flows", {});
  assert.equal(list.isError, false, list.text);
  assert.match(list.text, /^The flows Cade supports\./);
  assert.match(list.text, /- summarize_task \(task_id\?\): Write a task's summary: the issue, from the thread the task was made from\./);
  assert.match(list.text, /- explain_task \(task_id\?\): .*Issue, Action and Result/);
  assert.match(list.text, /- plan_my_work: Look at my open tasks/);

  // One flow's steps are the prompt's text, whichever way an agent asks for it.
  const steps = await tool(url, "get_flows", { name: "summarize_task", task_id: TASK });
  assert.match(steps.text, /^Flow summarize_task\. Follow these steps:\n\nWrite the issue summary of the Cade task CDEV:1700000000\.000100\./);
  const { result } = await (await rpc(url, { id: 2, method: "prompts/get", params: { name: "summarize_task", arguments: { task_id: TASK } } })).json();
  assert.ok(steps.text.endsWith(result.messages[0].content.text));
  // Without a task, the flow starts by asking which.
  assert.match((await tool(url, "get_flows", { name: "explain_task" })).text, /First, ask which task\. Call get_tasks with mine/);
  // A flow that saves nothing says so, and the one that needs no task needs none.
  assert.match((await tool(url, "get_flows", { name: "explain_task", task_id: TASK })).text, /Explain the Cade task CDEV:1700000000\.000100 to the person.*Save nothing\./s);
  assert.match((await tool(url, "get_flows", { name: "plan_my_work" })).text, /get_tasks with mine for their open tasks/);

  assert.match((await tool(url, "get_flows", { name: "nope" })).text, /no flow called "nope"\. They are: summarize_task, triage_tasks, explain_task, plan_my_work/);
  assert.match((await tool(url, "get_flows", { name: "summarize_task", task_id: "12" })).text, /channel and the message time joined by a colon/);
});

// The track form, submitted from a message: `move` is where it came from.
async function submitTrack(origin, { callback = "track", user = "UCREATOR" } = {}) {
  const values = { title: { value: { value: "Fix login" } }, due_date: { value: { selected_date: null } }, priority: { value: { selected_option: { value: "High" } } } };
  const payload = { type: "view_submission", user: { id: user }, view: { callback_id: callback, private_metadata: JSON.stringify(origin), state: { values: callback === "track" ? values : { title: values.title } } } };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const pending = [];
  const response = await worker.fetch(new Request(`${ORIGIN}/slack/interactions`, { method: "POST", headers: await sign(body), body }), env, { waitUntil: (promise) => pending.push(promise) });
  const answer = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
  await Promise.all(pending);
  return answer;
}

const SLACK_FOR_TASKS = {
  "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: args.channel, ts: "100.1" }),
  "chat.getPermalink": (args) => ({ permalink: `https://acme.slack.com/archives/${args.channel}/p${args.message_ts.replace(".", "")}` }),
};

test("after a task is made from a message, its form gives way to the prompt for an AI agent", async (t) => {
  mock(t, SLACK_FOR_TASKS);
  const move = { channel: "CGEN", ts: "500.1", threadTs: "500.1", author: "UBOB", text: "Customers can't pay", link: "https://acme.slack.com/archives/CGEN/p5001?thread_ts=500.1&cid=CGEN" };
  for (const callback of ["track", "incident"]) {
    const answer = await submitTrack({ channel: "CDEV", move }, { callback });
    assert.equal(answer.response_action, "update");
    const { view } = answer;
    assert.equal(view.type, "modal");
    assert.equal(view.submit, undefined);
    const text = view.blocks.map((block) => block.text?.text ?? "").join("\n");
    // The prompt names the task by its ID and the tools to use with it.
    assert.match(text, /Write the issue summary of the Cade task CDEV:100\.1\./);
    assert.match(text, /get_thread_history[\s\S]*get_user[\s\S]*update_task \(its summary\) and the same task_id/);
    // Only the issue: what was done and how it ended are left to the task's own thread.
    assert.match(text, /Only the issue\. Leave out what was done about it and how it ended/);
    // The draft is shown first, and saved only once the person approves it.
    assert.match(text, /4\. Show the draft to the person and ask whether to save it as it is or change it\. Don't save anything yet[\s\S]*Only when they approve it, save that text with update_task/);
    // Short: the prompt, and one line for an agent that isn't connected yet.
    assert.equal(view.blocks.length, 2);
    assert.equal(view.blocks[1].elements[0].text, "Agent not connected to Cade yet? Send `/cade mcp init`.");
    assert.ok(!text.includes("claude mcp add"));
    assert.ok(view.blocks.every((block) => (block.text?.text ?? "").length <= 3000));
    DB.reset();
  }
});

test("the prompt follows privately when the task takes too long to post for the form to wait", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const calls = mock(t, { ...SLACK_FOR_TASKS, "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: args.channel, ts: "100.1" }) });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("chat.postMessage") && !new URLSearchParams(init.body).has("thread_ts")) await gate;
    return original(url, init);
  };
  t.after(() => (globalThis.fetch = original));
  const move = { channel: "CGEN", ts: "500.1", link: "https://acme.slack.com/archives/CGEN/p5001?thread_ts=500.1&cid=CGEN" };
  const submitted = submitTrack({ channel: "CDEV", move });
  setTimeout(release, 2600);
  assert.deepEqual(await submitted, { response_action: "clear" });
  const ephemeral = calls.find((call) => call.method === "chat.postEphemeral");
  assert.equal(ephemeral.args.user, "UCREATOR");
  assert.match(ephemeral.args.text, /Write the issue summary of the Cade task CDEV:100\.1\./);
  assert.match(ephemeral.args.text, /\/cade mcp init/);
});

test("the prompt isn't offered for a task not made from a message, from a DM, or in a project that turned it off", async (t) => {
  mock(t, SLACK_FOR_TASKS);
  assert.deepEqual(await submitTrack({ channel: "CDEV" }), { response_action: "clear" });
  const dm = { channel: "D0BOB", ts: "500.1", link: "https://acme.slack.com/archives/D0BOB/p5001" };
  assert.deepEqual(await submitTrack({ channel: "CDEV", move: dm }), { response_action: "clear" });

  const off = { ...env, CHANNEL_PAIRS: [{ name: "acme", tasks: "CDEV", aiAgentSummary: false }] };
  const original = env.CHANNEL_PAIRS;
  env.CHANNEL_PAIRS = off.CHANNEL_PAIRS;
  t.after(() => (env.CHANNEL_PAIRS = original));
  const move = { channel: "CGEN", ts: "500.1", link: "https://acme.slack.com/archives/CGEN/p5001" };
  assert.deepEqual(await submitTrack({ channel: "CDEV", move }), { response_action: "clear" });
});
