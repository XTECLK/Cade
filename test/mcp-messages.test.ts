import assert from "node:assert/strict";
import test from "node:test";
import { putTask } from "../src/db.ts";
import { WORKSPACE, addressIn, env, mock, slash, stored, tool } from "./mcp-app.ts";

test("send_thread_message posts in a task's thread as Cade, marked as sent by the person", async (t) => {
  await putTask(
    env,
    "CDEV",
    "1700000000.000100",
    stored({ link: "https://acme.slack.com/archives/CDEV/p1700000000000100" }),
  );
  await putTask(env, "CPRIV", "1700000000.000100", stored({ title: "Secret" }));
  const calls = mock(t, {
    "conversations.info": (args) => ({
      channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" },
    }),
    "users.info": WORKSPACE,
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const TASK = "CDEV:1700000000.000100";

  const sent = await tool(url, "send_thread_message", {
    thread_id: TASK,
    text: "  Hi <@UANN> & <!channel>, see <https://evil.example|this>.  ",
  });
  assert.equal(sent.isError, false, sent.text);
  assert.match(sent.text, /^Posted in the task's thread: https:\/\/acme\.slack\.com\/archives\/CDEV/);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.channel, "CDEV");
  assert.equal(post.thread_ts, "1700000000.000100");
  const blocks = JSON.parse(post.blocks);
  // Only a person's mention is kept; @channel and links are shown as typed.
  assert.equal(
    blocks[0].text.text,
    "<@UME> sent:\nHi <@UANN> &amp; &lt;!channel&gt;, see &lt;https://evil.example|this&gt;.",
  );
  // The footer is small grey text, as Slack's own connector marks what it posts for someone.
  assert.deepEqual(blocks[1], {
    type: "context",
    block_id: "cade_agent_footer",
    elements: [{ type: "mrkdwn", text: "*Sent using* AI agent" }],
  });
  assert.match(post.text, /\nSent using AI agent$/);
  assert.match(post.text, /^<@UME> sent:\n/);

  const before = calls.length;
  assert.match((await tool(url, "send_thread_message", { thread_id: TASK, text: "  " })).text, /message is empty/);
  const posts = () => calls.filter((call) => call.method === "chat.postMessage").length;
  const postedBefore = posts();
  assert.match(
    (await tool(url, "send_thread_message", { thread_id: TASK, text: "Hi <@UGHOST>" })).text,
    /UGHOST isn't an active person/,
  );
  assert.match(
    (await tool(url, "send_thread_message", { thread_id: TASK, text: "Hi <@UBOT> and <@UANN>" })).text,
    /UBOT isn't an active person/,
  );
  assert.equal(posts(), postedBefore, "nothing was posted for a mention of someone who isn't there");
  // A credential in a message stays in the thread for everyone, so it is refused.
  for (const secret of [
    "key AKIAABCDEFGHIJKLMNOP",
    "token ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123",
    "password: hunter2hunter2",
    "-----BEGIN RSA PRIVATE KEY-----",
  ]) {
    assert.match(
      (await tool(url, "send_thread_message", { thread_id: TASK, text: secret })).text,
      /The message looks like it contains a/,
      secret,
    );
  }
  assert.equal(posts(), postedBefore, "nothing was posted for a message with a secret");
  assert.match(
    (await tool(url, "send_thread_message", { thread_id: TASK, text: "x".repeat(3001) })).text,
    /3001 characters/,
  );
  assert.match(
    (await tool(url, "send_thread_message", { thread_id: "CPRIV:1700000000.000100", text: "hi" })).text,
    /aren't in that task's project channel/,
  );
  assert.match((await tool(url, "send_thread_message", { text: "hi" })).text, /Give thread_id or link\./);
  assert.equal(calls.slice(before).filter((call) => call.method === "chat.postMessage").length, 0);
});

test("send_thread_message posts in any thread the person can read, in the same form", async (t) => {
  await putTask(
    env,
    "CDEV",
    "1700000000.000100",
    stored({ link: "https://acme.slack.com/archives/CDEV/p1700000000000100" }),
  );
  let joined = false;
  const calls = mock(t, {
    "conversations.info": (args) => ({
      channel:
        args.channel === "CPRIV"
          ? { name: "secret", is_private: true }
          : args.channel === "D1"
            ? { is_im: true }
            : { name: "general" },
    }),
    "conversations.join": () => ((joined = true), {}),
    "auth.test": { url: "https://acme.slack.com/" },
    "conversations.replies": (args) =>
      args.ts === "1600000000.000100"
        ? new Error("thread_not_found")
        : joined
          ? { messages: [{ user: "UBOB", ts: args.ts, text: "hi" }] }
          : new Error("not_in_channel"),
    "users.info": WORKSPACE,
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const posts = () => calls.filter((call) => call.method === "chat.postMessage");

  // A reply's link stands for its thread, and Cade joins a public channel it isn't in.
  const link = "https://acme.slack.com/archives/CGEN/p1700000060000200?thread_ts=1700000000.000300&cid=CGEN";
  const sent = await tool(url, "send_thread_message", { link, text: "Hi <@UANN>" });
  assert.equal(sent.isError, false, sent.text);
  assert.equal(sent.text, `Posted in the thread: ${link}`);
  assert.deepEqual(sent.data, { task_id: "", thread_id: "CGEN:1700000000.000300", sent: true, link });
  assert.ok(joined);
  const post = posts().at(-1).args;
  assert.equal(post.channel, "CGEN");
  assert.equal(post.thread_ts, "1700000000.000300");
  const blocks = JSON.parse(post.blocks);
  assert.equal(blocks[0].text.text, "<@UME> sent:\nHi <@UANN>");
  assert.equal(blocks[1].elements[0].text, "*Sent using* AI agent");

  // A link to a task's thread is that task.
  const task = await tool(url, "send_thread_message", {
    link: "https://acme.slack.com/archives/CDEV/p1700000000000100",
    text: "hi",
  });
  assert.match(task.text, /^Posted in the task's thread/);
  assert.equal(task.data.task_id, "CDEV:1700000000.000100");

  const before = posts().length;
  assert.match(
    (
      await tool(url, "send_thread_message", {
        link: "https://acme.slack.com/archives/CPRIV/p1700000000000100",
        text: "hi",
      })
    ).text,
    /aren't in that channel/,
  );
  assert.match(
    (
      await tool(url, "send_thread_message", {
        link: "https://acme.slack.com/archives/D1/p1700000000000100",
        text: "hi",
      })
    ).text,
    /direct messages/,
  );
  assert.match(
    (
      await tool(url, "send_thread_message", {
        link: "https://acme.slack.com/archives/CGEN/p1600000000000100",
        text: "hi",
      })
    ).text,
    /couldn't find that thread/,
  );
  assert.match(
    (await tool(url, "send_thread_message", { link: "https://example.com", text: "hi" })).text,
    /isn't a link to a Slack message/,
  );
  // summary_id went with executive summaries.
  assert.match((await tool(url, "send_thread_message", { link, text: "hi", summary_id: 1 })).text, /summary_id/);
  assert.match(
    (await tool(url, "send_thread_message", { link, thread_id: "CDEV:1700000000.000100", text: "hi" })).text,
    /not both/,
  );
  assert.equal(posts().length, before, "nothing was posted for a thread the person can't post in");
  // A thread_id is any thread's, as a link is, and the person is still given a link.
  const byId = await tool(url, "send_thread_message", { thread_id: "CGEN:1700000000.000300", text: "hi" });
  assert.equal(byId.data.thread_id, "CGEN:1700000000.000300");
  assert.equal(
    byId.text,
    "Posted in the thread: https://acme.slack.com/archives/CGEN/p1700000000000300?thread_ts=1700000000.000300&cid=CGEN",
  );
});

test("the usual approval request is the same however it's sent: as Slack's form starts it, update_task's suggested_message sent as it is, or no message", async (t) => {
  const TS = "1700000000.000100";
  const PR = "https://github.com/acme/cade/pull/42";
  await putTask(env, "CDEV", TS, stored({ status: "IN_TESTING", prs: [PR] }));
  const calls = mock(t, { "conversations.info": { channel: { name: "dev" } }, "users.info": WORKSPACE });
  const url = addressIn(await slash("mcp init", "UME"));
  const usual = `<@UBOB>, could you take a look and approve it, or let us know what needs to change?\n*PRs:* <${PR}|cade/42>`;

  const moved = await tool(url, "update_task", { task_id: `CDEV:${TS}`, status: "CLIENT_REVIEW" });
  assert.equal(
    moved.data.suggested_message,
    `Could you take a look and approve it, or let us know what needs to change?\n*PRs:* <${PR}|cade/42>`,
  );
  await tool(url, "send_approval_request", {
    task_id: `CDEV:${TS}`,
    approver: "UBOB",
    message: moved.data.suggested_message,
  });
  await tool(url, "send_approval_request", { task_id: `CDEV:${TS}`, approver: "UBOB" });
  const posted = calls
    .filter((call) => call.method === "chat.postMessage" && call.args.text.startsWith("<@UME> sent:"))
    .map((call) => call.args.text);
  assert.deepEqual(posted, [
    `<@UME> sent:\n${usual}\nSent using AI agent`,
    `<@UME> sent:\n${usual}\nSent using AI agent`,
  ]);

  // Changed, its pull request links stay links, and the rest is plain text.
  await tool(url, "send_approval_request", {
    task_id: `CDEV:${TS}`,
    approver: "UBOB",
    message: `<@UBOB>, ready on staging <b>now</b>.\n*PRs:* <${PR}|cade/42>`,
  });
  assert.equal(
    calls.filter((call) => call.method === "chat.postMessage").at(-1).args.text,
    `<@UME> sent:\n<@UBOB>, ready on staging &lt;b&gt;now&lt;/b&gt;.\n*PRs:* <${PR}|cade/42>\nSent using AI agent`,
  );
});

test("send_approval_request asks the chosen person to approve a task in Client review, with buttons only they can click", async (t) => {
  const TS = "1700000000.000100";
  await putTask(
    env,
    "CDEV",
    TS,
    stored({
      status: "CLIENT_REVIEW",
      link: "https://acme.slack.com/archives/CDEV/p1700000000000100",
      prs: ["https://github.com/acme/cade/pull/42"],
    }),
  );
  await putTask(env, "CDEV", "1700000001.000100", stored({ status: "IN_PROGRESS" }));
  await putTask(env, "CPRIV", TS, stored({ status: "CLIENT_REVIEW" }));
  const calls = mock(t, {
    "conversations.info": (args) => ({
      channel: args.channel === "CPRIV" ? { name: "secret", is_private: true } : { name: "dev" },
    }),
    "users.info": (args) => (args.user === "UCLIENT123" ? { user: { real_name: "Cleo Client" } } : WORKSPACE(args)),
  });
  const url = addressIn(await slash("mcp init", "UME"));
  const TASK = `CDEV:${TS}`;

  const asked = await tool(url, "send_approval_request", { task_id: TASK, approver: "UCLIENT123" });
  assert.equal(asked.isError, false, asked.text);
  assert.deepEqual(
    [asked.data.task_id, asked.data.approver, asked.data.user_names],
    [TASK, "UCLIENT123", { UCLIENT123: "Cleo Client" }],
  );
  assert.match(
    asked.text,
    /^Asked @Cleo Client \(UCLIENT123\) to approve it, in the task's thread\. Approving moves the task to Done; not approving sends it back to In progress\. https:\/\/acme\.slack\.com/,
  );

  // The request is in the task's thread, mentions the approver, lists the PRs, and its buttons name who may click them.
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, TS);
  assert.match(post.text, /^<@UME> sent:\n[\s\S]*\nSent using AI agent$/);
  assert.equal(JSON.parse(post.blocks).at(-1).block_id, "cade_agent_footer");
  assert.match(post.text, /cade\/42/);
  assert.match(post.text, /<@UCLIENT123>, could you take a look and approve it/);
  const buttons = JSON.parse(post.blocks).find((block) => block.type === "actions").elements;
  assert.deepEqual(
    buttons.map((button) => button.action_id),
    ["status:approve", "status:reject"],
  );
  assert.equal(JSON.parse(buttons[0].value).approver, "UCLIENT123");
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));

  // Only for a task in Client review, an approver who is a person, and a channel you can read.
  assert.match(
    (await tool(url, "send_approval_request", { task_id: "CDEV:1700000001.000100", approver: "UCLIENT123" })).text,
    /In progress, so there's nothing to approve\. Move it to Client review with update_task first/,
  );
  assert.match(
    (await tool(url, "send_approval_request", { task_id: TASK, approver: "UGHOST" })).text,
    /UGHOST isn't an active person in the workspace/,
  );
  assert.match(
    (await tool(url, "send_approval_request", { task_id: TASK, approver: "rex" })).text,
    /isn't a Slack user ID/,
  );
  assert.match(
    (await tool(url, "send_approval_request", { task_id: "CPRIV:1700000000.000100", approver: "UCLIENT123" })).text,
    /aren't in that task's project channel/,
  );
  assert.match(
    (await tool(url, "send_approval_request", { task_id: "CDEV:999.9", approver: "UCLIENT123" })).text,
    /isn't a task Cade tracks/,
  );
  assert.match(
    (await tool(url, "send_approval_request", { task_id: TASK, approver: "UCLIENT123", message: "  " })).text,
    /The message is empty/,
  );
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 1, "only the first call posted");

  // In the person's words, all of it, the PRs too: the approver is mentioned first when the message
  // doesn't, and <!here> is only text.
  const worded = await tool(url, "send_approval_request", {
    task_id: TASK,
    approver: "UCLIENT123",
    message: "Staging has it <!here>. Could you approve by Friday?",
  });
  assert.equal(worded.isError, false, worded.text);
  const request = calls.filter((call) => call.method === "chat.postMessage").at(-1).args.text;
  assert.match(
    request,
    /^<@UME> sent:\n<@UCLIENT123> Staging has it &lt;!here&gt;\. Could you approve by Friday\?\nSent using AI agent$/,
  );
  await tool(url, "send_approval_request", {
    task_id: TASK,
    approver: "UCLIENT123",
    message: "Hi <@UCLIENT123>, please approve.",
  });
  assert.match(
    calls.filter((call) => call.method === "chat.postMessage").at(-1).args.text,
    /^<@UME> sent:\nHi <@UCLIENT123>, please approve\.\nSent using AI agent$/,
  );

  // A long request is posted whole; its buttons, which hold 2000 characters, keep it cut short.
  const long = `Please check "the flow" & approve.\n${"word ".repeat(560).trim()}`;
  await tool(url, "send_approval_request", { task_id: TASK, approver: "UCLIENT123", message: long });
  const last = calls.filter((call) => call.method === "chat.postMessage").at(-1).args;
  assert.ok(last.text.includes(long.slice(-50)), "posted whole");
  const value = JSON.parse(last.blocks).find((block) => block.type === "actions").elements[0].value;
  assert.ok(value.length <= 2000, `${value.length} characters`);
  assert.match(
    JSON.parse(value).text,
    /^<@UME> sent:\n<@UCLIENT123> Please check "the flow" &amp; approve\.\nword[\s\S]*…$/,
  );
});
