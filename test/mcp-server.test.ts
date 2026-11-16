import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";
import { getTask, keepName, putTask } from "../src/db.ts";
import { TOOL_DEFS } from "../src/mcp-tools.ts";
import { MCP_CALLS_PER_MINUTE, mcpCallWait } from "../src/rate-limit.ts";
import { check } from "./schema.ts";
import { context } from "./helpers.ts";
import {
  DB,
  ORIGIN,
  SLACK_FOR_TASKS,
  WORKSPACE,
  addressIn,
  env,
  mock,
  rpc,
  savePrompts,
  slash,
  stored,
  submitTrack,
  tool,
} from "./mcp-app.ts";

test("/cade mcp init gives an API key for the caller, and revoke ends it", async (t) => {
  mock(t);
  const reply = await slash("mcp init");
  const first = addressIn(reply);
  assert.match(first, /^[\w-]{43}$/);
  // The reply gives the endpoint, without the key in it, and says to send the key in the x-apikey header.
  assert.match(reply.text, /\*Endpoint\*\n```https:\/\/worker\.example\.net\/mcp```/);
  assert.ok(!reply.text.includes(`/mcp/${first}`));
  assert.ok(!reply.text.includes("claude mcp add"));
  assert.match(reply.text, /mcp\.html#connect/);
  const list = async (url) => (await rpc(url, { id: 1, method: "tools/list" })).status;
  assert.equal(await list(first), 200);

  // While there is one, init makes none: it can't be shown again, so changing it is revoke, then init.
  assert.match((await slash("mcp init")).text, /API key already, and I can.t show it again/);
  assert.equal(await list(first), 200);

  // Only a hash is kept.
  const { token_hash: stored } = await DB.prepare("SELECT token_hash FROM mcp_tokens WHERE user_id = ?")
    .bind("UME")
    .first<{ token_hash: string }>();
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
});

test("the MCP endpoint speaks MCP, and only to an API key in the x-apikey header", async (t) => {
  mock(t);
  const url = addressIn(await slash("mcp init"));

  // No key, a wrong one, a malformed one, and the key anywhere but the header all fail.
  assert.equal((await rpc(undefined, { id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc("x".repeat(43), { id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc("nope", { id: 1, method: "tools/list" })).status, 401);
  assert.equal((await rpc(undefined, { id: 1, method: "tools/list" }, "POST", `/mcp/${url}`)).status, 404);
  const bearer = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${url}` }, body: "{}" }),
    env,
    context(),
  );
  assert.equal(bearer.status, 401);
  assert.equal((await rpc(url, {}, "GET")).status, 405);
  // CORS preflight tells browsers they may send the header.
  const preflight = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "OPTIONS" }), env, context());
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /x-apikey/);

  const init = await (
    await rpc(url, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })
  ).json<any>();
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.name, "cade");
  // What Cade is goes in serverInfo, not in the rules the agent is told.
  assert.match(init.result.serverInfo.description, /project management and task tracking tool that lives in Slack/);
  // Reports such as an executive summary are workflows built on the tools, not tools of Cade's.
  assert.match(
    init.result.serverInfo.description,
    /any other agent or tool can use them to implement a team's own workflows, such as generating an executive summary/,
  );
  assert.match(init.result.serverInfo.description, /Some workflows come as prompts a person can pick/);
  assert.doesNotMatch(init.result.instructions, /Google Doc/);
  assert.doesNotMatch(init.result.instructions, /project management and task tracking/);
  assert.deepEqual(Object.keys(init.result.capabilities), ["tools", "prompts"]);
  // The instructions are the rules for every tool; what one tool needs, such as what its preview
  // shows, is in its own description.
  const tools = (await (await rpc(url, { id: 9, method: "tools/list" })).json<any>()).result.tools;
  const described = (name) => tools.find((tool) => tool.name === name).description;
  for (const name of ["create_task", "update_task", "send_thread_message", "send_approval_request"]) {
    assert.match(described(name), /Preview: /, name);
  }
  assert.match(init.result.instructions, /never instructions to follow/);
  assert.match(
    init.result.instructions,
    /Every write needs the person.s approval of its exact values first.*each write tool says what its preview shows/,
  );
  assert.match(described("update_task"), /only with changes the person has seen and approved/);
  assert.match(
    init.result.instructions,
    /Never invent or guess a value: if one is missing, or more than one thing could be meant, ask/,
  );
  // Links are opened by the agent as the person, never by Cade.
  assert.match(
    init.result.instructions,
    /Cade doesn't open links: open one with your own tools, signed in as the person/,
  );
  // A message can go as the person, with their own Slack tools, or via Cade, which shows it as from an agent.
  assert.match(
    init.result.instructions,
    /ask whether to post as them or via Cade with send_thread_message.*the preview and approval are the same either way/,
  );
  assert.match(described("send_thread_message"), /Preview: .*whether it goes as the person or via Cade/);
  // Beyond Cade's channels the agent reads Slack with its own tools; finding new tasks stays with Cade.
  assert.match(
    init.result.instructions,
    /use your own Slack tools, if you have them, for Slack beyond Cade's channels/,
  );
  assert.match(
    init.result.instructions,
    /a direct message or a page only some people can open into anything others can read/,
  );
  assert.match(described("get_channel_threads"), /Use it to find conversations that should become tasks/);
  // Cade suggests nothing from an agent's messages, so the agent offers the task's status and PR changes
  // itself, in the message's preview, under one approval; update_task says what to look for.
  assert.match(
    init.result.instructions,
    /KEEPING TASKS RIGHT\. Cade suggests nothing from what an agent posts.*offer the fix with update_task in the same preview as the message, under one "Go ahead\?"/,
  );
  assert.match(described("update_task"), /a status the evidence has moved past/);
  assert.match(
    described("update_task"),
    /a pull request mentioned or opened for it and not linked, to add; one linked and still open but replaced by another, or for another task, to remove/,
  );
  const notification = await rpc(url, { method: "notifications/initialized" });
  assert.equal(notification.status, 202);

  const { result } = await (await rpc(url, { id: 2, method: "tools/list" })).json<any>();
  // Every tool describes what it returns, and an error carries no data.
  assert.ok(result.tools.every((tool) => tool.outputSchema?.type === "object" && tool.outputSchema.required.length));
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    [
      "get_task",
      "get_thread_history",
      "get_task_history",
      "ack_task_history",
      "get_task_summary",
      "save_task_summary",
      "get_tasks",
      "get_channels",
      "get_channel_threads",
      "create_task",
      "get_projects",
      "get_user",
      "get_users",
      "get_team_availability",
      "get_availability",
      "find_user_by_name",
      "send_thread_message",
      "update_task",
      "send_approval_request",
      "get_prompts",
      "get_prompt",
      "get_server_info",
    ],
  );
  // Each takes what it needs (get_tasks has only optional filters), and none leaks its code.
  assert.ok(result.tools.every((tool) => tool.inputSchema.type === "object" && !("run" in tool)));
  assert.ok(
    result.tools
      .filter(
        (tool) =>
          ![
            "get_tasks",
            "update_task",
            "get_thread_history",
            "get_users",
            "get_team_availability",
            "get_projects",
            "send_thread_message",
            "get_channels",
            "get_channel_threads",
            "create_task",
            "get_server_info",
            "get_prompts",
          ].includes(tool.name),
      )
      .every((tool) => tool.inputSchema.required.length),
  );

  assert.equal((await (await rpc(url, { id: 3, method: "nope" })).json<any>()).error.code, -32601);
});

test("the MCP endpoint offers the deployment's prompts, with the arguments the person gave", async (t) => {
  mock(t);
  const url = addressIn(await slash("mcp init"));
  const call = async (method, params?) => (await rpc(url, { id: 1, method, params })).json<any>();

  // A deployment that saved none offers none.
  assert.deepEqual((await call("prompts/list")).result.prompts, []);
  assert.equal((await call("prompts/get", { name: "task-summary", arguments: { task: "x" } })).error.code, -32602);

  // The list says what to pick and what to give; the instructions come only when one is picked.
  await savePrompts();
  const { prompts } = (await call("prompts/list")).result;
  assert.deepEqual(
    prompts.map((prompt) => prompt.name),
    ["report", "task-summary"],
  );
  const summary = prompts.find((prompt) => prompt.name === "task-summary");
  assert.equal(summary.title, "Summarize a task");
  assert.deepEqual(summary.arguments, [
    { name: "task", description: "The task: its ID, a link to its card, or its title.", required: true },
  ]);
  assert.ok(prompts.every((prompt) => !("text" in prompt)));

  const { result } = await call("prompts/get", {
    name: "task-summary",
    arguments: { task: " C0123ABCD:1700000000.000100 " },
  });
  assert.equal(result.description, "Write a Cade task's summary from its Slack threads, and save it.");
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
  const { text } = result.messages[0].content;
  assert.match(text, /^# Summarize a task\n/);
  assert.match(text, /`save_task_summary` with `task_id`, `summary` and `through`/);
  assert.match(text, /\n## Given\n\n- task: C0123ABCD:1700000000\.000100\n$/);

  // An optional argument left out isn't listed; one given is.
  const plain = (await call("prompts/get", { name: "report", arguments: { project: "Acme" } })).result.messages[0]
    .content.text;
  assert.match(plain, /- project: Acme\n$/);
  assert.doesNotMatch(plain, /- period:/);
  const dated = (
    await call("prompts/get", { name: "report", arguments: { project: "Acme", period: "2026-11-01 to 2026-11-14" } })
  ).result.messages[0].content.text;
  assert.match(dated, /- project: Acme\n- period: 2026-11-01 to 2026-11-14\n$/);

  // What's missing or unknown is refused, not guessed.
  assert.match(
    (await call("prompts/get", { name: "task-summary", arguments: { task: "  " } })).error.message,
    /needs task/,
  );
  assert.match((await call("prompts/get", { name: "task-summary" })).error.message, /needs task/);
  assert.equal((await call("prompts/get", { name: "nope" })).error.code, -32602);
  assert.equal((await call("prompts/get", { name: 7 })).error.code, -32602);
  assert.equal((await call("prompts/get", { name: "task-summary", arguments: ["x"] })).error.code, -32602);
});

test("get_prompts lists the team's prompts for the agent, as prompts/list does for the person, and the guardrails send it there", async (t) => {
  mock(t);
  const url = addressIn(await slash("mcp init", "UME"));
  const none = await tool(url, "get_prompts", {});
  assert.deepEqual(none.data, { total: 0, prompts: [] });
  assert.match(none.text, /no prompts: work with the tools as usual/);

  await savePrompts();
  const { text, data } = await tool(url, "get_prompts", {});
  assert.equal(data.total, 2);
  assert.deepEqual(
    data.prompts.map((prompt) => [prompt.name, prompt.arguments.map((arg) => [arg.name, arg.required])]),
    [
      [
        "report",
        [
          ["project", true],
          ["period", false],
        ],
      ],
      ["task-summary", [["task", true]]],
    ],
  );
  assert.equal(data.prompts[1].description, "Write a Cade task's summary from its Slack threads, and save it.");
  assert.match(
    text,
    /^2 prompts, read one with get_prompt:\n- report \(project, period\?\): A client report\.\n- task-summary \(task\): Write a Cade task's summary/,
  );
  // The same list the person's client gets.
  const listed = (await (await rpc(url, { id: 1, method: "prompts/list" })).json<any>()).result.prompts;
  assert.deepEqual(
    data.prompts.map((prompt) => prompt.description),
    listed.map((prompt) => prompt.description),
  );

  const { INSTRUCTIONS } = await import("../src/guardrails.ts");
  assert.match(INSTRUCTIONS, /TEAM PROMPTS\. .*check get_prompts once a session/);
});

test("/cade mcp status shows whether MCP is configured and whether you have a key, never the key, with a link to the guide", async (t) => {
  mock(t, SLACK_FOR_TASKS);
  const before = JSON.stringify(await slash("mcp status", "UME"));
  assert.match(before, /Configured:\*[^"]*yes, MCP is on/);
  assert.match(before, /worker\.example\.net\/mcp/);
  assert.match(before, /Your API key:\*[^"]*none yet/);
  assert.match(before, /\d+ tools/);
  assert.match(before, /<https:\/\/xteclk\.github\.io\/Cade\/mcp\.html#connect\|How to connect your AI agent>/);

  const reply = await slash("mcp init", "UME");
  assert.match(reply.text, /How to connect:\* <https:\/\/xteclk\.github\.io\/Cade\/mcp\.html#connect\|/);
  const key = addressIn(reply);
  const after = JSON.stringify(await slash("mcp status", "UME"));
  assert.match(after, /Your API key:\*[^"]*made \d{4}-\d{2}-\d{2}/);
  assert.ok(!after.includes(key));
  assert.match(JSON.stringify(await slash("mcp status", "UOTHER")), /none yet/);

  env.MCP = "off";
  t.after(() => delete env.MCP);
  const off = JSON.stringify(await slash("mcp status", "UME"));
  assert.match(off, /Configured:\*[^"]*no, an admin turned it off/);
  assert.ok(!off.includes("Setup guide"));
});

test("the guide /cade mcp status links to is the website's MCP reference, with the setup steps and every tool", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../docs/mcp.html", import.meta.url), "utf8");
  assert.ok(html.includes('id="connect"'));
  assert.ok(
    html.includes(
      'claude mcp add --transport http cade https://YOUR-CADE-WORKER/mcp --header "x-apikey: YOUR_API_KEY"',
    ),
  );
  assert.ok(html.includes("AI agent"));
  for (const def of TOOL_DEFS) assert.ok(html.includes(`id="${def.name}"`), def.name);
  assert.ok(!html.includes("get_flow"));
  // Nothing of any one workspace is in it.
  assert.ok(!html.includes("worker.example.net"));
});

test("turning MCP off ends the endpoint, gives no keys and drops the prompt, but still revokes keys", async (t) => {
  mock(t, SLACK_FOR_TASKS);
  const url = addressIn(await slash("mcp init", "UME"));
  assert.equal((await rpc(url, { id: 1, method: "tools/list" })).status, 200);

  env.MCP = "off";
  t.after(() => delete env.MCP);
  assert.equal((await rpc(url, { id: 1, method: "tools/list" })).status, 404);
  const init = await slash("mcp init", "UNEW");
  assert.match(JSON.stringify(init), /an admin turned it off/);
  assert.doesNotMatch(JSON.stringify(init), /x-apikey/);
  const move = { channel: "CGEN", ts: "500.1", link: "https://acme.slack.com/archives/CGEN/p5001" };
  assert.deepEqual(await submitTrack({ channel: "CDEV", move }), { response_action: "clear" });
  assert.match(JSON.stringify(await slash("mcp revoke", "UME")), /no longer works/);

  env.MCP = "on";
  assert.equal((await slash("mcp init", "UME")).text?.includes("API key"), true);
});

test("every tool follows the same conventions", () => {
  const names = TOOL_DEFS.map((def) => def.name);
  assert.equal(new Set(names).size, names.length);
  for (const def of TOOL_DEFS) {
    assert.match(def.name, /^(get|find|update|send|create|save|ack)_[a-z_]+$/, def.name);
    assert.ok(def.title && def.description, `${def.name} has a title and a description`);
    assert.equal(def.inputSchema.type, "object");
    assert.equal(def.outputSchema.type, "object");
    assert.equal(def.outputSchema.additionalProperties, false, `${def.name}'s result is exact`);
    // A task is named by its task_id alone; a link is only for a thread.
    if (def.inputSchema.properties.task_id)
      assert.ok(!("link" in def.inputSchema.properties), `${def.name} takes a task_id, not a link`);
    for (const key of Object.keys(def.inputSchema.properties))
      assert.ok(!["id", "taskId", "userId"].includes(key), `${def.name}: ${key}`);
    // Readers say so, and the writers don't.
    const writes = [
      "update_task",
      "send_thread_message",
      "create_task",
      "send_approval_request",
      "save_task_summary",
      "ack_task_history",
    ].includes(def.name);
    assert.equal(def.annotations.readOnlyHint, !writes, def.name);
    assert.equal(def.annotations.destructiveHint, false, def.name);
    // A list tool says how many there are in all, as get_tasks does.
    if (def.inputSchema.properties.limit)
      assert.ok("total" in def.outputSchema.properties, `${def.name} gives a total`);
  }
  // A property called status or state lists its values as task statuses are spelled (UPPER_SNAKE; "open" and "all" pick groups).
  const walk = (schema, name, where) => {
    if (!schema || typeof schema !== "object") return;
    const values = schema.enum ?? schema.items?.enum;
    if (["status", "state"].includes(name) && values)
      assert.ok(
        values.every((value) => /^[A-Z_]+$/.test(value) || ["open", "all"].includes(value)),
        `${where}.${name}: ${values}`,
      );
    for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, key, `${where}.${name}`);
    if (schema.items) walk(schema.items, name, where);
  };
  for (const def of TOOL_DEFS) {
    walk(def.inputSchema, "input", def.name);
    walk(def.outputSchema, "output", def.name);
  }
});

test("each person's AI agent can make a limited number of calls a minute, and is told how long to wait", async (t) => {
  mock(t);
  const me = addressIn(await slash("mcp init", "UME"));
  const bob = addressIn(await slash("mcp init", "UBOB"));
  for (let i = 0; i < MCP_CALLS_PER_MINUTE; i++) assert.equal((await tool(me, "get_server_info", {})).isError, false);
  const over = await tool(me, "get_server_info", {});
  assert.equal(over.isError, true);
  assert.match(
    over.text,
    new RegExp(
      `^Too many calls: your AI agent can make ${MCP_CALLS_PER_MINUTE} a minute\\. Wait \\d+ seconds?, then try again\\.`,
    ),
  );
  // Someone else's agent has its own allowance.
  assert.equal((await tool(bob, "get_server_info", {})).isError, false);

  // The minute starts again from nothing, and the wait is what is left of the minute.
  const start = Date.UTC(2026, 10, 8, 10, 0, 0);
  for (let i = 0; i < MCP_CALLS_PER_MINUTE; i++) assert.equal(await mcpCallWait(env, "UANN", start + 1000), 0);
  assert.equal(await mcpCallWait(env, "UANN", start + 45_000), 15);
  assert.equal(await mcpCallWait(env, "UANN", start + 60_000), 0);
});

test("every argument and result field, and every object inside a result, has a description", () => {
  const bare = [];
  const isObject = (schema) =>
    schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
  // The two root objects of a tool say nothing of themselves: the tool's own description does.
  const walk = (schema: Record<string, any>, path: string, root = false) => {
    if (!schema || typeof schema !== "object") return;
    if (!root && isObject(schema) && !schema.description) bare.push(path);
    for (const [name, property] of Object.entries((schema.properties ?? {}) as Record<string, any>)) {
      if (!property.description) bare.push(`${path}.${name}`);
      walk(property, `${path}.${name}`);
    }
    if (schema.items) walk(schema.items, `${path}[]`);
  };
  for (const def of TOOL_DEFS) {
    walk(def.inputSchema, `${def.name} input`, true);
    walk(def.outputSchema, `${def.name} output`, true);
  }
  assert.deepEqual([...new Set(bare)], []);
});

test("a result that holds user IDs names those people, in its data and its text, with the IDs kept", async (t) => {
  const TS = "1700000000.000100";
  await putTask(
    env,
    "CDEV",
    TS,
    stored({
      link: "https://acme.slack.com/archives/CDEV/p1700000000000100",
      people: { owner: ["UREX12345"], reviewer: ["UANN12345"], tester: [] },
      createdBy: "UBOB12345",
    }),
  );
  await DB.prepare(
    "INSERT INTO task_summaries (channel, task_ts, summary, through_ts, written_by) VALUES ('CDEV', ?, 'Raised by <@UBOB12345>', '1700000001.000100', 'UANN12345')",
  )
    .bind(TS)
    .run();
  const NAMES = { UREX12345: "Rex Roe", UANN12345: "Ann Lee", UBOB12345: "Bob Jones" };
  const calls = mock(t, {
    "conversations.info": { channel: { name: "dev" } },
    "conversations.replies": { messages: [{ ts: TS, user: "UBOB12345", text: "Hi <@UANN12345>, and <@UGHOST123>" }] },
    "users.info": (args) =>
      NAMES[args.user] ? { user: { real_name: NAMES[args.user] } } : new Error("user_not_found"),
  });
  const url = addressIn(await slash("mcp init", "UME"));

  // The IDs in the fields: each named once.
  const view = await tool(url, "get_task", { task_id: `CDEV:${TS}` });
  assert.deepEqual(view.data.user_names, NAMES);
  assert.deepEqual([view.data.owner, view.data.created_by], [["UREX12345"], "UBOB12345"], "the IDs are still there");
  assert.match(view.text, /owner: Rex Roe \(UREX12345\)/);
  assert.match(view.text, /raised by Bob Jones \(UBOB12345\)/);
  // The mention in the summary, and whose agent saved it.
  const summary = await tool(url, "get_task_summary", { task_id: `CDEV:${TS}` });
  assert.equal(summary.data.summary_by, "UANN12345");
  assert.match(summary.text, /saved by Ann Lee \(UANN12345\)/);
  assert.match(summary.text, /Raised by @Bob Jones \(UBOB12345\)/);
  assert.equal(calls.filter((call) => call.method === "users.info" && call.args.user === "UREX12345").length, 1);

  // A mention in a thread is named too; one Slack doesn't know is left as it was.
  const thread = await tool(url, "get_thread_history", { thread_id: `CDEV:${TS}` });
  assert.deepEqual(thread.data.user_names, { UBOB12345: "Bob Jones", UANN12345: "Ann Lee" });
  assert.match(thread.text, /Bob Jones \(UBOB12345\): Hi @Ann Lee \(UANN12345\), and <@UGHOST123>/);
  assert.deepEqual(
    thread.data.messages[0].text,
    "Hi <@UANN12345>, and <@UGHOST123>",
    "the data keeps the text as it was",
  );

  // The names are kept in the database, so the next result asks Slack for no one it has asked about.
  const asked = calls.filter((call) => call.method === "users.info").length;
  await tool(url, "get_task", { task_id: `CDEV:${TS}` });
  assert.equal(calls.filter((call) => call.method === "users.info").length, asked);

  // What it learned is kept in the database (the user_names table), for the next call and the next restart.
  assert.equal(
    (await DB.prepare("SELECT name FROM user_names WHERE user_id = ?").bind("UREX12345").first()).name,
    "Rex Roe",
  );
  assert.equal(
    await DB.prepare("SELECT name FROM user_names WHERE user_id = ?").bind("UGHOST123").first(),
    null,
    "an ID Slack doesn't know is not kept as a name",
  );

  // A name already kept is used without asking Slack.
  await keepName(env, "UKEPT1234", "Kim Kept");
  await putTask(
    env,
    "CDEV",
    "1700000001.000100",
    stored({ people: { owner: ["UKEPT1234"], reviewer: [], tester: [] } }),
  );
  const kept = await tool(url, "get_task", { task_id: "CDEV:1700000001.000100", fields: ["owner"] });
  assert.deepEqual(kept.data.user_names, { UKEPT1234: "Kim Kept" });
  assert.equal(calls.filter((call) => call.method === "users.info" && call.args.user === "UKEPT1234").length, 0);

  // Every tool that says it names people gives the map, even when nobody is in the result.
  const none = await tool(url, "get_tasks", { status: "DONE" });
  assert.deepEqual(none.data.user_names, {});
});

test("a kept name is asked about again after a month, and kept if the person has left Slack", async (t) => {
  const TS = "1700000000.000100";
  await putTask(
    env,
    "CDEV",
    TS,
    stored({ people: { owner: ["UOLD12345", "UGONE1234", "UFRESH123"], reviewer: [], tester: [] } }),
  );
  const keptAt = (id, days) =>
    DB.prepare("INSERT INTO user_names (user_id, name, updated_at) VALUES (?, ?, datetime('now', ?))")
      .bind(id, `Old ${id}`, `-${days} days`)
      .run();
  await keptAt("UOLD12345", 40); // renamed since
  await keptAt("UGONE1234", 40); // gone from Slack
  await keptAt("UFRESH123", 5); // looked up recently
  const calls = mock(t, {
    "conversations.info": { channel: { name: "dev" } },
    "users.info": (args) =>
      args.user === "UOLD12345" ? { user: { real_name: "Renamed Olu" } } : new Error("user_not_found"),
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const asked = () =>
    calls
      .filter((call) => call.method === "users.info")
      .map((call) => call.args.user)
      .sort();

  const view = await tool(url, "get_task", { task_id: `CDEV:${TS}`, fields: ["owner"] });
  assert.deepEqual(view.data.user_names, {
    UOLD12345: "Renamed Olu",
    UGONE1234: "Old UGONE1234",
    UFRESH123: "Old UFRESH123",
  });
  assert.deepEqual(asked(), ["UGONE1234", "UOLD12345"], "only the two old names were asked about");
  assert.equal(
    (await DB.prepare("SELECT name FROM user_names WHERE user_id = ?").bind("UOLD12345").first()).name,
    "Renamed Olu",
  );

  // The one that has left keeps its name, and is not asked about again for another month.
  await tool(url, "get_task", { task_id: `CDEV:${TS}`, fields: ["owner"] });
  assert.deepEqual(asked(), ["UGONE1234", "UOLD12345"], "nobody was asked about a second time");
});

test("a session is given the version of the tool set it loads, and told when the server has a newer one", async (t) => {
  mock(t, { "conversations.info": { channel: { name: "dev" } } });
  const url = addressIn(await slash("mcp init", "UME"));
  const { TOOLSET_VERSION } = await import("../src/mcp.ts");
  assert.match(TOOLSET_VERSION, /^[0-9a-f]{8}$/);

  // Connecting gives a session ID that names the tool set, and the version is in serverInfo.
  const connected = await rpc(url, { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const session = connected.headers.get("mcp-session-id");
  assert.match(session, new RegExp(`^cade-${TOOLSET_VERSION}-[0-9a-f-]{36}$`));
  assert.equal((await connected.json<any>()).result.serverInfo.version, `1.0.0+${TOOLSET_VERSION}`);
  assert.equal(
    (await rpc(url, { id: 2, method: "ping" })).headers.get("mcp-session-id"),
    null,
    "only a connection is given one",
  );

  const call = async (name, args, headers) =>
    (
      await (
        await rpc(url, { id: 3, method: "tools/call", params: { name, arguments: args } }, "POST", "/mcp", headers)
      ).json<any>()
    ).result;
  const info = async (headers) => call("get_server_info", {}, headers);

  // A session on the latest tools, one on an older set, and one that doesn't say.
  const current = await info({ "mcp-session-id": session });
  assert.deepEqual(current.structuredContent, {
    server_version: "1.0.0",
    toolset_version: TOOLSET_VERSION,
    session_toolset_version: TOOLSET_VERSION,
    status: "CURRENT",
  });
  assert.match(current.content[0].text, /has the latest tools/);
  const old = await info({ "mcp-session-id": "cade-00000000-1234" });
  assert.deepEqual(
    [old.structuredContent.session_toolset_version, old.structuredContent.status],
    ["00000000", "OUTDATED"],
  );
  assert.match(old.content[0].text, /disconnect and connect Cade again/);
  const unsaid = await info({});
  assert.deepEqual(
    [unsaid.structuredContent.session_toolset_version, unsaid.structuredContent.status],
    ["", "UNKNOWN"],
  );

  // Any other tool says so too, in its text, while the session is out of date; its data is unchanged.
  const stale = await call("get_projects", {}, { "mcp-session-id": "cade-00000000-1234" });
  assert.match(
    stale.content[0].text,
    /Cade's tools were updated after this session started \(it loaded 00000000, the server has [0-9a-f]{8}\)\. Tell the person to disconnect and connect Cade again/,
  );
  assert.deepEqual(
    check(TOOL_DEFS.find((def) => def.name === "get_projects").outputSchema, stale.structuredContent),
    [],
  );
  assert.doesNotMatch(
    (await call("get_projects", {}, { "mcp-session-id": session })).content[0].text,
    /tools were updated/,
  );
  assert.doesNotMatch((await call("get_projects", {}, {})).content[0].text, /tools were updated/);
  // Saving prompts changes the version without a deploy, so a session from before is told to reconnect.
  await savePrompts();
  const renewed = await (
    await rpc(url, { id: 4, method: "initialize", params: { protocolVersion: "2025-06-18" } })
  ).json<any>();
  const withPrompts = renewed.result.serverInfo.version.split("+")[1];
  assert.match(withPrompts, /^[0-9a-f]{8}$/);
  assert.notEqual(withPrompts, TOOLSET_VERSION);
  assert.match(
    (await call("get_projects", {}, { "mcp-session-id": session })).content[0].text,
    new RegExp(`it loaded ${TOOLSET_VERSION}, the server has ${withPrompts}`),
  );
  assert.equal((await info({ "mcp-session-id": session })).structuredContent.status, "OUTDATED");
  // The same prompts saved again change nothing.
  await savePrompts();
  assert.equal(
    (await (await rpc(url, { id: 5, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json<any>())
      .result.serverInfo.version,
    `1.0.0+${withPrompts}`,
  );
  await DB.exec("DELETE FROM prompts");

  // A session ID that isn't Cade's is no sign of anything.
  assert.doesNotMatch(
    (await call("get_projects", {}, { "mcp-session-id": "abc" })).content[0].text,
    /tools were updated/,
  );
});

test("a tool's arguments are checked against its inputSchema before it runs, saying what is wrong", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  const calls = mock(t, { "conversations.info": { channel: { name: "dev" } }, "users.info": WORKSPACE });
  const url = addressIn(await slash("mcp init", "UME"));
  const TASK = "CDEV:1700000000.000100";
  const refused = async (name, args, pattern) => {
    const result = await tool(url, name, args);
    assert.equal(result.isError, true, `${name} took ${JSON.stringify(args)}`);
    assert.match(result.text, pattern);
  };
  // A misspelt argument is refused, not ignored, and the ones the tool takes are named.
  await refused(
    "update_task",
    { task_id: TASK, stauts: "DONE" },
    /^stauts isn't something this takes; it takes task_id, .*status/,
  );
  // So is one inside an object, and a wrong type there.
  await refused(
    "update_task",
    { task_id: TASK, prs: { add: [], drop: [] } },
    /^prs\.drop isn't something this takes; it takes prs\.add, prs\.remove/,
  );
  await refused("update_task", { task_id: TASK, owner: { add: "UREX" } }, /^owner\.add is a list\./);
  // has_subtasks is gone: a task is done in parts when it has subtasks of its own.
  await refused("update_task", { task_id: TASK, has_subtasks: true }, /^has_subtasks isn't something this takes/);
  await refused("update_task", { task_id: 42 }, /^task_id is text\./);
  await refused("get_tasks", { unassigned: "yes" }, /^unassigned is true or false\./);
  await refused("get_task", { task_id: TASK, fields: ["title", "nope"] }, /^fields is a list of: title, /);
  await refused("create_task", { title: "x".repeat(151) }, /^title is 151 characters; keep it to 150 or fewer\./);
  // Nothing was changed or posted by any of them.
  assert.equal((await getTask(env, "CDEV", "1700000000.000100")).status, "TODO");
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 0);
});

test("every tool's inputSchema takes only the arguments it lists, as it is published", async () => {
  const closed = (schema, where) => {
    if (schema.properties) assert.equal(schema.additionalProperties, false, `${where} takes other properties`);
    for (const [name, property] of Object.entries(schema.properties ?? {})) closed(property, `${where}.${name}`);
    if (schema.items) closed(schema.items, `${where}[]`);
  };
  for (const def of TOOL_DEFS) closed(def.inputSchema, def.name);
});

test("the guardrails fit before clients cut them, and each write tool says what its preview shows", async () => {
  const { INSTRUCTIONS, MAX_INSTRUCTIONS } = await import("../src/guardrails.ts");
  // Claude Code cut them after about 4,000 characters, losing the rules at the end.
  assert.ok(MAX_INSTRUCTIONS < 4000);
  assert.ok(
    INSTRUCTIONS.length <= MAX_INSTRUCTIONS,
    `the guardrails are ${INSTRUCTIONS.length} characters; keep them to ${MAX_INSTRUCTIONS}`,
  );
  // The guardrails name the tools they speak of, so a renamed tool can't leave them pointing at nothing.
  const names = TOOL_DEFS.map((def) => def.name);
  for (const named of INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z]+)+\b/g)!.filter((word) =>
    /^(get|find|send|create|update|save|ack)_/.test(word),
  )) {
    assert.ok(names.includes(named), named);
  }
  // A write's preview is described with the tool, which the guardrails point to. The one write that is
  // never approved, a summary only agents read, says so, and so do the guardrails.
  for (const def of TOOL_DEFS.filter((def) => !def.annotations.readOnlyHint)) {
    if (["save_task_summary", "ack_task_history"].includes(def.name))
      assert.match(def.description, /needs no approval/);
    else assert.match(def.description, /Preview: /, def.name);
  }
  assert.match(INSTRUCTIONS, /nor do save_task_summary and ack_task_history/);
});
