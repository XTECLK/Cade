import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import worker from "../src/index.js";
import { getTask, putTask } from "../src/db.js";
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

// The address /cade mcp grant gives, from its reply.
const addressIn = (reply) => /https:\/\/\S+\/mcp\/[\w-]+/.exec(reply.text)[0];

// One JSON-RPC message to an address; returns the Response.
const rpc = (url, message, method = "POST") =>
  worker.fetch(new Request(url, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", ...message }) : undefined }), env, { waitUntil() {} });

// A tool's result: its text, and whether it is an error.
async function tool(url, name, args) {
  const { result } = await (await rpc(url, { id: 1, method: "tools/call", params: { name, arguments: args } })).json();
  return { text: result.content[0].text, isError: Boolean(result.isError) };
}

test("/cade mcp grant gives a private address for the caller, and revoke ends it", async (t) => {
  mock(t);
  const first = addressIn(await slash("mcp grant"));
  assert.match(first, /^https:\/\/worker\.example\.net\/mcp\/[\w-]{43}$/);
  const list = async (url) => (await rpc(url, { id: 1, method: "tools/list" })).status;
  assert.equal(await list(first), 200);

  // Granting again replaces it.
  const second = addressIn(await slash("mcp grant"));
  assert.notEqual(second, first);
  assert.equal(await list(first), 401);
  assert.equal(await list(second), 200);

  // Only a hash is kept.
  const { token_hash: stored } = await DB.prepare("SELECT token_hash FROM mcp_tokens WHERE user_id = ?").bind("UME").first();
  assert.ok(!second.includes(stored));

  assert.match((await slash("mcp revoke")).text, /no longer works/);
  assert.equal(await list(second), 401);
  assert.match((await slash("mcp revoke")).text, /no address to revoke/);
  assert.match((await slash("mcp")).text, /mcp grant/);
});

test("the MCP endpoint speaks MCP, and only to a token", async (t) => {
  mock(t);
  const url = addressIn(await slash("mcp grant"));

  assert.equal((await rpc(`${ORIGIN}/mcp/${"x".repeat(43)}`, { id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc(`${ORIGIN}/mcp/nope`, { id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc(url, {}, "GET")).status, 405);

  const init = await (await rpc(url, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json();
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "cade");
  assert.deepEqual(Object.keys(init.result.capabilities), ["tools"]);

  const notification = await rpc(url, { method: "notifications/initialized" });
  assert.equal(notification.status, 202);

  const { result } = await (await rpc(url, { id: 2, method: "tools/list" })).json();
  assert.deepEqual(result.tools.map((tool) => tool.name), ["get_thread_history", "resolve_user_name", "update_task_summary"]);
  assert.ok(result.tools.every((tool) => tool.inputSchema.required.length && !("run" in tool)));

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

  const mine = addressIn(await slash("mcp grant", "UME"));
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
  const bob = addressIn(await slash("mcp grant", "UBOB"));
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
  const url = addressIn(await slash("mcp grant"));
  const { isError, text } = await tool(url, "get_thread_history", { link: "https://acme.slack.com/archives/CDEV/p1700000000000100" });
  assert.equal(isError, false, text);
  assert.ok(calls.some((call) => call.method === "conversations.join"));
});

test("resolve_user_name gives a user's name from an ID or a mention", async (t) => {
  mock(t, { "users.info": (args) => (args.user === "UBOB" ? { user: { real_name: "Bob Jones", profile: { display_name: "bobby" } } } : new Error("user_not_found")) });
  const url = addressIn(await slash("mcp grant"));
  assert.equal((await tool(url, "resolve_user_name", { id: "UBOB" })).text, "Bob Jones (bobby)");
  assert.equal((await tool(url, "resolve_user_name", { id: "<@UBOB>" })).text, "Bob Jones (bobby)");
  assert.match((await tool(url, "resolve_user_name", { id: "bob" })).text, /isn't a Slack user ID/);
  assert.match((await tool(url, "resolve_user_name", { id: "UGONE" })).text, /couldn't look up UGONE/);
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

test("update_task_summary keeps the summary in the database, on the task's notes page", async (t) => {
  await putTask(env, "CDEV", "1000000000.000100", stored({ notes: { url: `${ORIGIN}/n/CDEV/1000000000.000100` } }));
  const calls = mock(t);
  const url = addressIn(await slash("mcp grant", "UME"));

  const link = "https://acme.slack.com/archives/CDEV/p1000000000000100";
  const result = await tool(url, "update_task_summary", { link, summary: "  Fix login on Safari.\n- Ann owns it  " });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /top of the task's notes page: https:\/\/worker\.example\.net\/n\/CDEV\/1000000000\.000100/);
  const row = await DB.prepare("SELECT summary, summary_by FROM task_notes").first();
  assert.deepEqual({ ...row }, { summary: "Fix login on Safari.\n- Ann owns it", summary_by: "UME" });
  // Nothing is posted in the thread or sent to Google, and the card has its link already.
  assert.deepEqual(calls.map((call) => call.method).filter((method) => method.startsWith("chat.") || method.startsWith("google:")), []);

  // A later summary replaces it.
  await tool(url, "update_task_summary", { link, summary: "Second" });
  assert.equal((await DB.prepare("SELECT summary FROM task_notes").first()).summary, "Second");
});

test("update_task_summary links the notes page of an older task on its card, and says what's wrong with a call", async (t) => {
  await putTask(env, "CDEV", "1000000000.000100", stored());
  const calls = mock(t, { "chat.update": {} });
  const url = addressIn(await slash("mcp grant"));

  const made = await tool(url, "update_task_summary", { link: "https://acme.slack.com/archives/CDEV/p1000000000000100", summary: "Summary" });
  assert.equal(made.isError, false, made.text);
  assert.deepEqual((await getTask(env, "CDEV", "1000000000.000100")).notes, { url: `${ORIGIN}/n/CDEV/1000000000.000100` });
  assert.ok(calls.some((call) => call.method === "chat.update"), "its card links the page");

  assert.match((await tool(url, "update_task_summary", { link: "https://acme.slack.com/archives/CDEV/p9000000000000100", summary: "S" })).text, /isn't to a task/);
  assert.match((await tool(url, "update_task_summary", { link: "https://acme.slack.com/archives/CDEV/p1000000000000100", summary: " " })).text, /empty/);
  assert.match((await tool(url, "update_task_summary", { link: "https://acme.slack.com/archives/CDEV/p1000000000000100", summary: "x".repeat(8001) })).text, /8001 characters/);
});

test("get_thread_history adds what Cade kept to what Slack still gives, and works when Slack gives nothing", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  for (const [ts, text] of [["1700000000.000100", "We should fix login"], ["1700000060.000200", "Kept reply"]]) {
    await DB.prepare("INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES ('CDEV', '1700000000.000100', ?, 'UBOB', ?)").bind(ts, text).run();
  }
  let slack = { messages: [{ user: "UBOB", ts: "1700000000.000100", text: "We should fix login" }] };
  mock(t, { "conversations.info": { channel: { name: "dev" } }, "conversations.replies": () => slack });
  const url = addressIn(await slash("mcp grant"));
  const link = "https://acme.slack.com/archives/CDEV/p1700000000000100";

  const merged = await tool(url, "get_thread_history", { link });
  assert.equal(merged.isError, false, merged.text);
  assert.match(merged.text, /2 messages/);
  assert.match(merged.text, /UBOB: We should fix login\n.*UBOB: Kept reply/);

  // Slack has dropped the thread: Cade's copy answers.
  slack = new Error("thread_not_found");
  const kept = await tool(url, "get_thread_history", { link });
  assert.equal(kept.isError, false, kept.text);
  assert.match(kept.text, /2 messages/);

  // An untracked thread Slack no longer has is still not found.
  assert.match((await tool(url, "get_thread_history", { link: "https://acme.slack.com/archives/CDEV/p1600000000000100" })).text, /couldn't find that thread/);
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
    // The prompt names the thread and the task, by their links.
    assert.match(text, /Summarize the Slack thread https:\/\/acme\.slack\.com\/archives\/CGEN\/p5001\?thread_ts=500\.1&cid=CGEN into the Cade task https:\/\/acme\.slack\.com\/archives\/CDEV\/p1001\./);
    assert.match(text, /get_thread_history[\s\S]*resolve_user_name[\s\S]*update_task_summary/);
    // And says how to connect an agent that isn't.
    assert.match(text, /\/cade mcp grant/);
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
  assert.match(ephemeral.args.text, /Summarize the Slack thread .* into the Cade task https:\/\/acme\.slack\.com\/archives\/CDEV\/p1001/);
  assert.match(ephemeral.args.text, /\/cade mcp grant/);
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
