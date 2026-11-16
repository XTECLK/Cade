import assert from "node:assert/strict";
import test from "node:test";
import { putTask } from "../src/db.ts";
import { DB, MOVED, addressIn, env, keep, mock, savePrompts, slash, stored, tool } from "./mcp-app.ts";

test("get_task_summary gives the summary saved and how far it covers, and save_task_summary keeps it for the next agent", async (t) => {
  await putTask(env, "CDEV", "1000000000.000100", stored());
  await putTask(env, "CPRIV", "1000000000.000100", stored({ title: "Secret" }));
  await keep("1000000001.000100", null, MOVED);
  await keep("1000000002.000100", "UANN", "On it");
  const calls = mock(t, { "conversations.info": { channel: { name: "dev" } } });
  const url = addressIn(await slash("mcp init", "UME"));
  const taskId = "CDEV:1000000000.000100";

  // No summary yet: the whole thread is get_task_history's.
  const first = await tool(url, "get_task_summary", { task_id: taskId });
  assert.equal(first.isError, false, first.text);
  assert.deepEqual([first.data.summary, first.data.through], ["", ""]);
  assert.ok(!("messages" in first.data));
  assert.match(first.text, /No summary saved yet: the whole thread is get_task_history's\./);

  // Saved without approval and without a word in Slack: only agents read it.
  const saved = await tool(url, "save_task_summary", {
    task_id: taskId,
    summary: "  Login fails on Safari.  ",
    through: "1000000002.000100",
  });
  assert.equal(saved.isError, false, saved.text);
  assert.deepEqual(saved.data, { task_id: taskId, saved: true });
  assert.ok(!calls.some((call) => call.method.startsWith("chat.")));

  // The next agent gets it, and where to read on from.
  await keep("1000000003.000100", "UANN", "Fixed in PR 7");
  const next = await tool(url, "get_task_summary", { task_id: taskId });
  assert.deepEqual(
    [next.data.summary, next.data.summary_by, next.data.through],
    ["Login fails on Safari.", "UME", "1000000002.000100"],
  );
  assert.match(
    next.text,
    /covering the task's thread up to message 1000000002\.000100:\nLogin fails on Safari\.\n\nThe messages after it: get_task_history with since 1000000002\.000100\./,
  );
  const after = await tool(url, "get_task_history", { task_id: taskId, since: next.data.through });
  assert.deepEqual(
    after.data.messages.map((message) => message.text),
    ["Fixed in PR 7"],
  );

  // Two agents at once: the one that covers more wins, and the other is told to read again.
  await tool(url, "save_task_summary", { task_id: taskId, summary: "Second", through: "1000000003.000100" });
  const late = await tool(url, "save_task_summary", {
    task_id: taskId,
    summary: "Stale",
    through: "1000000002.000100",
  });
  assert.match(late.text, /was saved since you read it, so this one wasn't\. Call get_task_summary again/);
  assert.deepEqual([(await tool(url, "get_task_summary", { task_id: taskId })).data.summary], ["Second"]);

  // What's wrong with a call is said, and nothing is saved.
  assert.match(
    (await tool(url, "save_task_summary", { task_id: taskId, summary: "S", through: "1000000009.000100" })).text,
    /isn't a message of the task's thread: pass as through the ts of the last message get_task_history gave/,
  );
  assert.match(
    (await tool(url, "save_task_summary", { task_id: taskId, summary: " ", through: "1000000003.000100" })).text,
    /empty/,
  );
  assert.match(
    (await tool(url, "save_task_summary", { task_id: taskId, summary: "x".repeat(8001), through: "1000000003.000100" }))
      .text,
    /8001 characters/,
  );
  assert.match(
    (
      await tool(url, "save_task_summary", {
        task_id: taskId,
        summary: "Use AKIAABCDEFGHIJKLMNOP to reproduce.",
        through: "1000000003.000100",
      })
    ).text,
    /looks like it contains a AWS access key/,
  );
  assert.match(
    (await tool(url, "save_task_summary", { task_id: "CPRIV:1000000000.000100", summary: "S", through: "1.1" })).text,
    /aren't in that task's project channel/,
  );
  assert.match(
    (await tool(url, "get_task_summary", { task_id: "CPRIV:1000000000.000100" })).text,
    /aren't in that task's project channel/,
  );
  assert.match(
    (await tool(url, "get_task_summary", { task_id: "CDEV:9000000000.000100" })).text,
    /isn't a task Cade tracks/,
  );
  // update_task no longer takes a summary.
  assert.match((await tool(url, "update_task", { task_id: taskId, summary: "S" })).text, /summary/);
});

test("get_task_history gives only the messages after since, with the thread the task was made from", async (t) => {
  await putTask(env, "CDEV", "1000000000.000100", stored());
  await keep("1000000001.000100", null, MOVED);
  await keep("1000000002.000100", "UANN", "On it");
  await keep("1000000003.000100", "UANN", "Done");
  mock(t, { "conversations.info": { channel: { name: "dev" } } });
  const url = addressIn(await slash("mcp init", "UME"));
  const later = await tool(url, "get_task_history", { task_id: "CDEV:1000000000.000100", since: "1000000002.000100" });
  assert.deepEqual(
    later.data.messages.map((message) => message.text),
    ["Done"],
  );
  assert.deepEqual(later.data.original_thread, {
    thread_id: "CPRIV:1600000000.000100",
    link: "https://acme.slack.com/archives/CPRIV/p1600000000000100",
  });
  assert.match(later.text, /1 kept message after 1000000002\.000100, oldest first:/);
  const none = await tool(url, "get_task_history", { task_id: "CDEV:1000000000.000100", since: "1000000003.000100" });
  assert.deepEqual(none.data.messages, []);
  assert.match(
    (await tool(url, "get_task_history", { task_id: "CDEV:1000000000.000100", since: "yesterday" })).text,
    /since/,
  );
});

test("get_task_summary names the team's task-summary prompt, which get_prompt gives with the task filled in", async (t) => {
  await putTask(env, "CDEV", "1000000000.000100", stored());
  await keep("1000000001.000100", "UANN", "On it");
  mock(t, { "conversations.info": { channel: { name: "dev" } } });
  const url = addressIn(await slash("mcp init", "UME"));
  const taskId = "CDEV:1000000000.000100";

  // Without the prompt, nothing is named.
  const plain = await tool(url, "get_task_summary", { task_id: taskId });
  assert.equal(plain.data.prompt, "");
  assert.doesNotMatch(plain.text, /get_prompt/);
  assert.match(
    (await tool(url, "get_prompt", { name: "task-summary" })).text,
    /There is no prompt called "task-summary"\. This deployment has none\./,
  );

  await savePrompts();
  const named = await tool(url, "get_task_summary", { task_id: taskId });
  assert.equal(named.data.prompt, "task-summary");
  assert.match(
    named.text,
    /The team's steps for a task's summary: get_prompt with name "task-summary" and arguments \{"task": "CDEV:1000000000\.000100"\}\.$/,
  );

  // The same text as picking the prompt, with the task after it.
  const steps = await tool(url, "get_prompt", { name: "task-summary", arguments: { task: taskId } });
  assert.equal(steps.isError, false, steps.text);
  assert.equal(steps.data.name, "task-summary");
  assert.match(steps.data.text, /^# Summarize a task\n/);
  assert.match(steps.data.text, /\n## Given\n\n- task: CDEV:1000000000\.000100\n$/);
  assert.equal(steps.text, steps.data.text);
  // What's missing or unknown is refused, naming what there is.
  assert.match((await tool(url, "get_prompt", { name: "task-summary" })).text, /needs task/);
  assert.match(
    (await tool(url, "get_prompt", { name: "nope" })).text,
    /There is no prompt called "nope"\. They are: report, task-summary\./,
  );
});

test("get_task_history with a consumer gives what it hasn't acknowledged, and ack_task_history moves it on for everyone", async (t) => {
  await putTask(env, "CDEV", "1000000000.000100", stored());
  await putTask(env, "CPRIV", "1000000000.000100", stored({ title: "Secret" }));
  await keep("1000000001.000100", "UREX", "On it");
  await keep("1000000002.000100", "UREX", "PR is up, ready for review");
  const calls = mock(t, { "conversations.info": { channel: { name: "dev" } } });
  const url = addressIn(await slash("mcp init", "UME"));
  const bob = addressIn(await slash("mcp init", "UBOB"));
  const taskId = "CDEV:1000000000.000100";

  // Never read: every message, and a token for the last.
  const first = await tool(url, "get_task_history", { task_id: taskId, consumer: "sync-tasks" });
  assert.equal(first.isError, false, first.text);
  assert.deepEqual([first.data.messages.length, first.data.token], [2, "1000000002.000100"]);
  assert.match(first.text, /2 kept messages \(sync-tasks has read none yet\), oldest first:/);
  assert.match(first.text, /Token: 1000000002\.000100\. Once these are handled, ack_task_history with it/);
  // Without a consumer there's no token, and since and consumer don't go together.
  assert.equal((await tool(url, "get_task_history", { task_id: taskId })).data.token, "");
  assert.match(
    (await tool(url, "get_task_history", { task_id: taskId, since: "1000000001.000100", consumer: "sync-tasks" })).text,
    /Give since or consumer, not both/,
  );

  // Acknowledged without approval and without a word in Slack; the next read, by anyone, gives only what's new.
  const acked = await tool(url, "ack_task_history", {
    task_id: taskId,
    consumer: "sync-tasks",
    token: first.data.token,
  });
  assert.deepEqual(acked.data, { task_id: taskId, consumer: "sync-tasks", acked: true });
  assert.ok(!calls.some((call) => call.method.startsWith("chat.")));
  await keep("1000000003.000100", "UANN", "QA passed");
  const next = await tool(bob, "get_task_history", { task_id: taskId, consumer: "sync-tasks" });
  assert.deepEqual(
    [next.data.messages.map((message) => message.text), next.data.token],
    [["QA passed"], "1000000003.000100"],
  );
  assert.match(next.text, /1 kept message not read yet by sync-tasks \(last acknowledged by UME at /);
  // Another consumer has a position of its own.
  assert.equal((await tool(url, "get_task_history", { task_id: taskId, consumer: "standup" })).data.messages.length, 3);

  // Nothing new: no messages, and the same position as the token.
  await tool(bob, "ack_task_history", { task_id: taskId, consumer: "sync-tasks", token: "1000000003.000100" });
  const none = await tool(url, "get_task_history", { task_id: taskId, consumer: "sync-tasks" });
  assert.deepEqual([none.data.messages, none.data.token], [[], "1000000003.000100"]);

  // A position only moves forward, and only to a message of the thread.
  assert.match(
    (await tool(url, "ack_task_history", { task_id: taskId, consumer: "sync-tasks", token: "1000000002.000100" })).text,
    /sync-tasks has read further since, so its position wasn't moved back/,
  );
  assert.match(
    (await tool(url, "ack_task_history", { task_id: taskId, consumer: "sync-tasks", token: "1000000009.000100" })).text,
    /isn't a message of the task's thread: pass the token get_task_history gave/,
  );
  assert.match(
    (await tool(url, "ack_task_history", { task_id: taskId, consumer: "Sync Tasks", token: "1000000003.000100" })).text,
    /consumer/,
  );
  assert.match(
    (await tool(url, "ack_task_history", { task_id: "CPRIV:1000000000.000100", consumer: "sync-tasks", token: "1.1" }))
      .text,
    /aren't in that task's project channel/,
  );

  // A task keeps positions for at most ten consumers: sync-tasks and nine more (standup only read, so holds none).
  for (let i = 0; i < 9; i++)
    await tool(url, "ack_task_history", { task_id: taskId, consumer: `c${i}`, token: "1000000001.000100" });
  assert.match(
    (await tool(url, "ack_task_history", { task_id: taskId, consumer: "one-more", token: "1000000001.000100" })).text,
    /keeps positions for 10 consumers already/,
  );
});

test("get_task_history gives the messages Cade kept, only for a task it tracks and a channel you can read", async (t) => {
  await putTask(env, "CDEV", "1700000000.000100", stored());
  await putTask(env, "CPRIV", "1700000000.000100", stored({ title: "Secret" }));
  await putTask(env, "CBARE", "1700000000.000100", stored({ title: "Quiet" }));
  const keep = (channel, ts, user, text) =>
    DB.prepare("INSERT INTO messages (channel, task_ts, ts, user_id, text) VALUES (?, '1700000000.000100', ?, ?, ?)")
      .bind(channel, ts, user, text)
      .run();
  await keep("CDEV", "1700000000.000100", "UBOB", "We should fix login\nit fails on Safari");
  await keep("CDEV", "1700000060.000200", "UANN", "I'll take it");
  await keep("CPRIV", "1700000000.000100", "UBOB", "hush");
  const calls = mock(t, {
    "conversations.info": (args) => ({
      channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" },
    }),
  });
  const url = addressIn(await slash("mcp init", "UME"));

  const result = await tool(url, "get_task_history", { task_id: "CDEV:1700000000.000100" });
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

  // A private channel is for its members only: UME isn't in it, UBOB is.
  const priv = "CPRIV:1700000000.000100";
  assert.match((await tool(url, "get_task_history", { task_id: priv })).text, /aren't in that task's project channel/);
  const bob = addressIn(await slash("mcp init", "UBOB"));
  assert.match((await tool(bob, "get_task_history", { task_id: priv })).text, /Task "Secret" in #secret.*hush/s);
  // A task with nothing kept.
  assert.match(
    (await tool(url, "get_task_history", { task_id: "CBARE:1700000000.000100" })).text,
    /No messages are kept for "Quiet"/,
  );

  // By task ID, the form get_tasks gives: the same messages, and the same rules.
  const byId = await tool(url, "get_task_history", { task_id: "CDEV:1700000000.000100" });
  assert.equal(byId.isError, false, byId.text);
  assert.equal(byId.text, result.text);
  assert.match((await tool(url, "get_task_history", { task_id: " CDEV:1700000000.000100 " })).text, /2 kept messages/);
  assert.match(
    (await tool(url, "get_task_history", { task_id: "CPRIV:1700000000.000100" })).text,
    /aren't in that task's project channel/,
  );
  assert.match((await tool(bob, "get_task_history", { task_id: "CPRIV:1700000000.000100" })).text, /hush/);
  assert.match(
    (await tool(url, "get_task_history", { task_id: "CDEV:1600000000.000100" })).text,
    /isn't a task Cade tracks/,
  );
  assert.match(
    (await tool(url, "get_task_history", { task_id: "12" })).text,
    /channel and the message time joined by a colon/,
  );
  assert.match((await tool(url, "get_task_history", {})).text, /Give task_id\./);
});
