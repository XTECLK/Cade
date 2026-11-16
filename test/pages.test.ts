import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";
import { context } from "./helpers.ts";
import {
  DB,
  NAMES,
  RESYNC_TS,
  SITE,
  allBlocks,
  blockText,
  createdTask,
  env,
  footerLines,
  get,
  interaction,
  lastCalls,
  messageLink,
  mockSlack,
  ownTask,
  reply,
  runTasksCommand,
  seeded,
  send,
  submission,
  threadEvent,
} from "./app.ts";

const storedMessages = async () => (await DB.prepare("SELECT * FROM messages ORDER BY ts").all()).results;
const linkLine = (card) => blockText(allBlocks(card)[1]);

test("Resync links the task's thread page on the card, and reads its thread into the database", async (t) => {
  const thread = [
    { user: "UREX", ts: RESYNC_TS, text: "Fix login" },
    {
      user: "UBOB",
      ts: "1700000000.000300",
      text: "On it",
      files: [{ name: "a.png", permalink: "https://acme.slack.com/files/a.png" }],
    },
  ];
  const calls = mockSlack(t, {
    stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }],
    "conversations.replies": () => ({ messages: thread }),
  });
  await runTasksCommand(`resync ${messageLink("CDEV", RESYNC_TS)}`, "CDEV", env);
  const card = calls.filter((call) => call.method === "chat.update").at(-1).args;
  assert.equal(linkLine(card), `Full history <${SITE}/t/CDEV/${RESYNC_TS}|here>`);
  assert.match(blockText(allBlocks(card)[2]), /^:memo: To do/);
  assert.equal(footerLines(card)[0], "Owner <@UREX>");
  const rows = await storedMessages();
  assert.deepEqual(
    rows.map((row) => [row.task_ts, row.ts, row.user_id, row.text]),
    [
      [RESYNC_TS, RESYNC_TS, "UREX", "Fix login"],
      [RESYNC_TS, "1700000000.000300", "UBOB", "On it"],
    ],
  );
  assert.deepEqual(JSON.parse(rows[1].files as string), [
    { name: "a.png", permalink: "https://acme.slack.com/files/a.png" },
  ]);

  // Again: nothing is stored twice.
  calls.length = 0;
  await runTasksCommand(`resync ${messageLink("CDEV", RESYNC_TS)}`, "CDEV", env);
  assert.equal((await storedMessages()).length, 2);
  assert.ok(!calls.some((call) => call.method === "doc"));
});
test("a new task has its thread stored as it is created, and its card links its thread's page", async (t) => {
  const calls = mockSlack(t, {
    ...createdTask,
    "conversations.replies": () => ({ messages: [{ user: "UBOT", ts: "100.1", text: "Fix login" }] }),
  });
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "Low" })));
  assert.deepEqual(
    (await storedMessages()).map((row) => [row.task_ts, row.ts, row.text]),
    [["100.1", "100.1", "Fix login"]],
  );
  const update = calls.find((call) => call.method === "chat.update");
  assert.equal(update.args.ts, "100.1");
  assert.equal(linkLine(update.args), `Full history <${SITE}/t/CDEV/100.1|here>`);
  const { loadTask } = await import("../src/tasks.ts");
  assert.deepEqual((await loadTask(env, "CDEV", "100.1")).export, { url: `${SITE}/t/CDEV/100.1` });
});

test("a reply is stored at once, only from a tracked task's thread, and not twice", async (t) => {
  mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })] });
  await seeded;
  await send("/slack/events", reply("UREX", "100.6", "in the thread"));
  await send("/slack/events", reply("UREX", "100.6", "in the thread"));
  await send("/slack/events", threadEvent("not a task", { thread_ts: "999.1", ts: "100.8" }));
  await send("/slack/events", threadEvent("joined", { subtype: "channel_join", ts: "100.9" }));
  assert.deepEqual(
    (await storedMessages()).map((row) => [row.task_ts, row.ts, row.text]),
    [["100.1", "100.6", "in the thread"]],
  );
});

// Presses a button in Cade's web pages modal (see commands/configure.js) as `user`, with the calls of the last
// mockSlack. Resolves to the text of the modal Cade drew in answer.
async function pressWeb(actionId, user = "UACTOR") {
  const before = lastCalls.length;
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: user },
      trigger_id: "T1",
      view: { id: "V1" },
      actions: [{ action_id: actionId, value: "" }],
    }),
  );
  const view = lastCalls.slice(before).find((call) => call.method === "views.update" || call.method === "views.open")
    .args.view;
  return view.blocks.map((block) => block.text?.text ?? "").join("\n");
}

// Signs in the way a person does: the Get a sign-in link button, then the link it gives. Returns the cookie.
async function signIn() {
  const link = /<(https:\/\/worker\.example\.net\/login\/[\w-]+)\|/.exec(await pressWeb("home:web:login"))[1];
  const response = await worker.fetch(new Request(link), env, context());
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

test("the web pages modal's sign-in link signs you in once, for the thread pages", async (t) => {
  mockSlack(t, {
    stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }],
    "conversations.info": { channel: { name: "dev" } },
    "users.info": ({ user }) => ({ user: NAMES[user] }),
  });
  await seeded;
  const link = /<(https:\/\/worker\.example\.net\/login\/[\w-]+)\|/.exec(await pressWeb("home:web:login"))[1];
  const first = await get(new URL(link).pathname);
  assert.equal(first.status, 200);
  assert.match(
    first.headers.get("set-cookie"),
    /^cade_session=[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
  );
  // Used up: the same link doesn't work again.
  assert.equal((await get(new URL(link).pathname)).status, 401);
  assert.equal((await get("/login/not-a-code")).status, 401);
});

test("the thread page shows the stored messages with names, only for those in the channel, and there is no notes page", async (t) => {
  const calls = mockSlack(t, {
    stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }],
    "conversations.info": { channel: { name: "dev" } },
    "conversations.members": { members: ["UACTOR"] },
    "users.info": ({ user }) => ({ user: NAMES[user] }),
  });
  await seeded;
  await send(
    "/slack/events",
    threadEvent("hello <@UBOB> &amp; <b>co</b>", { user: "UREX", ts: "1700000000.000400", thread_ts: RESYNC_TS }),
  );
  const cookie = await signIn();

  // Not signed in: told how.
  const anonymous = await get(`/t/CDEV/${RESYNC_TS}`);
  assert.equal(anonymous.status, 401);
  assert.match(await anonymous.text(), /Web pages/);

  const thread = await get(`/t/CDEV/${RESYNC_TS}`, cookie);
  assert.equal(thread.status, 200);
  const html = await thread.text();
  assert.match(html, /<strong>Rex<\/strong>/);
  // Markup is plain text and HTML is escaped.
  assert.match(html, /hello @Bob Lee &amp; &lt;b&gt;co&lt;\/b&gt;/);
  assert.equal(thread.headers.get("cache-control"), "no-store");

  // A page for a task Cade doesn't have is not found.
  assert.equal((await get("/t/CDEV/1.1", cookie)).status, 404);
  assert.equal((await get("/t/not-a-channel/1.1", cookie)).status, 404);

  // The notes page is gone: an old card's link to it finds nothing, and the thread page doesn't link it.
  assert.equal((await get(`/n/CDEV/${RESYNC_TS}`, cookie)).status, 404);
  assert.doesNotMatch(html, /Notes/);
  assert.equal((await get(`/t/CDEV/${RESYNC_TS}`, cookie, { method: "POST" })).status, 405);
  assert.ok(calls.length > 0);
});

test("the pages are closed to someone who isn't in a public channel", async (t) => {
  mockSlack(t, {
    stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }],
    "conversations.info": { channel: { name: "dev" } },
    "conversations.members": { members: ["UREX"] },
  });
  await seeded;
  const cookie = await signIn();
  assert.equal((await get(`/t/CDEV/${RESYNC_TS}`, cookie)).status, 404);
});

test("the pages are closed to someone who isn't in a private channel, and signing out ends the session", async (t) => {
  mockSlack(t, {
    stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }],
    "conversations.info": { channel: { name: "secret", is_private: true } },
    "conversations.members": { members: ["UREX"] },
  });
  await seeded;
  const cookie = await signIn();
  assert.equal((await get(`/t/CDEV/${RESYNC_TS}`, cookie)).status, 404);
  await get("/logout", cookie);
  assert.equal((await get(`/t/CDEV/${RESYNC_TS}`, cookie)).status, 401);
});
