import assert from "node:assert/strict";
import test from "node:test";
import { insertTask, markTaskPosted, putTask, setPrStates } from "../src/db.ts";
import { DB, PR1, PR2, PR3, WORKSPACE, addressIn, env, mock, slash, stored, tool } from "./mcp-app.ts";

test("get_tasks with assignees me lists your open tasks in channels you can read, most urgent first, and filters by roles and status", async (t) => {
  const people = (owner = [], reviewer = [], tester = []) => ({ owner, reviewer, tester });
  await putTask(
    env,
    "CDEV",
    "1000000000.000100",
    stored({
      title: "Mine, low",
      priority: "Low",
      people: people(["UME"]),
      link: "https://acme.slack.com/archives/CDEV/p1000000000000100",
    }),
  );
  await putTask(
    env,
    "CDEV",
    "1000000001.000100",
    stored({
      title: "Review me",
      priority: "Urgent",
      status: "IN_REVIEW",
      dueDate: "31/12/2026",
      people: people(["UBOB"], ["UME"]),
      link: "https://acme.slack.com/archives/CDEV/p1000000001000100",
    }),
  );
  await putTask(
    env,
    "CBARE",
    "1000000002.000100",
    stored({
      title: "Test me too",
      priority: "High",
      status: "IN_TESTING",
      people: people(["UME"], ["UBOB"], ["UME"]),
      link: "https://acme.slack.com/archives/CBARE/p1000000002000100",
    }),
  );
  await putTask(
    env,
    "CDEV",
    "1000000003.000100",
    stored({ title: "Done one", status: "DONE", people: people(["UME"]) }),
  );
  await putTask(env, "CDEV", "1000000004.000100", stored({ title: "Not mine", people: people(["UBOB"]) }));
  // A private channel you were taken out of: your task there isn't listed any more.
  await putTask(env, "CPRIV", "1000000005.000100", stored({ title: "Left behind", people: people(["UME"]) }));
  mock(t, {
    "conversations.info": (args) => ({
      channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" },
    }),
  });
  const url = addressIn(await slash("mcp init", "UME"));

  const open = await tool(url, "get_tasks", { assignees: ["me"] });
  assert.equal(open.isError, false, open.text);
  assert.match(open.text, /^3 tasks, showing the 3 most urgent:/);
  // Urgent first, then High, then Low; done, other people's and unreadable tasks left out.
  assert.deepEqual(
    [...open.text.matchAll(/^\d\. \[(\w+)\] (.*?) —/gm)].map(([, priority, title]) => [priority, title]),
    [
      ["Urgent", "Review me"],
      ["Low", "Mine, low"],
      ["High", "Test me too"],
    ],
  );
  assert.match(
    open.text,
    /Review me — .*In review, due 31\/12\/2026 \(.*reviewer: UME.*\)\n   Task ID: CDEV:1000000001.000100\n   https:\/\/acme\.slack\.com\/archives\/CDEV\/p1000000001000100/,
  );
  assert.ok(!open.text.includes("Done one") && !open.text.includes("Not mine") && !open.text.includes("Left behind"));

  const titles = async (args: Record<string, unknown>) =>
    [...(await tool(url, "get_tasks", args)).text.matchAll(/^\d\. \[\w+\] (.*?) —/gm)].map(([, title]) => title).sort();
  assert.deepEqual(await titles({ assignees: ["me"], roles: ["reviewer"] }), ["Review me"]);
  assert.deepEqual(await titles({ assignees: ["me"], roles: ["reviewer", "tester"] }), ["Review me", "Test me too"]);
  assert.match((await tool(url, "get_tasks", { assignees: ["me"], status: "all" })).text, /^4 tasks/);
  assert.match((await tool(url, "get_tasks", { assignees: ["me"], status: "DONE" })).text, /Done one/);
  assert.match(
    (await tool(url, "get_tasks", { assignees: ["me"], roles: ["tester"], status: "TODO" })).text,
    /^There are no tasks you can see in .*To do\./,
  );

  // Someone with no tasks is told so, and only sees their own.
  const nobody = addressIn(await slash("mcp init", "UNOBODY"));
  assert.match((await tool(nobody, "get_tasks", { assignees: ["me"] })).text, /^There are no open tasks you can see\./);
});

test("get_task names a task's subtasks and a subtask's parent, for the agent to read their threads", async (t) => {
  await putTask(
    env,
    "CDEV",
    "1700000000.000100",
    stored({ title: "Checkout redesign", link: "https://slack.example/p1" }),
  );
  const parent = { ts: "1700000000.000100", title: "Checkout redesign" };
  for (const [ts, title, status] of [
    ["1700000000.000200", "Payment fails", "DONE"],
    ["1700000000.000300", "Wrong total", "IN_PROGRESS"],
  ] as const) {
    await markTaskPosted(
      env,
      await insertTask(env, "CDEV", stored({ title, status, parent }), {}),
      ts,
      `https://slack.example/${ts}`,
    );
  }
  mock(t, { "conversations.info": { channel: { name: "dev" } } });
  const url = addressIn(await slash("mcp init", "UME"));

  const task = await tool(url, "get_task", { task_id: "CDEV:1700000000.000100" });
  assert.deepEqual(task.data.subtasks, [
    {
      task_id: "CDEV:1700000000.000200",
      title: "Payment fails",
      link: "https://slack.example/1700000000.000200",
      status: "DONE",
    },
    {
      task_id: "CDEV:1700000000.000300",
      title: "Wrong total",
      link: "https://slack.example/1700000000.000300",
      status: "IN_PROGRESS",
    },
  ]);
  assert.equal(task.data.parent, null);
  assert.match(
    task.text,
    /Subtasks \(each has its own thread; read it with get_task_history\):\n- Payment fails — Done \(task ID CDEV:1700000000\.000200\)/,
  );

  // get_tasks lists them flat, each subtask naming its parent; only get_task gives a task's subtasks.
  const listed = await tool(url, "get_tasks", { status: "all" });
  const byTitle = Object.fromEntries(listed.data.tasks.map((item) => [item.title, item]));
  assert.deepEqual(Object.keys(byTitle).sort(), ["Checkout redesign", "Payment fails", "Wrong total"]);
  assert.equal(byTitle["Checkout redesign"].parent, null);
  assert.ok(!("subtasks" in byTitle["Checkout redesign"]));
  assert.equal(byTitle["Wrong total"].parent.task_id, "CDEV:1700000000.000100");
  assert.match(listed.text, /Subtask of "Checkout redesign" \(task ID CDEV:1700000000\.000100\)/);

  const subtask = await tool(url, "get_task", { task_id: "CDEV:1700000000.000300", fields: ["parent", "subtasks"] });
  assert.deepEqual(subtask.data, {
    task_id: "CDEV:1700000000.000300",
    parent: { task_id: "CDEV:1700000000.000100", title: "Checkout redesign", link: "https://slack.example/p1" },
    subtasks: [],
    user_names: {},
  });
});

test("get_task gives one task without its threads, only for a channel you can read", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  await putTask(env, "CPRIV", "1700000000.000100", stored({ title: "Secret" }));
  await DB.prepare(
    "INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES ('CDEV', '1700000000.000100', '1700000000.000100', 'UBOB', 'Fixed it')",
  ).run();
  mock(t, {
    "conversations.info": (args) => ({
      channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" },
    }),
  });
  const url = addressIn(await slash("mcp init", "UME"));

  const text = (await tool(url, "get_task", { task_id: "CDEV:1700000000.000100" })).text;
  assert.match(text, /Task ".*" in #dev/);
  assert.match(text, /Task ID: CDEV:1700000000.000100/);
  assert.match(text, /Status: /);
  assert.doesNotMatch(text, /Fixed it/);
  assert.match(text, /get_task_history\. Its summary: get_task_summary\./);

  // fields gives only what is asked for, in the text and the data.
  const some = await tool(url, "get_task", { task_id: "CDEV:1700000000.000100", fields: ["status", "priority"] });
  assert.deepEqual(some.data, { task_id: "CDEV:1700000000.000100", status: "TODO", priority: "High", user_names: {} });
  assert.doesNotMatch(some.text, /People:|Original thread/);
  assert.match(
    (await tool(url, "get_task", { task_id: "CDEV:1700000000.000100", fields: ["nope"] })).text,
    /fields is a list of: title, project/,
  );
  assert.ok(!("summary" in (await tool(url, "get_task", { task_id: "CDEV:1700000000.000100" })).data));

  assert.match(
    (await tool(url, "get_task", { task_id: "CPRIV:1700000000.000100" })).text,
    /aren't in that task's project channel/,
  );
  assert.match((await tool(url, "get_task", { task_id: "CDEV:1600000000.000100" })).text, /isn't a task Cade tracks/);
  assert.match((await tool(url, "get_task", {})).text, /Give task_id\./);
});

test("get_tasks filters by assignees in roles, and unassigned", async (t) => {
  const people = (owner: string[] = [], reviewer: string[] = [], tester: string[] = []) => ({
    owner,
    reviewer,
    tester,
  });
  await putTask(env, "CDEV", "1700000000.000100", stored({ title: "Rex's", people: people(["UREX"]) }));
  await putTask(env, "CDEV", "1700000001.000100", stored({ title: "Bob reviews", people: people(["UME"], ["UBOB"]) }));
  await putTask(
    env,
    "CDEV",
    "1700000002.000100",
    stored({ title: "Bob tests", people: people(["UANN"], [], ["UBOB"]) }),
  );
  await putTask(env, "CDEV", "1700000003.000100", stored({ title: "Nobody's", people: people() }));
  mock(t, {
    "conversations.info": { channel: { name: "dev" } },
    "auth.test": { url: "https://acme.slack.com/" },
    "users.info": WORKSPACE,
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const titles = async (args: Record<string, unknown>) =>
    [...(await tool(url, "get_tasks", args)).text.matchAll(/^\d\. \[\w+\] (.*?) —/gm)].map(([, title]) => title).sort();

  // Anyone in any role, by default; several people at once; only some roles.
  assert.deepEqual(await titles({ assignees: ["UREX"] }), ["Rex's"]);
  assert.deepEqual(await titles({ assignees: ["UBOB"] }), ["Bob reviews", "Bob tests"]);
  assert.deepEqual(await titles({ assignees: ["UREX", "UBOB"], roles: ["owner", "tester"] }), ["Bob tests", "Rex's"]);
  assert.deepEqual(await titles({ assignees: ["UBOB"], roles: ["reviewer"] }), ["Bob reviews"]);
  // "me" and someone else together.
  assert.deepEqual(await titles({ assignees: ["me", "UREX"], roles: ["owner"] }), ["Bob reviews", "Rex's"]);
  assert.deepEqual(await titles({ unassigned: true }), ["Nobody's"]);

  assert.match(
    (await tool(url, "get_tasks", { assignees: ["rex"] })).text,
    /assignees\[0\] "rex" isn't a Slack user ID such as U0123ABCD, or me/,
  );
  assert.match(
    (await tool(url, "get_tasks", { assignees: ["UGHOST"] })).text,
    /UGHOST isn't an active person in the workspace/,
  );
  assert.match((await tool(url, "get_tasks", { assignees: [] })).text, /assignees needs at least 1 entry/);
  assert.match(
    (await tool(url, "get_tasks", { assignees: Array.from({ length: 51 }, (_, i) => `U${i}AAA`) })).text,
    /assignees has 51 entries; give at most 50/,
  );
  assert.match(
    (await tool(url, "get_tasks", { assignees: ["me"], roles: ["boss"] })).text,
    /roles is a list of: owner, reviewer, tester/,
  );
  assert.match((await tool(url, "get_tasks", { roles: ["owner"] })).text, /roles goes with assignees/);
  assert.match(
    (await tool(url, "get_tasks", { unassigned: true, assignees: ["me"] })).text,
    /unassigned can't be combined with assignees/,
  );
  // The filters it had before are refused, so an agent that still sends them is told.
  assert.match((await tool(url, "get_tasks", { mine: true })).text, /mine isn't something this takes/);
});

test("get_task names the thread a task was made from, which get_thread_history reads", async (t) => {
  const TASK = "1700000000.000100";
  await putTask(env, "CDEV", TASK, stored());
  await putTask(env, "CBARE", TASK, stored({ title: "Typed in" }));
  await putTask(env, "CEMPTY", TASK, stored({ title: "Nothing kept" }));
  const keep = (channel, ts, text) =>
    DB.prepare("INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES (?, ?, ?, 'UBOT', ?)")
      .bind(channel, TASK, ts, text)
      .run();
  const moved = (channel) =>
    `Moved from <@UANN>'s <https://acme.slack.com/archives/${channel}/p1699990000000100?thread_ts=1699990000.000100&amp;cid=${channel}|message>:\n> Login fails on Safari`;
  await keep("CDEV", TASK, "Fix login");
  await keep("CDEV", "1700000001.000200", moved("CCLIENT"));
  await keep("CBARE", TASK, "Typed in");
  await keep("CBARE", "1700000001.000200", "just a reply");
  const calls = mock(t, {
    "conversations.info": (args) => ({
      channel: { CSECRET: { name: "client-secret", is_private: true } }[args.channel] ?? {
        name: args.channel === "CCLIENT" ? "client" : "dev",
      },
    }),
    "conversations.replies": {
      messages: [
        { user: "UANN", ts: "1699990000.000100", text: "Login fails on Safari" },
        { user: "UBOB", ts: "1699990060.000200", text: "Same here" },
      ],
    },
  });
  const url = addressIn(await slash("mcp init", "UME"));

  // get_task names it, by ID and link, without reading it.
  const task = (await tool(url, "get_task", { task_id: `CDEV:${TASK}` })).text;
  assert.match(
    task,
    /Original thread \(where the problem was first raised\): thread ID CCLIENT:1699990000\.000100, https:\/\/acme\.slack\.com\/archives\/CCLIENT\/p1699990000000100\?thread_ts=1699990000\.000100&cid=CCLIENT\. Read it with get_thread_history/,
  );
  assert.ok(!calls.some((call) => call.method === "conversations.replies"));
  assert.match(
    (await tool(url, "get_task", { task_id: `CBARE:${TASK}` })).text,
    /Original thread: none, the task wasn't made from another thread/,
  );
  assert.match(
    (await tool(url, "get_task", { task_id: `CEMPTY:${TASK}` })).text,
    /Original thread: unknown, no messages are kept/,
  );

  // get_thread_history reads it by that ID.
  const read = await tool(url, "get_thread_history", { thread_id: "CCLIENT:1699990000.000100" });
  assert.equal(read.isError, false, read.text);
  assert.equal(
    read.text,
    [
      "Thread in #client (CCLIENT), 2 messages, oldest first:",
      "[2023-11-14 19:26 UTC] UANN: Login fails on Safari",
      "[2023-11-14 19:27 UTC] UBOB: Same here",
    ].join("\n"),
  );
  const asked = calls.filter((call) => call.method === "conversations.replies").at(-1).args;
  assert.deepEqual({ channel: asked.channel, ts: asked.ts }, { channel: "CCLIENT", ts: "1699990000.000100" });
  assert.match(
    (await tool(url, "get_thread_history", { thread_id: "nope" })).text,
    /A thread ID is the channel and the message time/,
  );
  assert.match((await tool(url, "get_thread_history", {})).text, /Give thread_id or link\./);

  // The task's own thread points to the one it came from; a typed-in task has no such note.
  assert.match(
    (await tool(url, "get_task_history", { task_id: `CDEV:${TASK}` })).text,
    /\n\nNote: "Fix login" was made from another thread.*get_task names it and get_thread_history reads it\./s,
  );
  assert.ok(!(await tool(url, "get_task_history", { task_id: `CBARE:${TASK}` })).text.includes("get_thread_history"));
});

test("get_tasks lists every project's tasks you can read, most urgent first, up to a limit", async (t) => {
  const people = (owner = [], reviewer = [], tester = []) => ({ owner, reviewer, tester });
  await putTask(
    env,
    "CDEV",
    "1000000000.000100",
    stored({ title: "Low one", priority: "Low", people: people(["UBOB"]) }),
  );
  await putTask(
    env,
    "CDEV",
    "1000000001.000100",
    stored({
      title: "Urgent one",
      priority: "Urgent",
      status: "IN_REVIEW",
      dueDate: "31/12/2026",
      people: people(["UBOB"], ["UANN"], ["UTOM"]),
    }),
  );
  await putTask(env, "CBARE", "1000000002.000100", stored({ title: "High one", priority: "High" }));
  await putTask(env, "CPRIV", "1000000003.000100", stored({ title: "Secret one", priority: "Urgent" }));
  await putTask(env, "CDEV", "1000000004.000100", stored({ title: "Done one", status: "DONE" }));
  const calls = mock(t, {
    "conversations.info": (args) => ({
      channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" },
    }),
    "auth.test": { url: "https://acme.slack.com/" },
  });
  const url = addressIn(await slash("mcp init", "UME"));

  const all = await tool(url, "get_tasks", {});
  assert.equal(all.isError, false, all.text);
  // Done tasks and the private channel's (UME isn't in it) are left out.
  assert.match(all.text, /^3 tasks, showing the 3 most urgent:/);
  assert.deepEqual(
    [...all.text.matchAll(/^\d\. \[(\w+)\] (.*?) —/gm)].map(([, priority, title]) => [priority, title]),
    [
      ["Urgent", "Urgent one"],
      ["Low", "Low one"],
      ["High", "High one"],
    ],
  );
  assert.match(
    all.text,
    /Urgent one — .*In review, due 31\/12\/2026 \(owner: UBOB; reviewer: UANN; tester: UTOM\)\n   Task ID: CDEV:1000000001\.000100\n   https:\/\/acme\.slack\.com\/archives\/CDEV\//,
  );
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
  assert.match(
    (await tool(url, "get_tasks", { status: "DONE" })).text,
    /^1 task, showing the 1 most urgent:\n\*\w+\*\n1\. .*Done one/,
  );
  assert.match(
    (await tool(url, "get_tasks", { status: "TODO", limit: 1 })).text,
    /^2 tasks, showing the 1 most urgent:\n\*\w+\*\n1\. \[High\] High one/,
  );
  assert.match(
    (await tool(url, "get_tasks", { status: "CLIENT_REVIEW" })).text,
    /^There are no tasks you can see in .*Client review\./,
  );

  // A project narrows the list, by name in any case; an unknown one is an error.
  const bare = await tool(url, "get_tasks", { project: "BARE" });
  assert.match(bare.text, /^1 task, showing the 1 most urgent:\n\*\w+\*\n1\. \[High\] High one/);
  assert.ok(!bare.text.includes("Urgent one"));
  assert.match(
    (await tool(url, "get_tasks", { project: "acme", assignees: ["me"] })).text,
    /^There are no open tasks you can see\./,
  );
  assert.match(
    (await tool(url, "get_tasks", { project: "nope" })).text,
    /There is no project called "nope"\. get_projects lists them: acme, bare/,
  );
  // get_projects lists the projects whose channel you can read.
  assert.match(
    (await tool(url, "get_projects", {})).text,
    /^2 projects:\n- acme: <#CDEV> \(CDEV\)\n- bare: <#CBARE> \(CBARE\)$/,
  );

  // The same tasks come as data, grouped by project, to pass on to other tools.
  assert.deepEqual(
    all.data.tasks.map((task) => [task.task_id, task.project, task.status, task.owner]),
    [
      ["CDEV:1000000001.000100", "acme", "IN_REVIEW", ["UBOB"]],
      ["CDEV:1000000000.000100", "acme", "TODO", ["UBOB"]],
      ["CBARE:1000000002.000100", "bare", "TODO", []],
    ],
  );
  assert.equal(all.data.total, 3);
  // fields picks what each task gives: task_id always, and created_by and the like on request.
  const picked = await tool(url, "get_tasks", { project: "acme", fields: ["title", "created_by"] });
  assert.deepEqual(
    picked.data.tasks.map((task) => Object.keys(task)),
    [
      ["task_id", "title", "created_by"],
      ["task_id", "title", "created_by"],
    ],
  );
  assert.ok(!("created_by" in all.data.tasks[0]));
  assert.match((await tool(url, "get_tasks", { fields: ["nope"] })).text, /fields is a list of: title, project/);
  const listed = (await tool(url, "get_projects", {})).data;
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.projects, [
    { name: "acme", channel_id: "CDEV" },
    { name: "bare", channel_id: "CBARE" },
  ]);

  for (const limit of [0, 101, 2.5, "5"])
    assert.match((await tool(url, "get_tasks", { limit })).text, /limit is a whole number from 1 to 100/);
  assert.match((await tool(url, "get_tasks", { status: "soon" })).text, /status is one of open, all, TODO/);
});

test("get_task and get_tasks give a task's pull requests with where each stands on GitHub", async (t) => {
  const TS = "1700000000.000100";
  await putTask(env, "CDEV", TS, stored({ prs: [PR1, PR2, PR3] }));
  // PR3 hasn't been read from GitHub yet, so it counts as open.
  await setPrStates(env, [
    { url: PR1, state: "MERGED" },
    { url: PR2, state: "CLOSED" },
  ]);
  mock(t, { "conversations.info": { channel: { name: "dev" } }, "auth.test": { url: "https://acme.slack.com/" } });
  const url = addressIn(await slash("mcp init", "UME"));

  const view = await tool(url, "get_task", { task_id: `CDEV:${TS}`, fields: ["prs"] });
  assert.deepEqual(view.data.prs, [
    { url: PR1, label: "web/1", state: "MERGED" },
    { url: PR2, label: "web/2", state: "CLOSED" },
    { url: PR3, label: "api/3", state: "OPEN" },
  ]);
  assert.match(view.text, /- web\/1 \(merged\): https:\/\/github\.com\/acme\/web\/pull\/1/);
  // No releases any more.
  assert.match((await tool(url, "get_task", { task_id: `CDEV:${TS}`, fields: ["releases"] })).text, /fields/);

  // get_tasks gives them when asked for, with the same states.
  const listed = await tool(url, "get_tasks", { fields: ["title", "prs"] });
  assert.deepEqual(
    listed.data.tasks[0].prs.map((pr) => [pr.label, pr.state]),
    [
      ["web/1", "MERGED"],
      ["web/2", "CLOSED"],
      ["api/3", "OPEN"],
    ],
  );
  assert.ok(!("prs" in (await tool(url, "get_tasks", {})).data.tasks[0]));
});
