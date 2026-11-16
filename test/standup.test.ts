import assert from "node:assert/strict";
import test from "node:test";
import { putTask } from "../src/db.ts";
import type { AppEnv } from "../src/env.ts";
import type { TestContext } from "node:test";
import {
  RESPONSE_URL,
  type Stored,
  drafts,
  env,
  historyTask,
  interaction,
  mockSlack,
  recordResponses,
  runTasksCommand,
  savedTask,
  send,
  slackUsers,
} from "./app.ts";

// Runs `/cade <text>` from `channel` as UACTOR, with `stored` (each channel's
// task root messages) in the database, and returns its immediate answer, the
// calls made, and the answer sent later through the response_url.
async function tasksCommand(
  t: TestContext,
  text: string,
  channel: string,
  stored: Record<string, Stored[]> = {},
  environment: AppEnv = env,
) {
  const calls = mockSlack(t, { ...slackUsers, "auth.test": { url: "https://acme.slack.com/" } });
  for (const [where, messages] of Object.entries(stored)) {
    for (const record of messages) await putTask(env, where, record.ts, record.task);
  }
  return { calls, ...(await runTasksCommand(text, channel, environment)) };
}

// /cade standup: the group's open tasks, one owner at a time, privately.

// A click on a standup message's button or menu, `action` as Slack sends it.
const standupClick = (action) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    response_url: RESPONSE_URL,
    container: { is_ephemeral: true },
    actions: [action],
  });

// The step's buttons, as [label, action_id].
const buttonsOf = (message) => message.blocks.at(-1).elements.map((button) => [button.text.text, button.action_id]);

// Clicks the button labelled `label` in `message`, and returns the step shown
// in its place.
async function clickButton(t, message, label) {
  const button = message.blocks.at(-1).elements.find((element) => element.text.text === label);
  const sent = recordResponses(t);
  await send("/slack/interactions", standupClick({ action_id: button.action_id, value: button.value }));
  return sent.at(-1);
}

const standupTasks = () => ({
  CDEV: [
    historyTask("100.1", { title: "Bob's low", priority: "Low", owners: ["UBOB"] }),
    historyTask("100.2", { title: "Bob's urgent", priority: "Urgent", owners: ["UBOB"], status: "IN_PROGRESS" }),
    historyTask("100.3", { title: "Alice's", owners: ["UALICE"] }),
    historyTask("100.4", { title: "Mine", owners: ["UACTOR"], status: "IN_REVIEW" }),
    historyTask("100.5", { title: "Nobody's", testers: ["UALICE"] }),
    historyTask("100.6", { title: "Done already", owners: ["UALICE"], status: "DONE" }),
  ],
});

test("/cade standup starts with whoever runs it, then everyone by name, then tasks with no owner", async (t) => {
  const { calls, now, later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  assert.equal(now, "");
  assert.equal(later.response_type, "ephemeral");
  assert.equal(later.blocks[0].text.text, "*Standup: <@UACTOR>*  ·  1 of 4");
  assert.equal(later.blocks[1].elements[0].text, "1 open task  ·  acme");
  const [mine] = later.blocks.filter((block) => block.accessory);
  assert.match(mine.text.text, /\|Mine>  ·  :eyes: In review/);
  assert.equal(mine.accessory.type, "static_select");
  assert.equal(mine.accessory.initial_option.value, "IN_REVIEW");
  assert.deepEqual(buttonsOf(later), [
    ["Next: Alice ▶", "standup:next"],
    ["End", "standup:end"],
  ]);

  const alice = await clickButton(t, later, "Next: Alice ▶");
  assert.equal(alice.replace_original, true);
  assert.equal(alice.blocks[0].text.text, "*Standup: <@UALICE>*  ·  2 of 4");
  // Done tasks are left out.
  assert.equal(alice.blocks[1].elements[0].text, "1 open task  ·  acme");
  assert.deepEqual(buttonsOf(alice), [
    ["◀ Back", "standup:back"],
    ["Next: Bob ▶", "standup:next"],
    ["End", "standup:end"],
  ]);

  const bob = await clickButton(t, alice, "Next: Bob ▶");
  // Most urgent first.
  const titles = bob.blocks.filter((block) => block.accessory).map((block) => block.text.text.match(/\|([^>]+)>/)[1]);
  assert.deepEqual(titles, ["Bob's urgent", "Bob's low"]);
  // Each menu has its own action_id, as Slack requires.
  assert.deepEqual(
    bob.blocks.filter((block) => block.accessory).map((block) => block.accessory.action_id),
    ["standup:status:0", "standup:status:1"],
  );

  const nobody = await clickButton(t, bob, "Next: No owner ▶");
  assert.equal(nobody.blocks[0].text.text, "*Standup: no owner yet*  ·  4 of 4");
  const [unassigned] = nobody.blocks.filter((block) => block.accessory);
  assert.match(unassigned.text.text, /\|Nobody's>/);
  assert.equal(unassigned.accessory.type, "users_select");
  assert.deepEqual(buttonsOf(nobody), [
    ["◀ Back", "standup:back"],
    ["Finish", "standup:end"],
  ]);

  const back = await clickButton(t, nobody, "◀ Back");
  assert.equal(back.blocks[0].text.text, "*Standup: <@UBOB>*  ·  3 of 4");
  // Each step sorts the owners by name, but the names are kept after the
  // first look-up rather than asked of Slack on every click.
  const asked = calls.filter((call) => call.method === "users.info").map((call) => call.args.user);
  assert.deepEqual(asked.sort(), ["UACTOR", "UALICE", "UBOB"]);
});

test("a standup's status menu sets the status and tells the task's thread", async (t) => {
  const { calls, later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  const [mine] = later.blocks.filter((block) => block.accessory);
  calls.length = 0;
  const sent = recordResponses(t);
  await send(
    "/slack/interactions",
    standupClick({
      action_id: mine.accessory.action_id,
      block_id: mine.block_id,
      selected_option: { value: "IN_TESTING" },
    }),
  );
  assert.equal((await savedTask("CDEV", "100.4")).status, "IN_TESTING");
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.4");
  assert.equal(post.text, "<@UACTOR> set the status to :test_tube: In testing.");
  // The same step again, showing the change.
  assert.equal(sent.at(-1).replace_original, true);
  assert.equal(sent.at(-1).blocks[0].text.text, "*Standup: <@UACTOR>*  ·  1 of 4");
  assert.equal(sent.at(-1).blocks.find((block) => block.accessory).accessory.initial_option.value, "IN_TESTING");
});

test("/cade standup -unassigned goes through tasks with no owner, one at a time, to assign them", async (t) => {
  const { calls, later } = await tasksCommand(t, "standup -unassigned", "CDEV", {
    CDEV: [
      historyTask("100.1", { title: "Low", priority: "Low" }),
      historyTask("100.2", { title: "Urgent", priority: "Urgent", link: "https://acme.slack.com/archives/CDEV/p1002" }),
      historyTask("100.3", { title: "Taken", owners: ["UBOB"] }),
    ],
  });
  assert.equal(later.blocks[0].text.text, "*Unassigned acme tasks*  ·  1 of 2");
  const first = later.blocks.find((block) => block.accessory);
  assert.match(first.text.text, /\|Urgent>/);
  assert.deepEqual(buttonsOf(later), [
    ["Skip ▶", "standup:next"],
    ["End", "standup:end"],
  ]);

  calls.length = 0;
  const sent = recordResponses(t);
  await send(
    "/slack/interactions",
    standupClick({ action_id: first.accessory.action_id, block_id: first.block_id, selected_user: "UALICE" }),
  );
  assert.deepEqual((await savedTask("CDEV", "100.2")).people.owner, ["UALICE"]);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.2");
  assert.equal(post.text, "<@UACTOR> assigned @Alice as owner.");
  // Asking them is offered where the walk is, in the channel, linking the task's thread.
  assert.deepEqual(drafts(calls), ["<@UALICE>, could you pick this up?"]);
  const offer = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.deepEqual([offer.channel, offer.thread_ts, offer.user], ["CDEV", undefined, "UACTOR"]);
  assert.match(
    offer.blocks[0].text.text,
    /^Send this in <https:\/\/acme\.slack\.com\/archives\/CDEV\/p1002\|the task's thread>\?/,
  );
  // Assigned, it leaves the walk: the next one takes its place.
  const next = sent.at(-1);
  assert.equal(next.blocks[0].text.text, "*Unassigned acme tasks*  ·  1 of 1");
  assert.match(next.blocks.find((block) => block.accessory).text.text, /\|Low>/);
  assert.deepEqual(buttonsOf(next), [["Finish", "standup:end"]]);

  const last = next.blocks.find((block) => block.accessory);
  await send(
    "/slack/interactions",
    standupClick({ action_id: last.accessory.action_id, block_id: last.block_id, selected_user: "UBOB" }),
  );
  assert.equal(sent.at(-1).text, "Every open acme task has an owner. Nice!");
});

test("End and Finish remove the standup", async (t) => {
  const { later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  const sent = recordResponses(t);
  await send("/slack/interactions", standupClick({ action_id: "standup:end", value: "end" }));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
  assert.ok(later);
});

test("/cade standup says so when there's nothing to go through, and takes only -unassigned", async (t) => {
  const empty = await tasksCommand(t, "standup", "CDEV", {});
  assert.equal(empty.later.text, "No one has open acme tasks right now.");

  const wrong = await tasksCommand(t, "standup everyone", "CDEV", {});
  assert.equal(
    JSON.parse(wrong.now).text,
    "I don't know \"everyone\" as an option. Send `/cade standup` to go through everyone's tasks, or `/cade standup -unassigned` for those with no owner.",
  );
  // It's the team's, so it runs in its channels.
  const outside = await tasksCommand(t, "standup", "COTHER", {});
  assert.equal(JSON.parse(outside.now).text, "That one works with `/cade standup` in <#CDEV> or <#CTESTDEV>.");
});

test("a standup step with more tasks than fit says how many more", async (t) => {
  const many = Array.from({ length: 23 }, (_, i) =>
    historyTask(`100.${i + 10}`, { title: `Task ${i}`, owners: ["UALICE"] }),
  );
  const { later } = await tasksCommand(t, "standup", "CDEV", { CDEV: many });
  assert.equal(later.blocks.at(-2).elements[0].text, "_…and 3 more, after these._");
});
