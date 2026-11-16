import assert from "node:assert/strict";
import test from "node:test";
import { putTask } from "../src/db.ts";
import { DB, MOVED, WORKSPACE, addressIn, env, keep, mock, slash, stored, tool } from "./mcp-app.ts";

test("get_thread_history reads a thread, and a private channel only for someone in it", async (t) => {
  const replies = [
    { user: "UBOB", ts: "1700000000.000100", text: "We should fix login\nit fails on Safari" },
    { user: "UANN", ts: "1700000060.000200", text: "I'll take it, <@UBOB>", files: [{ name: "log.txt" }] },
    { bot_id: "B1", username: "deploybot", ts: "1700000120.000300", text: "deployed" },
  ];
  const calls = mock(t, {
    "conversations.info": (args) => ({
      channel:
        args.channel === "CPRIV"
          ? { name: "secret", is_private: true }
          : args.channel === "D1"
            ? { is_im: true }
            : { name: "dev" },
    }),
    "conversations.replies": { messages: replies },
  });
  const link = "https://acme.slack.com/archives/CDEV/p1700000000000100";

  const mine = addressIn(await slash("mcp init", "UME"));
  const { text, isError, data } = await tool(mine, "get_thread_history", { link });
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
  assert.deepEqual(
    data.messages.map((message) => message.links),
    [[], [], []],
  );

  // A link to a reply stands for its thread.
  await tool(mine, "get_thread_history", {
    link: `${link.replace("p1700000000000100", "p1700000060000200")}?thread_ts=1700000000.000100&cid=CDEV`,
  });
  assert.equal(calls.filter((call) => call.method === "conversations.replies").at(-1).args.ts, "1700000000.000100");

  // UME isn't in the private channel; UBOB is.
  const priv = "https://acme.slack.com/archives/CPRIV/p1700000000000100";
  assert.match((await tool(mine, "get_thread_history", { link: priv })).text, /aren't in that channel/);
  const bob = addressIn(await slash("mcp init", "UBOB"));
  assert.equal((await tool(bob, "get_thread_history", { link: priv })).isError, false);

  assert.match(
    (await tool(mine, "get_thread_history", { link: "https://example.com" })).text,
    /isn't a link to a Slack message/,
  );
  assert.match(
    (await tool(mine, "get_thread_history", { link: "https://acme.slack.com/archives/D1/p1700000000000100" })).text,
    /direct messages/,
  );
});

test("get_thread_history and get_task_history list each message's links for the agent to open itself", async (t) => {
  const text =
    "Spec in <https://docs.google.com/document/d/abc/edit?a=1&amp;b=2|the doc>, PR <https://github.com/acme/app/pull/7>, " +
    "again <https://github.com/acme/app/pull/7|#7>, mail <mailto:ann@acme.com|Ann>, <@UBOB> in <#CDEV|dev>";
  const links = ["https://docs.google.com/document/d/abc/edit?a=1&b=2", "https://github.com/acme/app/pull/7"];
  mock(t, {
    "conversations.info": { channel: { name: "dev" } },
    "conversations.replies": { messages: [{ user: "UBOB", ts: "1700000000.000100", text }] },
  });
  const url = addressIn(await slash("mcp init", "UME"));

  const fromSlack = await tool(url, "get_thread_history", {
    link: "https://acme.slack.com/archives/CDEV/p1700000000000100",
  });
  assert.deepEqual(fromSlack.data.messages[0].links, links);

  await putTask(env, "CDEV", "1700000000.000100", stored());
  await DB.prepare(
    "INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES ('CDEV', '1700000000.000100', '1700000000.000100', 'UBOB', ?)",
  )
    .bind(text)
    .run();
  const kept = await tool(url, "get_task_history", { task_id: "CDEV:1700000000.000100" });
  assert.deepEqual(kept.data.messages[0].links, links);
});

test("get_thread_history joins a public channel Cade isn't in", async (t) => {
  let joined = false;
  const calls = mock(t, {
    "conversations.info": { channel: { name: "dev" } },
    "conversations.join": () => ((joined = true), {}),
    "conversations.replies": () =>
      joined ? { messages: [{ user: "UBOB", ts: "1.1", text: "hi" }] } : new Error("not_in_channel"),
  });
  const url = addressIn(await slash("mcp init"));
  const { isError, text } = await tool(url, "get_thread_history", {
    link: "https://acme.slack.com/archives/CDEV/p1700000000000100",
  });
  assert.equal(isError, false, text);
  assert.ok(calls.some((call) => call.method === "conversations.join"));
});

test("get_thread_history reads a thread moved into a task for anyone who can read the task", async (t) => {
  await putTask(env, "CDEV", "1000000000.000100", stored());
  await keep("1000000001.000100", null, MOVED);
  let cadeIn = true;
  mock(t, {
    "conversations.info": (args) => ({
      channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" },
    }),
    "conversations.replies": () =>
      cadeIn
        ? { messages: [{ user: "UBOB", ts: "1600000000.000100", text: "Login fails on Safari" }] }
        : new Error("not_in_channel"),
  });
  const url = addressIn(await slash("mcp init", "UME"));

  // UME isn't in CPRIV, but the thread was moved into a task in CDEV, which UME can read.
  const read = await tool(url, "get_thread_history", { thread_id: "CPRIV:1600000000.000100" });
  assert.equal(read.isError, false, read.text);
  assert.match(read.text, /Login fails on Safari/);
  // Another thread there is still only for its members.
  assert.match(
    (await tool(url, "get_thread_history", { thread_id: "CPRIV:1600000099.000100" })).text,
    /aren't in that channel/,
  );
  // Where Cade isn't in the channel, the agent is told to read it as the person.
  cadeIn = false;
  assert.match(
    (await tool(url, "get_thread_history", { thread_id: "CPRIV:1600000000.000100" })).text,
    /Cade isn't in that channel, so I can't read it: read it with your own Slack tools, as the person/,
  );
});

test("get_thread_history reads only from Slack, even for a task Cade keeps messages of", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  await DB.prepare(
    "INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES ('CDEV', '1700000000.000100', '1700000060.000200', 'UBOB', 'Kept reply')",
  ).run();
  // What conversations.replies gives, or the error it fails with.
  let slack: { messages: unknown[] } | Error = {
    messages: [{ user: "UBOB", ts: "1700000000.000100", text: "We should fix login" }],
  };
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
  assert.match((await tool(url, "get_task_history", { task_id: "CDEV:1700000000.000100" })).text, /Kept reply/);
});

test("get_channels lists the channels Cade and you are both in, public or private, project channels first", async (t) => {
  mock(t, {
    "users.conversations": {
      channels: [
        { id: "CZED", name: "zed" },
        { id: "CDEV", name: "dev" },
        { id: "CPRIV", name: "secret", is_private: true },
        { id: "CMINE", name: "mine", is_private: true },
        { id: "CYOU", name: "you" },
      ],
    },
    "conversations.members": (args) => ({
      members: ["CZED", "CDEV", "CMINE"].includes(args.channel) ? ["UME"] : ["UBOB"],
    }),
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const result = await tool(url, "get_channels", {});
  assert.equal(result.isError, false, result.text);
  assert.equal(result.data.total, 3);
  assert.deepEqual(
    result.data.channels.map((c) => [c.channel_id, c.private, c.project]),
    [
      ["CDEV", false, "acme"],
      ["CMINE", true, ""],
      ["CZED", false, ""],
    ],
  );
  assert.match(result.text, /^3 channels Cade is in:\n1\. #dev \(CDEV\) — project acme/);
  assert.equal((await tool(url, "get_channels", { limit: 1 })).data.channels.length, 1);
  assert.match((await tool(url, "get_channels", { limit: 0 })).text, /limit is a whole number from 1 to 200/);
});

test("get_channel_threads lists people's recent root messages, not Cade's task cards or messages already moved", async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const ts = (ago) => `${now - ago}.000100`;
  const calls = mock(t, {
    "conversations.info": { channel: { name: "support" } },
    "conversations.history": {
      messages: [
        { ts: ts(100), user: "UANN", text: "Checkout fails on Safari", reply_count: 3, latest_reply: ts(50) },
        { ts: ts(200), user: "UBOT", bot_id: "B1", text: "Task card" },
        { ts: ts(300), user: "UBOB", text: "Already moved", reactions: [{ name: "outbox_tray", count: 1 }] },
        { ts: ts(400), user: "UBOB", text: "Anyone free for lunch?" },
        { ts: ts(500), user: "UBOB", subtype: "channel_join", text: "joined" },
        { ts: ts(600), user: "UANN", text: "A reply", thread_ts: ts(100) },
      ],
    },
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const result = await tool(url, "get_channel_threads", { channel_id: "CSUP" });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(
    result.data.threads.map((x) => [x.thread_id, x.user_id, x.reply_count]),
    [
      [`CSUP:${ts(100)}`, "UANN", 3],
      [`CSUP:${ts(400)}`, "UBOB", 0],
    ],
  );
  assert.equal(result.data.total, 2);
  assert.equal(result.data.threads[0].last_reply.length, 16);
  assert.equal(result.data.threads[1].last_reply, "");
  assert.match(result.text, /^2 threads in #support not tracked by Cade, newest first:\n1\. \[/);
  assert.deepEqual(
    (await tool(url, "get_channel_threads", { channel_id: "CSUP", with_replies: true })).data.threads.map(
      (x) => x.user_id,
    ),
    ["UANN"],
  );
  assert.equal((await tool(url, "get_channel_threads", { channel_id: "CSUP", limit: 1 })).data.threads.length, 1);
  assert.ok(calls.some((c) => c.method === "conversations.history" && Number(c.args.oldest) < now));
  assert.match((await tool(url, "get_channel_threads", { channel_id: "nope" })).text, /channel_id is a channel's ID/);
  assert.match(
    (await tool(url, "get_channel_threads", { channel_id: "CSUP", days: 91 })).text,
    /days is a whole number from 1 to 90/,
  );
});

test("a public channel is only for the people in it: its project, tasks and threads are refused to anyone else", async (t) => {
  await putTask(
    env,
    "CBARE",
    "1700000000.000100",
    stored({ title: "Bare's", people: { owner: ["UME"], reviewer: [], tester: [] } }),
  );
  await putTask(
    env,
    "CDEV",
    "1700000001.000100",
    stored({ title: "Dev's", people: { owner: ["UME"], reviewer: [], tester: [] } }),
  );
  mock(t, {
    "conversations.info": (args) => ({ channel: { name: args.channel === "CBARE" ? "bare" : "dev" } }),
    // CBARE is public, and UME isn't in it.
    "conversations.members": (args) => ({ members: args.channel === "CBARE" ? ["UBOB"] : ["UME"] }),
    "conversations.replies": { messages: [{ ts: "1700000000.000100", user: "UBOB", text: "Hello" }] },
    "auth.test": { url: "https://acme.slack.com/" },
    "users.info": WORKSPACE,
  });
  const url = addressIn(await slash("mcp init", "UME"));
  assert.match((await tool(url, "get_projects", {})).text, /^1 project:\n- acme: /);
  const mine = (await tool(url, "get_tasks", { assignees: ["me"] })).text;
  assert.match(mine, /Dev's/);
  assert.doesNotMatch(mine, /Bare's/);
  const task = "CBARE:1700000000.000100";
  assert.match((await tool(url, "get_task", { task_id: task })).text, /aren't in that task's project channel/);
  assert.match((await tool(url, "get_task_history", { task_id: task })).text, /aren't in that task's project channel/);
  assert.match(
    (await tool(url, "update_task", { task_id: task, priority: "Low" })).text,
    /aren't in that task's project channel/,
  );
  assert.match(
    (await tool(url, "send_thread_message", { thread_id: task, text: "hi" })).text,
    /aren't in that task's project channel/,
  );
  assert.match(
    (await tool(url, "get_thread_history", { thread_id: "CBARE:1700000009.000100" })).text,
    /aren't in that channel/,
  );
  assert.match((await tool(url, "get_channel_threads", { channel_id: "CBARE" })).text, /aren't in that channel/);
  assert.match(
    (await tool(url, "create_task", { title: "New", project: "bare" })).text,
    /aren't in that project's channel/,
  );
  assert.match(
    (await tool(url, "get_team_availability", { project: "bare" })).text,
    /aren't in that project's channel/,
  );
});
