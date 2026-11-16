import assert from "node:assert/strict";
import test from "node:test";
import { fromRichText as fromRichTextOf, toRichText as toRichTextOf } from "../src/commands/ask.ts";
import {
  MR,
  PR,
  clientReview,
  interaction,
  mockSlack,
  ownTask,
  savedTask,
  send,
  storedTask,
  withStatus,
} from "./app.ts";

test("the Ask for approval form starts with the task's PRs in its message, which can be taken out like the rest", async (t) => {
  const task = withStatus("IN_TESTING");
  task.task.prs = [PR];
  let calls = await clientReview(t, { stored: [task] }, { approver: "UCLIENT" });
  const form = calls.find((call) => call.method === "views.open").args.view;
  // The PRs are a link in the box, and come back as one.
  assert.equal(
    fromRichTextOf(form.blocks[1].element.initial_value),
    `Could you take a look and approve it, or let us know what needs to change?\n*PRs:* <${PR}|cade/42>`,
  );
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    `<@UACTOR> sent:\n<@UCLIENT>, could you take a look and approve it, or let us know what needs to change?\n*PRs:* <${PR}|cade/42>`,
  );
  // Taken out, they aren't posted.
  calls = await clientReview(
    t,
    { stored: [task] },
    {
      approver: "UCLIENT",
      message: [
        {
          type: "rich_text_section",
          elements: [
            { type: "user", user_id: "UCLIENT" },
            { type: "text", text: ", please approve." },
          ],
        },
      ],
    },
  );
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UACTOR> sent:\n<@UCLIENT>, please approve.",
  );
});

test("the Ask for approval form shows the request, to change before it's sent, following who is chosen until it's changed", async (t) => {
  const calls = await clientReview(
    t,
    { stored: [storedTask()] },
    {
      approver: "UCLIENT",
      message: [
        {
          type: "rich_text_section",
          elements: [{ type: "text", text: "Hi, the new login is on staging. Could you approve it by Friday?" }],
        },
      ],
    },
  );
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.deepEqual(
    form.blocks.map((block) => block.block_id),
    ["approver", "message", undefined],
  );
  assert.equal(form.blocks[0].element.action_id, "status:approver");
  assert.equal(form.blocks[0].dispatch_action, true);
  assert.equal(
    fromRichTextOf(form.blocks[1].element.initial_value),
    "Could you take a look and approve it, or let us know what needs to change?",
  );
  // Their words are posted, the approver mentioned first, as they don't name them.
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(
    post.text,
    "<@UACTOR> sent:\n<@UCLIENT> Hi, the new login is on staging. Could you approve it by Friday?",
  );
  assert.equal(JSON.parse(post.blocks[1].elements[0].value).approver, "UCLIENT");

  // Choosing someone puts them in the request; once it's changed, it's left alone.
  const pick = (text, block = "message") =>
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      view: {
        id: "V1",
        hash: "h1",
        callback_id: "status:review",
        private_metadata: form.private_metadata,
        state: {
          values: {
            approver: { "status:approver": { selected_user: "UCLEO" } },
            [block]: { value: { rich_text_value: toRichTextOf(text) } },
          },
        },
      },
      actions: [{ action_id: "status:approver", block_id: "approver", selected_user: "UCLEO" }],
    });
  let picked = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  await send(
    "/slack/interactions",
    pick("<@UCLIENT>, could you take a look and approve it, or let us know what needs to change?"),
  );
  const update = picked.find((call) => call.method === "views.update").args;
  assert.deepEqual([update.view_id, update.hash], ["V1", "h1"]);
  assert.equal(update.view.blocks[0].element.initial_user, "UCLEO");
  // A new block_id, or Slack would keep what the box held.
  assert.equal(update.view.blocks[1].block_id, "message-UCLEO");
  assert.equal(
    fromRichTextOf(update.view.blocks[1].element.initial_value),
    "<@UCLEO>, could you take a look and approve it, or let us know what needs to change?",
  );
  picked = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  await send("/slack/interactions", pick("Please approve by Friday", "message-UCLIENT"));
  assert.deepEqual(picked, []);
});

const reviewClick = (actionId) =>
  interaction({
    type: "block_actions",
    user: { id: "UCLIENT" },
    channel: { id: "CDEV" },
    message: { ts: "100.9", thread_ts: "100.1" },
    actions: [
      {
        action_id: actionId,
        value: JSON.stringify({
          channel: "CDEV",
          ts: "100.1",
          text: "<@UACTOR> says this is ready for you to review.",
        }),
      },
    ],
  });

test("an approval request sent through an AI agent keeps its footer once decided", async (t) => {
  const footer = {
    type: "context",
    block_id: "cade_agent_footer",
    elements: [{ type: "mrkdwn", text: "*Sent using* AI agent" }],
  };
  const click = JSON.parse(new URLSearchParams(reviewClick("status:approve")).get("payload")!);
  click.message.blocks = [{ type: "section" }, { type: "actions" }, footer];
  const calls = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  await send("/slack/interactions", interaction(click));
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.9").args;
  assert.equal(
    update.text,
    "<@UACTOR> says this is ready for you to review.\n<@UCLIENT> approved it.\nSent using AI agent",
  );
  assert.deepEqual(update.blocks.at(-1), footer);
  assert.ok(!update.blocks.some((block) => block.type === "actions"), "the buttons are gone");
});

test("Approve moves the task to Done and tells the task's thread", async (t) => {
  const calls = mockSlack(t, {
    stored: [withStatus("CLIENT_REVIEW")],
    "chat.getPermalink": { permalink: "https://slack.example/review" },
    "users.info": { user: { real_name: "Cleo" } },
  });
  const response = await send("/slack/interactions", reviewClick("status:approve"));
  assert.equal(response.status, 200);

  const slack = calls.filter((call) => call.method !== "users.info");
  assert.deepEqual(
    slack.map((call) => [call.method, call.args.ts ?? call.args.thread_ts ?? call.args.timestamp]),
    [
      ["chat.update", "100.1"],
      ["chat.postMessage", "100.1"],
      ["chat.update", "100.9"],
    ],
  );
  assert.deepEqual((await savedTask()).status, "DONE");
  assert.ok((await savedTask()).completedAt);
  // The thread hears who approved it by name, notifying no one.
  assert.equal(slack[1].args.text, "@Cleo approved this, so it's now :white_check_mark: Done.");
  assert.deepEqual(slack[2].args, {
    channel: "CDEV",
    ts: "100.9",
    text: "<@UACTOR> says this is ready for you to review.\n<@UCLIENT> approved it.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "<@UACTOR> says this is ready for you to review.\n<@UCLIENT> approved it.",
        },
      },
    ],
  });
});

test("Not approve moves the task back to In progress and tells the task's thread", async (t) => {
  const calls = mockSlack(t, {
    stored: [withStatus("CLIENT_REVIEW")],
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  await send("/slack/interactions", reviewClick("status:reject"));

  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  const note = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(note.thread_ts, "100.1");
  assert.equal(
    note.text,
    "<@UCLIENT> didn't approve this, so it's back to :arrow_forward: In progress. Have a look at the thread for what needs to change.",
  );
  assert.match(calls.at(-1).args.text, /\n<@UCLIENT> didn't approve it, so the team will pick it up again\.$/);
});

test("Approve and Not approve do nothing once the task has left Client review", async (t) => {
  for (const actionId of ["status:approve", "status:reject"]) {
    const calls = mockSlack(t, { stored: [withStatus("IN_TESTING")] });
    await send("/slack/interactions", reviewClick(actionId));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["chat.update"],
      actionId,
    );
    assert.match(
      calls[0].args.text,
      /\nI didn't change anything: the task has since moved to :test_tube: In testing\.$/,
    );
  }
});

test("Approve on a deleted task says so", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/interactions", reviewClick("status:approve"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update"],
  );
  assert.match(calls[0].args.text, /\nHmm, this task doesn't exist anymore\.$/);
});

test("only the chosen approver can approve or reject", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  const click = JSON.parse(new URLSearchParams(reviewClick("status:approve")).get("payload"));
  click.actions[0].value = JSON.stringify({ ...JSON.parse(click.actions[0].value), approver: "UPM" });
  await send("/slack/interactions", interaction(click));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postEphemeral"],
  );
  assert.equal(calls[0].args.user, "UCLIENT");
  assert.equal(calls[0].args.text, "Only <@UPM> can approve or reject this.");
  assert.equal((await savedTask()).status, "CLIENT_REVIEW");
});

test("Client review lists the task's PRs for the client, and keeps them after a decision", async (t) => {
  const task = withStatus("IN_TESTING");
  task.task.prs = [PR, MR];
  const calls = await clientReview(t, {
    stored: [task],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });

  const review = calls.find(
    (call) => call.method === "chat.postMessage" && call.args.text?.startsWith("<@UACTOR> sent:"),
  ).args;
  // Led by who sent it, as any message sent for someone is.
  const announced = [
    "<@UACTOR> sent:",
    "<@UCREATOR>, could you take a look and approve it, or let us know what needs to change?",
    `*PRs:* <${PR}|cade/42>, <${MR}|web-app/118>`,
  ].join("\n");
  assert.equal(review.blocks[0].text.text, announced);
  assert.deepEqual(
    review.blocks[1].elements.map((button) => button.action_id),
    ["status:approve", "status:reject"],
  );
  // The buttons carry the request and the PRs, so they stay when the buttons are replaced.
  assert.equal(JSON.parse(review.blocks[1].elements[0].value).text, announced);
});

test("Client review on a task with no PRs shows no PRs line", async (t) => {
  const calls = await clientReview(t, {
    stored: [withStatus("IN_TESTING")],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  const review = calls.find(
    (call) => call.method === "chat.postMessage" && call.args.text?.startsWith("<@UACTOR> sent:"),
  ).args;
  assert.ok(!review.blocks[0].text.text.includes("*PRs:*"));
});

test("Client review asks the approver in the task's own thread", async (t) => {
  const record = ownTask({ owners: ["UDEV"] });
  record.task.status = "IN_TESTING";
  record.task.prs = [PR];
  let calls = await clientReview(t, { stored: [record] }, { approver: "UPM" });
  assert.equal((await savedTask()).status, "CLIENT_REVIEW");
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.blocks[0].element.initial_user, undefined);
  assert.equal(
    form.blocks[2].elements[0].text,
    "Posted in the task's thread with Approve and Not approve, which only they can click.",
  );
  // The request is posted in the task's thread.
  const ask = calls.at(-1).args;
  assert.equal(calls.at(-1).method, "chat.postMessage");
  assert.equal(ask.channel, "CDEV");
  assert.equal(ask.thread_ts, "100.1");
  assert.equal(
    ask.blocks[0].text.text,
    `<@UACTOR> sent:\n<@UPM>, could you take a look and approve it, or let us know what needs to change?\n*PRs:* <${PR}|cade/42>`,
  );
  const [approve] = ask.blocks[1].elements;

  for (const [action, status, said] of [
    ["status:approve", "DONE", "<@UPM> approved this, so it's now :white_check_mark: Done."],
    [
      "status:reject",
      "IN_PROGRESS",
      "<@UPM> didn't approve this, so it's back to :arrow_forward: In progress. Have a look at the thread for what needs to change.",
    ],
  ] as const) {
    calls = mockSlack(t, { stored: [{ ...record, task: { ...record.task, status: "CLIENT_REVIEW" } }] });
    await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: "UPM" },
        channel: { id: "CDEV" },
        message: { ts: "100.8", thread_ts: "100.1" },
        actions: [{ action_id: action, value: approve.value }],
      }),
    );
    assert.equal((await savedTask()).status, status);
    const told = calls.find((call) => call.method === "chat.postMessage").args;
    assert.equal(told.thread_ts, "100.1");
    assert.equal(told.text, said);
    assert.equal(calls.at(-1).args.ts, "100.8");
    assert.ok(!calls.some((call) => call.method === "chat.getPermalink"));
  }
});
