import assert from "node:assert/strict";
import test from "node:test";
import { getTask, markTaskDeleted } from "../src/db.ts";
import type { AppEnv } from "../src/env.ts";
import {
  MR,
  PR,
  PR4,
  RESPONSE_URL,
  T1,
  T2,
  TARGET,
  answerPrivately,
  cardLink,
  cardMenu,
  deleteClick,
  deleteRequest,
  devTask,
  env,
  historyTask,
  interaction,
  lastCalls,
  messageLink,
  mockGitHub,
  mockSlack,
  ownTask,
  prsLineOf,
  recordResponses,
  runTasksCommand,
  savedTask,
  seeded,
  send,
  subtaskOf,
  threadEvent,
  withStatus,
} from "./app.ts";

test("admin commands have no @Cade form: delete, remove, replace, resync, retry and project are unknown", async (t) => {
  for (const name of ["delete", "remove", "replace", "resync", "retry", "project"]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(`<@UBOT> ${name}`));
    assert.equal(calls.at(-1).args.text, "Send `/cade help` to see what I can do.", name);
    assert.ok(await savedTask(), name);
  }
});

test("confirming deletion removes Cade's replies and then the task", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": {
      messages: [
        { ts: "100.1", bot_id: "BCADE" },
        { ts: "100.2", user: "UACTOR" },
        { ts: "100.3", bot_id: "BCADE" },
        { ts: "100.4", bot_id: "BCADE" },
      ],
    },
  });
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      actions: [{ action_id: "delete:confirm", value: deleteRequest }],
    }),
  );

  assert.equal(response.status, 200);
  const deletes = calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts);
  assert.deepEqual(deletes, ["100.3", "100.4", "100.1"]);
  // Whoever confirmed sees the task go: nothing is posted, not even
  // privately.
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("deleting a task posts nothing, and only answers whoever asked", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["conversations.replies", "chat.delete", "respond"],
  );
  assert.deepEqual(calls.at(-1).args, { response_type: "ephemeral", replace_original: true, text: "Done, it's gone." });
});

test("a task whose deletion failed after it was marked deleted can be removed again", async (t) => {
  const ts = "1700000000.000100";
  const calls = mockSlack(t, {
    stored: [{ ...withStatus("TODO"), ts }],
    "conversations.replies": (args) => ({ messages: [{ ts: args.ts, bot_id: "BCADE" }] }),
  });
  await seeded;
  await markTaskDeleted(env, "CDEV", ts);
  const ask = (await runTasksCommand(`remove <${messageLink("CDEV", ts)}>`, "CDEV")).later;
  assert.match(ask.text, /should I delete the task \*Fix login\*\?/);

  await answerPrivately(t, ask, "delete:confirm");
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts),
    [ts],
  );
});

test("a failed task deletion leaves the task to be tried again", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }] },
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    url.endsWith("/chat.delete") ? Response.json({ ok: false, error: "ratelimited" }) : fetch(url, init);
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR")).catch(() => {});
  assert.ok(calls.some((call) => call.method === "conversations.replies"));
  assert.ok(await savedTask());
});

test("deleting copes with a thread that's gone and replies it can't delete", async (t) => {
  // The thread is gone, replies and all: the root still goes.
  let calls = mockSlack(t, { stored: [ownTask()], "conversations.replies": { ok: false, error: "thread_not_found" } });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts),
    ["100.1"],
  );

  // A reply that can't be deleted is passed over.
  calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": {
      messages: [
        { ts: "100.1", bot_id: "BCADE" },
        { ts: "100.3", bot_id: "BOTHER" },
      ],
    },
    "chat.delete": (args) => (args.ts === "100.3" ? { ok: false, error: "cant_delete_message" } : {}),
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts),
    ["100.3", "100.1"],
  );

  // Reading the replies fails for another reason: nothing is deleted.
  calls = mockSlack(t, { stored: [ownTask()], "conversations.replies": { ok: false, error: "ratelimited" } });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.ok(!calls.some((call) => call.method === "chat.delete"));
});

test("/cade resync <link> redraws a task's card, with its menu, and tells only whoever sent it", async (t) => {
  // A task at a timestamp a Slack link can name.
  const ts = "1700000000.000100";
  const task = { ...ownTask(), ts };
  task.task.link = "https://slack.example/p100";
  const calls = mockSlack(t, { stored: [task] });
  // A link to a reply in the task's thread stands for the task.
  const link = "https://acme.slack.com/archives/CDEV/p1700000000000500?thread_ts=1700000000.000100&amp;cid=CDEV";
  const { now, later } = await runTasksCommand(`resync <${link}>`, "COTHER");
  assert.equal(now, "");
  assert.equal(later.text, "Resynced the task <https://slack.example/p100|Fix login>.");
  const card = calls.find((call) => call.method === "chat.update" && call.args.ts === ts).args;
  assert.equal(cardMenu(card).action_id, "task:menu");
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("/cade remove <link> asks privately, then removes what the link points at", async (t) => {
  // A task at a timestamp a Slack link can name.
  const ts = "1700000000.000100";
  const removing = (responses = {}) =>
    mockSlack(t, {
      stored: [{ ...ownTask(), ts }],
      "conversations.replies": { messages: [{ ts: "1700000000.000500", bot_id: "BCADE" }] },
      ...responses,
    });

  // The task's root: its card and Cade's replies, asked privately.
  let calls = removing();
  let { now, later } = await runTasksCommand(
    "remove <https://acme.slack.com/archives/CDEV/p1700000000000100>",
    "COTHER",
  );
  assert.equal(now, "");
  assert.match(later.text, /^<@UACTOR>, should I delete the task \*Fix login\*\?/);
  const [cancel, button] = later.blocks[1].elements;
  // Cancel is first and prominent; Delete is plain, and asks again.
  assert.deepEqual([cancel.action_id, cancel.style], ["delete:cancel", "primary"]);
  assert.deepEqual([button.action_id, button.style, Boolean(button.confirm)], ["delete:confirm", undefined, true]);
  assert.deepEqual(JSON.parse(button.value), { kind: "task", channel: "CDEV", ts });
  let responses = await answerPrivately(t, later, "delete:confirm");
  assert.equal(await savedTask("CDEV", ts), null);
  assert.deepEqual(responses, [{ response_type: "ephemeral", replace_original: true, text: "Done, it's gone." }]);

  // A reply: just that message.
  calls = removing();
  ({ later } = await runTasksCommand(
    "remove <https://acme.slack.com/archives/CDEV/p1700000000000900?thread_ts=1700000000.000100&cid=CDEV>",
    "COTHER",
  ));
  assert.equal(later.text, "<@UACTOR>, should I remove that message? There's no undo.");
  assert.equal(later.blocks[1].elements[1].text.text, "Delete message");
  responses = await answerPrivately(t, later, "delete:confirm");
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts),
    ["1700000000.000900"],
  );
  assert.equal(responses[0].text, "Done, that message is gone.");
  assert.ok(await savedTask("CDEV", ts));

  // Someone else's reply stays.
  removing({ "chat.delete": { ok: false, error: "cant_delete_message" } });
  ({ later } = await runTasksCommand(
    "remove <https://acme.slack.com/archives/CDEV/p1700000000000900?thread_ts=1700000000.000100&cid=CDEV>",
    "COTHER",
  ));
  responses = await answerPrivately(t, later, "delete:confirm");
  assert.equal(responses[0].text, "I can only remove my own messages, so that one stays.");

  // Any other message: Cade's replies in its thread, and the message if it's
  // Cade's.
  calls = removing({
    "chat.delete": (args) => (args.ts === "1700000000.000700" ? { ok: false, error: "cant_delete_message" } : {}),
  });
  ({ later } = await runTasksCommand("remove <https://acme.slack.com/archives/CDEV/p1700000000000700>", "COTHER"));
  assert.equal(later.text, "<@UACTOR>, should I remove my messages in that thread? There's no undo.");
  responses = await answerPrivately(t, later, "delete:confirm");
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts),
    ["1700000000.000500", "1700000000.000700"],
  );
  assert.equal(responses[0].text, "Done, my replies are gone. The message itself isn't mine, so it stays.");

  // Cancel just drops the question.
  removing();
  ({ later } = await runTasksCommand("remove <https://acme.slack.com/archives/CDEV/p1700000000000700>", "COTHER"));
  responses = await answerPrivately(t, later, "delete:cancel");
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("/cade remove needs a link", async (t) => {
  mockSlack(t);
  const { now } = await runTasksCommand("remove", "CDEV");
  assert.match(JSON.parse(now).text, /^Paste the link to what to remove/);
});

test("/cade replace changes what one of Cade's messages says, from anywhere", async (t) => {
  const REPLY = "1700000000.000200";
  const link = `<${messageLink("CDEV", REPLY, "?thread_ts=1700000000.000100&cid=CDEV")}>`;
  for (const [text, said] of [
    [`replace ${link} "The *deposit* goes live on Friday, <@UBOB>"`, "The *deposit* goes live on Friday, <@UBOB>"],
    [`replace ${link} No quotes needed`, "No quotes needed"],
  ] as const) {
    const calls = mockSlack(t);
    const { now, later } = await runTasksCommand(text, "CRANDOM");
    assert.equal(now, "");
    const update = calls.find((call) => call.method === "chat.update").args;
    assert.deepEqual(update, {
      channel: "CDEV",
      ts: REPLY,
      text: said,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: said } }],
      attachments: [],
    });
    assert.equal(later.text, "Done, the message says that now.");
  }
});

test("/cade replace leaves task cards and other people's messages alone, and needs a link and text", async (t) => {
  // A task's card is drawn from the task.
  let calls = mockSlack(t, { stored: [devTask(TARGET, "Fix login", "TODO")] });
  let { later } = await runTasksCommand(`replace <${messageLink("CDEV", TARGET)}> New title`, "CDEV");
  assert.ok(!calls.some((call) => call.method === "chat.update"));
  assert.match(later.text, /^That's a task's card/);

  // Slack won't let Cade change someone else's message.
  calls = mockSlack(t, { "chat.update": { ok: false, error: "cant_update_message" } });
  ({ later } = await runTasksCommand(`replace <${messageLink("CDEV", TARGET)}> Hello`, "CDEV"));
  assert.equal(later.text, "I can only change my own messages, so that one stays as it is.");

  for (const text of [
    "replace",
    `replace <${messageLink("CDEV", TARGET)}>`,
    `replace <${messageLink("CDEV", TARGET)}> ""`,
    "replace just words",
  ]) {
    mockSlack(t);
    const { now } = await runTasksCommand(text, "CDEV");
    assert.match(JSON.parse(now).text, /^Paste the link to my message, then what it should say/, text);
  }
});

test("the admin commands, and their buttons, are only for Cade's admins", async (t) => {
  const notAdmin = { ...env, ADMINS: JSON.stringify(["USOMEONE"]) } as AppEnv;
  for (const command of [
    `remove <${messageLink("CDEV", T1)}>`,
    `replace <${messageLink("CDEV", T1)}> New text`,
    `resync <${messageLink("CDEV", T1)}>`,
    "resync summary",
    "resync all",
    `retry <${messageLink("CDEV", T1)}>`,
    `subtask link ${cardLink(T2)} ${cardLink(T1)}`,
  ]) {
    const calls = mockSlack(t, { stored: [historyTask(T1, { title: "Main" })] });
    const { now, later } = await runTasksCommand(command, "CDEV", notAdmin);
    assert.equal(JSON.parse(now).text, "Only Cade's admins can do that.", command);
    assert.equal(later, undefined, command);
    assert.deepEqual(calls, [], command);
  }
  // A Delete button sent to an admin does nothing for anyone else.
  mockSlack(t, { stored: [historyTask(T1, { title: "Main" })] });
  const responses = recordResponses(t);
  const value = JSON.stringify({ channel: "CDEV", ts: T1, kind: "task" });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UOTHER" },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "delete:confirm", value }],
    }),
    {},
    notAdmin,
  );
  assert.deepEqual(responses, [{ response_type: "ephemeral", text: "Only Cade's admins can do that." }]);
  assert.ok(await getTask(env, "CDEV", T1));
  // The `@Cade subtask` form stays for everyone: only `/cade subtask` is for admins.
  mockSlack(t, { stored: [ownTask()] });
  await send("/slack/events", threadEvent("<@UBOT> subtask"), {}, notAdmin);
  assert.match(lastCalls.find((call) => call.method === "chat.postMessage").args.text, /Give the subtask a title/);
});

test("/cade resync all redraws every card in the channel, Done ones and subtasks too, quietly", async (t) => {
  const calls = mockSlack(t, {
    stored: [
      historyTask("100.1", { title: "Main" }),
      subtaskOf("100.2"),
      historyTask("100.3", { title: "Finished", status: "DONE" }),
    ],
  });
  const { later } = await runTasksCommand("resync all", "CDEV");
  assert.equal(later.text, "Redrew cards 1–3 of 3: every card in this channel is up to date.");
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.update").map((call) => call.args.ts),
    ["100.1", "100.2", "100.3"],
  );
  // Only the cards: nothing in any thread.
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));

  // Outside a project's channel, it says where to send it.
  const elsewhere = await runTasksCommand("resync all", "CELSEWHERE");
  assert.match(JSON.parse(elsewhere.now).text, /in a project's dev channel/);
});

test("/cade resync reads its tasks' GitHub pull requests again, all in one request, and draws the cards with them", async (t) => {
  const withToken = { ...env, GITHUB_TOKEN: "ghp_test" };
  const tasks = () => [
    historyTask("1700000000.000100", { title: "Main", prs: [PR, MR] }),
    historyTask("1700000000.000300", { title: "Finished", status: "DONE", prs: [PR4] }),
  ];
  const prLine = (calls, ts) =>
    prsLineOf(calls.find((call) => call.method === "chat.update" && call.args.ts === ts).args);

  // Several links: one request for every link's pull requests (the GitLab one isn't GitHub's).
  let calls = mockSlack(t, { stored: tasks() });
  let asked = mockGitHub({ 42: "MERGED", 9: "CLOSED" });
  await runTasksCommand(
    `resync ${messageLink("CDEV", "1700000000.000100")} ${messageLink("CDEV", "1700000000.000300")}`,
    "CDEV",
    withToken,
  );
  assert.equal(asked.length, 1);
  assert.match(asked[0]!.query, /number: 42\)/);
  assert.match(asked[0]!.query, /number: 9\)/);
  assert.equal(prLine(calls, "1700000000.000100"), "Pull requests: 1 open  ·  1 merged");
  assert.equal(prLine(calls, "1700000000.000300"), "Pull requests: 0 open  ·  0 merged");

  // All: one request for every card's in the channel, Done ones too, before they're drawn.
  calls = mockSlack(t, { stored: tasks() });
  asked = mockGitHub({ 42: "MERGED", 9: "MERGED" });
  const { later } = await runTasksCommand("resync all", "CDEV", withToken);
  assert.equal(later.text, "Redrew cards 1–2 of 2: every card in this channel is up to date.");
  assert.equal(asked.length, 1);
  assert.equal(prLine(calls, "1700000000.000100"), "Pull requests: 1 open  ·  1 merged");
  assert.equal(prLine(calls, "1700000000.000300"), "Pull requests: 0 open  ·  1 merged");

  // Without a token, nothing is asked, and the cards are still drawn.
  calls = mockSlack(t, { stored: tasks() });
  asked = mockGitHub({ 42: "MERGED" });
  await runTasksCommand("resync all", "CDEV");
  assert.equal(asked.length, 0);
  assert.equal(prLine(calls, "1700000000.000100"), "Pull requests: 2 open  ·  0 merged");
});

test("/cade resync all goes 40 cards a run, and says what to send for the next, or where to start again when Slack slows it", async (t) => {
  const stored = Array.from({ length: 42 }, (_, i) => historyTask(`${101 + i}.1`, { title: `Task ${i + 1}` }));
  let calls = mockSlack(t, { stored });
  assert.equal(
    (await runTasksCommand("resync all", "CDEV")).later.text,
    "Redrew cards 1–40 of 42. In a minute, send `/cade resync all 40` for the next ones.",
  );
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 40);
  calls = mockSlack(t, { stored });
  assert.equal(
    (await runTasksCommand("resync all 40", "CDEV")).later.text,
    "Redrew cards 41–42 of 42: every card in this channel is up to date.",
  );
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.update").map((call) => call.args.ts),
    ["141.1", "142.1"],
  );

  mockSlack(t, {
    stored: stored.slice(0, 3),
    "chat.update": (args) => (args.ts === "102.1" ? { ok: false, error: "ratelimited" } : {}),
  });
  assert.equal(
    (await runTasksCommand("resync all", "CDEV")).later.text,
    "Redrew card 1 of 3 before Slack asked me to slow down. In a minute, send `/cade resync all 1` for the next ones.",
  );
});
