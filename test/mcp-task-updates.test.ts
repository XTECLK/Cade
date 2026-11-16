import assert from "node:assert/strict";
import test from "node:test";
import { getTask, putTask, setPrStates } from "../src/db.ts";
import {
  DB,
  PR1,
  PR2,
  PR3,
  SLACK_FOR_TASKS,
  WORKSPACE,
  addressIn,
  env,
  mock,
  savePrompts,
  slash,
  stored,
  submitTrack,
  tool,
} from "./mcp-app.ts";

test("create_task with parent_task_id makes a subtask, and update_task won't finish a task with open subtasks", async (t) => {
  await putTask(
    env,
    "CDEV",
    "1700000000.000100",
    stored({
      title: "Checkout redesign",
      priority: "High",
      dueDate: "30/11/2026",
      people: { owner: ["UME"], reviewer: [], tester: ["UBOB"] },
      status: "IN_TESTING",
    }),
  );
  const slack = mock(t, {
    "conversations.info": { channel: { name: "dev" } },
    "chat.postMessage": (args) =>
      args.thread_ts ? { ts: "1700000000.000900" } : { channel: args.channel, ts: "1700000000.000200" },
    "chat.getPermalink": { permalink: "https://slack.example/p200" },
    "conversations.replies": { messages: [] },
  });
  const url = addressIn(await slash("mcp init", "UME"));

  const made = await tool(url, "create_task", { title: "Payment fails", parent_task_id: "CDEV:1700000000.000100" });
  assert.equal(made.data.parent_task_id, "CDEV:1700000000.000100");
  assert.match(made.text, /^Created the subtask "Payment fails" of "Checkout redesign" in /);
  const subtask = (await getTask(env, "CDEV", "1700000000.000200"))!;
  assert.deepEqual(
    [subtask.priority, subtask.dueDate, subtask.people.tester, subtask.parent?.ts, subtask.viaAgent],
    ["High", "30/11/2026", ["UBOB"], "1700000000.000100", true],
  );
  assert.ok(slack.some((call) => call.method === "chat.postMessage" && call.args.thread_ts === "1700000000.000100"));
  // Its priority is the task's, given or changed.
  assert.match(
    (await tool(url, "create_task", { title: "Priced", parent_task_id: "CDEV:1700000000.000100", priority: "Low" }))
      .text,
    /has its task's priority/,
  );
  assert.match(
    (await tool(url, "update_task", { task_id: "CDEV:1700000000.000200", priority: "Low" })).text,
    /This is a subtask, which has its task's priority/,
  );
  // Not a subtask of a subtask, nor in another project.
  assert.match(
    (await tool(url, "create_task", { title: "Deeper", parent_task_id: "CDEV:1700000000.000200" })).text,
    /subtasks don't have their own/,
  );
  assert.match(
    (await tool(url, "create_task", { title: "Elsewhere", parent_task_id: "CDEV:1700000000.000100", project: "other" }))
      .text,
    /goes in its task's project/,
  );

  // The task can't be finished while it is open.
  const refused = await tool(url, "update_task", { task_id: "CDEV:1700000000.000100", status: "DONE" });
  assert.match(
    refused.text,
    /1 open subtask: "Payment fails" \(To do, task ID CDEV:1700000000\.000200\)\. A task moves to Client review or Done only once all its subtasks are Done/,
  );
  assert.equal((await getTask(env, "CDEV", "1700000000.000100"))!.status, "IN_TESTING");
  await tool(url, "update_task", { task_id: "CDEV:1700000000.000200", status: "DONE" });
  await tool(url, "update_task", { task_id: "CDEV:1700000000.000100", status: "DONE" });
  assert.equal((await getTask(env, "CDEV", "1700000000.000100"))!.status, "DONE");
});

test("update_task changes a task for the person and tells its thread, only with valid input", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  await putTask(env, "CPRIV", "1700000000.000100", stored({ title: "Secret" }));
  const calls = mock(t, {
    "conversations.info": (args) => ({
      channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" },
    }),
    "users.info": WORKSPACE,
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const TASK = "CDEV:1700000000.000100";

  const done = (
    await tool(url, "update_task", {
      task_id: TASK,
      priority: "Urgent",
      due_date: "2030-01-31",
      owner: { add: ["UREX"] },
    })
  ).text;
  assert.match(done, /^Done\./);
  const task = await getTask(env, "CDEV", "1700000000.000100");
  assert.equal(task.priority, "Urgent");
  assert.equal(task.dueDate, "31/01/2030");
  assert.deepEqual(task.people.owner, ["UREX"]);
  // The other roles.
  const roles = await tool(url, "update_task", {
    task_id: TASK,
    reviewer: { add: ["UBOB"] },
    tester: { add: ["UANN"] },
  });
  assert.match(roles.text, /^Done\./);
  const withRoles = await getTask(env, "CDEV", "1700000000.000100");
  assert.deepEqual(
    [withRoles.people.owner, withRoles.people.reviewer, withRoles.people.tester],
    [["UREX"], ["UBOB"], ["UANN"]],
  );
  assert.match(
    (await tool(url, "update_task", { task_id: TASK, reviewer: { add: ["UBOB"], remove: ["UBOB"] } })).text,
    /reviewer: the same person is in add and remove/,
  );
  const posted = calls.find((call) => call.method === "chat.postMessage");
  assert.match(posted.args.text, /<@UME> set the priority/);
  assert.match(posted.args.text, /<@UME> assigned <@UREX> as owner/);

  assert.match((await tool(url, "update_task", { task_id: TASK, priority: "Urgent" })).text, /^Nothing changed/);
  assert.match((await tool(url, "update_task", { task_id: TASK, due_date: "none" })).text, /^Done/);
  assert.equal((await getTask(env, "CDEV", "1700000000.000100")).dueDate, "");

  assert.match((await tool(url, "update_task", { task_id: TASK, status: "soon" })).text, /status is one of/);
  assert.match((await tool(url, "update_task", { task_id: TASK, priority: "Huge" })).text, /priority is one of/);
  assert.match((await tool(url, "update_task", { task_id: TASK, due_date: "31/02/2030" })).text, /real date/);
  assert.match(
    (await tool(url, "update_task", { task_id: TASK, owner: { add: ["rex"] } })).text,
    /isn't a Slack user ID/,
  );
  // A well-formed ID that isn't an active person is refused before anything is saved.
  for (const id of ["UGHOST", "UGONE", "UBOT"]) {
    assert.match(
      (await tool(url, "update_task", { task_id: TASK, priority: "Low", owner: { add: [id] } })).text,
      new RegExp(`${id} isn't an active person in the workspace`),
    );
  }
  assert.equal((await getTask(env, "CDEV", "1700000000.000100")).priority, "Urgent");
  // Taking someone off needs no check: they may have left.
  assert.match(
    (await tool(url, "update_task", { task_id: TASK, owner: { remove: ["UGHOST"] } })).text,
    /^(Done|Nothing changed)/,
  );
  assert.match(
    (await tool(url, "update_task", { task_id: TASK, owner: { add: ["UREX"], remove: ["UREX"] } })).text,
    /add and remove/,
  );
  assert.match((await tool(url, "update_task", { task_id: TASK })).text, /Nothing to change/);
  assert.match(
    (await tool(url, "update_task", { task_id: TASK, priority: "Low" })).text,
    /^Done\. The change is posted in the task's thread\./,
  );
  assert.equal((await getTask(env, "CDEV", "1700000000.000100")).priority, "Low");
  assert.match(
    (await tool(url, "update_task", { task_id: "CPRIV:1700000000.000100", priority: "Low" })).text,
    /aren't in that task's project channel/,
  );
  assert.match(
    (await tool(url, "update_task", { task_id: "CDEV:1600000000.000100", priority: "Low" })).text,
    /isn't a task Cade tracks/,
  );
  assert.equal((await getTask(env, "CPRIV", "1700000000.000100")).priority, stored().priority);
});

test("a task or incident made from a message just closes its form: no prompt to summarize it follows", async (t) => {
  const calls = mock(t, SLACK_FOR_TASKS);
  await savePrompts();
  const move = {
    channel: "CGEN",
    ts: "500.1",
    threadTs: "500.1",
    author: "UBOB",
    text: "Customers can't pay",
    link: "https://acme.slack.com/archives/CGEN/p5001?thread_ts=500.1&cid=CGEN",
  };
  for (const callback of ["track", "incident"]) {
    assert.deepEqual(await submitTrack({ channel: "CDEV", move }, { callback }), { response_action: "clear" });
    DB.reset();
    await savePrompts();
  }
  assert.ok(
    !calls.some((call) => /Summarize the Cade task|mcp__cade__task-summary/.test(JSON.stringify(call.args))),
    "nothing offers a summary",
  );
  // Nor does one made from scratch.
  assert.deepEqual(await submitTrack({ channel: "CDEV" }), { response_action: "clear" });
});
test("update_task links and unlinks pull requests, and won't unlink one merged or closed", async (t) => {
  const TS = "1700000000.000100";
  await putTask(env, "CDEV", TS, stored({ prs: [PR1, PR2] }));
  await setPrStates(env, [{ url: PR1, state: "MERGED" }]);
  const calls = mock(t, {
    "conversations.info": { channel: { name: "dev" } },
    "chat.postMessage": {},
    "chat.update": {},
    "auth.test": { url: "https://acme.slack.com/" },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const id = `CDEV:${TS}`;

  const added = await tool(url, "update_task", { task_id: id, prs: { add: [PR3, ` <${PR3}> `] } });
  assert.equal(added.isError, false, added.text);
  assert.equal(added.data.changed, true);
  assert.deepEqual((await getTask(env, "CDEV", TS)).prs, [PR1, PR2, PR3]);
  // PR2 is open, so it can go; the merged one can't.
  assert.equal((await tool(url, "update_task", { task_id: id, prs: { remove: [PR2] } })).data.changed, true);
  assert.deepEqual((await getTask(env, "CDEV", TS)).prs, [PR1, PR3]);
  assert.match(
    (await tool(url, "update_task", { task_id: id, prs: { remove: [PR1] } })).text,
    /is merged or closed, and stays linked/,
  );
  assert.deepEqual((await getTask(env, "CDEV", TS)).prs, [PR1, PR3]);
  // Mistakes are said plainly.
  assert.match(
    (await tool(url, "update_task", { task_id: id, prs: { add: ["https://example.com/x"] } })).text,
    /doesn't look like a pull request link/,
  );
  assert.match(
    (await tool(url, "update_task", { task_id: id, prs: { add: [PR2], remove: [PR2] } })).text,
    /same pull request is in add and remove/,
  );
  assert.match((await tool(url, "update_task", { task_id: id, prs: { add: "x" } })).text, /prs\.add is a list/);
  assert.ok(calls.some((call) => call.method === "chat.update"));
});

test("create_task makes a task or incident from a thread or from scratch, and moves the thread", async (t) => {
  const ROOT = "1699999999.000100";
  const calls = mock(t, {
    ...SLACK_FOR_TASKS,
    "conversations.info": { channel: { name: "dev" } },
    "conversations.replies": { messages: [{ ts: ROOT, user: "UANN", text: "Checkout fails on Safari" }] },
    "auth.test": { url: "https://acme.slack.com/", user_id: "UBOT" },
    "reactions.add": {},
    "chat.update": {},
  });
  const url = addressIn(await slash("mcp init", "UME"));

  const made = await tool(url, "create_task", {
    title: "Fix Safari checkout",
    project: "acme",
    priority: "High",
    due_date: "2030-01-31",
    thread_id: `CDEV:${ROOT}`,
  });
  assert.equal(made.isError, false, made.text);
  assert.equal(made.data.task_id, "CDEV:100.1");
  assert.equal(made.data.project, "acme");
  assert.equal(made.data.incident, false);
  const task = await getTask(env, "CDEV", "100.1");
  assert.deepEqual(
    [task.title, task.priority, task.dueDate, task.status, task.createdBy],
    ["Fix Safari checkout", "High", "31/01/2030", "TODO", "UME"],
  );
  assert.ok(
    calls.some(
      (c) => c.method === "chat.postMessage" && c.args.thread_ts === "100.1" && /Moved from/.test(c.args.text),
    ),
  );
  // Its card says an AI agent made it, beside who tracked it, and keeps saying so.
  assert.equal(task.viaAgent, true);
  const card = calls.find((c) => c.method === "chat.postMessage" && c.args.channel === "CDEV" && !c.args.thread_ts);
  assert.match(JSON.stringify(card?.args), /Tracked by <@UME> · \*Sent using\* AI agent/);

  // An incident is urgent and immediate, and takes neither.
  assert.match(
    (await tool(url, "create_task", { title: "Site down", incident: true, priority: "Low" })).text,
    /always Urgent and due immediately/,
  );
  const incident = await tool(url, "create_task", { title: "Site down", incident: true, project: "bare" });
  assert.equal(incident.data.incident, true);
  const urgent = await getTask(env, "CBARE", "100.1");
  assert.deepEqual([urgent.priority, urgent.dueDate], ["Urgent", "Immediate"]);

  assert.match((await tool(url, "create_task", { title: "  " })).text, /title is empty/);
  assert.match((await tool(url, "create_task", { title: "x".repeat(151) })).text, /keep it to 150/);
  assert.match(
    (await tool(url, "create_task", { title: "x" })).text,
    /Say which project to make it in with project: acme, bare/,
  );
  assert.match((await tool(url, "create_task", { title: "x", project: "nope" })).text, /no project called "nope"/);
  assert.match(
    (await tool(url, "create_task", { title: "x", project: "acme", priority: "Soon" })).text,
    /priority is one of/,
  );
  // One from scratch isn't made twice: the project has an open task with that title.
  assert.match(
    (await tool(url, "create_task", { title: "fix safari  CHECKOUT", project: "acme" })).text,
    /acme already has an open task called "Fix Safari checkout" \(CDEV:100\.1\)/,
  );
  // A summary is no longer made with the task: get_task_summary and save_task_summary keep it.
  assert.match((await tool(url, "create_task", { title: "x", project: "acme", summary: "S" })).text, /summary/);
  assert.match(
    (
      await tool(url, "create_task", {
        title: "x",
        project: "acme",
        thread_id: "CDEV:1.1",
        link: "https://a.slack.com/archives/CDEV/p1000000",
      })
    ).text,
    /not both/,
  );
});

test("create_task makes a bug, get_tasks lists bugs, and update_task changes a task to a bug and back", async (t) => {
  const calls = mock(t, { ...SLACK_FOR_TASKS, "conversations.info": { channel: { name: "dev" } }, "chat.update": {} });
  const url = addressIn(await slash("mcp init", "UME"));

  const made = await tool(url, "create_task", { title: "Login fails on Safari", project: "acme", bug: true });
  assert.equal(made.isError, false, made.text);
  assert.match(made.text, /Created the bug "Login fails on Safari"/);
  assert.deepEqual([made.data.bug, made.data.incident], [true, false]);
  assert.equal((await getTask(env, "CDEV", "100.1")).bug, true);
  const card = calls.find((c) => c.method === "chat.postMessage" && c.args.channel === "CDEV" && !c.args.thread_ts);
  assert.match(JSON.stringify(card?.args), /\[MEDIUM\] \[Bug\] \*Login fails on Safari/);
  assert.match(
    (await tool(url, "create_task", { title: "x", project: "acme", bug: true, incident: true })).text,
    /a bug or an incident, not both/,
  );

  await putTask(env, "CDEV", "1700000000.000100", stored({ title: "Add dark mode" }));
  const bugs = await tool(url, "get_tasks", { bug: true });
  assert.deepEqual(
    bugs.data.tasks.map((task) => [task.title, task.bug]),
    [["Login fails on Safari", true]],
  );
  assert.match(bugs.text, /\[Bug\] Login fails on Safari/);
  assert.deepEqual(
    (await tool(url, "get_tasks", { bug: false })).data.tasks.map((task) => task.title),
    ["Add dark mode"],
  );

  assert.match((await tool(url, "update_task", { task_id: "CDEV:1700000000.000100", bug: true })).text, /^Done\./);
  assert.equal((await getTask(env, "CDEV", "1700000000.000100")).bug, true);
  assert.ok(calls.some((c) => c.method === "chat.postMessage" && /marked this as a bug/.test(JSON.stringify(c.args))));
  assert.match((await tool(url, "update_task", { task_id: "CDEV:1700000000.000100", bug: false })).text, /^Done\./);
  assert.equal((await getTask(env, "CDEV", "1700000000.000100")).bug, false);

  // An incident stays one.
  await putTask(
    env,
    "CDEV",
    "1700000000.000200",
    stored({ title: "Site down", priority: "Urgent", dueDate: "Immediate", incident: true }),
  );
  assert.match(
    (await tool(url, "update_task", { task_id: "CDEV:1700000000.000200", bug: true })).text,
    /is an incident, and stays one/,
  );
});

test("create_task won't make a task from a thread that is a task, was moved, or is in a channel you can't read", async (t) => {
  const TS = "1700000000.000100";
  await putTask(env, "CDEV", TS, stored({ title: "Login" }));
  mock(t, {
    "conversations.info": (args) => ({
      channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" },
    }),
    "conversations.replies": (args) => ({
      messages: [
        { ts: args.ts, user: "UANN", text: "hi" },
        {
          ts: "9.9",
          bot_id: "B1",
          text: "<@UME> moved this message to the task thread <https://x/y|Login>. Please carry on.",
        },
      ],
    }),
  });
  const url = addressIn(await slash("mcp init", "UME"));
  assert.match(
    (await tool(url, "create_task", { title: "x", project: "acme", thread_id: `CDEV:${TS}` })).text,
    /already a task thread/,
  );
  assert.match(
    (await tool(url, "create_task", { title: "x", project: "acme", thread_id: "CDEV:1600000000.000100" })).text,
    /already moved/,
  );
  assert.match(
    (await tool(url, "create_task", { title: "x", project: "acme", thread_id: "CPRIV:1600000000.000100" })).text,
    /aren't in that channel/,
  );
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM tasks").first()).n, 1);
});

test("update_task leaves a task in Client review to the client's approver", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored({ status: "CLIENT_REVIEW" }));
  mock(t, { "conversations.info": { channel: { name: "dev" } }, "users.info": WORKSPACE });
  const url = addressIn(await slash("mcp init", "UME"));
  const TASK = "CDEV:1700000000.000100";
  for (const status of ["DONE", "IN_PROGRESS"]) {
    assert.match(
      (await tool(url, "update_task", { task_id: TASK, status })).text,
      /in Client review: it waits for the client's approver/,
    );
  }
  assert.equal((await getTask(env, "CDEV", "1700000000.000100")).status, "CLIENT_REVIEW");
  // Its other fields still change.
  assert.match((await tool(url, "update_task", { task_id: TASK, priority: "Low" })).text, /^Done\./);
});

test("a status change made through MCP shows no private prompt, and the thread says it was an AI agent", async (t) => {
  const TS = "1700000000.000100";
  await putTask(env, "CDEV", TS, stored({ status: "IN_REVIEW" }));
  const calls = mock(t, { "conversations.info": { channel: { name: "dev" } }, "users.info": WORKSPACE });
  const url = addressIn(await slash("mcp init", "UME"));

  const moved = await tool(url, "update_task", { task_id: `CDEV:${TS}`, status: "CLIENT_REVIEW" });
  assert.match(moved.text, /^Done\./);
  assert.match(
    moved.text,
    /It is in Client review now\. Ask the person who should approve it, and show them the request send_approval_request will post/,
  );
  // The request is given to offer them, for send_approval_request's message.
  assert.equal(
    moved.data.suggested_message,
    "Could you take a look and approve it, or let us know what needs to change?",
  );
  assert.equal((await getTask(env, "CDEV", TS)).status, "CLIENT_REVIEW");
  // Slack would ask the person, privately, who approves it; an AI agent asks them itself.
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), "no private prompt");
  const posted = calls
    .filter((call) => call.method === "chat.postMessage")
    .map((call) => call.args.text)
    .join("\n");
  assert.match(posted, /<@UME> set the status to .*Client review/);
  assert.match(posted, /Sent using AI agent/);
  const change = calls.find((call) => call.method === "chat.postMessage" && /set the status/.test(call.args.text)).args;
  assert.equal(JSON.parse(change.blocks).at(-1).block_id, "cade_agent_footer");

  // A change that isn't to Client review doesn't tell the agent to ask anyone.
  await putTask(env, "CDEV", "1700000001.000100", stored({ status: "TODO" }));
  assert.doesNotMatch(
    (await tool(url, "update_task", { task_id: "CDEV:1700000001.000100", status: "IN_PROGRESS" })).text,
    /send_approval_request/,
  );
});

test("update_task posts only the change: what it asks of people is given to the agent to offer, not sent", async (t) => {
  const TS = "1700000000.000100";
  await putTask(env, "CDEV", TS, stored({ status: "TODO" }));
  const calls = mock(t, { "conversations.info": { channel: { name: "dev" } }, "users.info": WORKSPACE });
  const url = addressIn(await slash("mcp init", "UME"));

  const assigned = await tool(url, "update_task", { task_id: `CDEV:${TS}`, owner: { add: ["UBOB"] } });
  assert.equal(assigned.isError, false, assigned.text);
  const posted = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.text);
  assert.deepEqual(posted, ["<@UME> assigned <@UBOB> as owner.\nSent using AI agent"]);
  assert.ok(
    !calls.some((call) => call.method === "chat.postEphemeral"),
    "no private draft: the person isn't looking at Slack",
  );
  // The agent gets the request, to ask the person about, with send_thread_message.
  assert.equal(assigned.data.suggested_message, "<@UBOB>, could you pick this up?");
  assert.match(
    assigned.text,
    /Nothing was sent to the people it names\. Ask the person whether to send this .*send_thread_message/,
  );

  // Nothing to ask: nothing suggested.
  const moved = await tool(url, "update_task", { task_id: `CDEV:${TS}`, priority: "Low" });
  assert.equal(moved.data.suggested_message, "");
  assert.doesNotMatch(moved.text, /send_thread_message/);
});
