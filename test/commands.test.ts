import assert from "node:assert/strict";
import test from "node:test";
import { parseDate } from "../src/commands/details.ts";
import { parseMessage } from "../src/commands/parse.ts";
import { formatDueDate } from "../src/tasks.ts";
import {
  PR,
  allBlocks,
  assignValue,
  blockText,
  clickAssign,
  drafts,
  footerLines,
  mockSlack,
  ownTask,
  recordResponses,
  savedTask,
  send,
  slackUsers,
  slash,
  storedTask,
  threadEvent,
  threadReply,
  withStatus,
} from "./app.ts";

// `record`, moved to `channel`.
const inChannel = (channel, record) => ({ ...record, channel });

test("@Cade assign adds people to a role on the root message", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE"], testers: ["UTESS"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB> <@UALICE|alice>"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add", "chat.postEphemeral"],
  );
  const update = calls[0].args;
  assert.equal(update.ts, "100.1");
  assert.equal(footerLines(update)[0], "Owner <@UALICE>, <@UBOB>  ·  Test <@UTESS>");
  const task = await savedTask();
  assert.deepEqual(task.people, { owner: ["UALICE", "UBOB"], reviewer: [], tester: ["UTESS"] });
  assert.equal(task.dueDate, "31/10/2026");
  // The card shows who is on it, so the command gets a ✅, and whoever sent it is offered to ask them,
  // privately, in the thread: nothing is posted.
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.equal(calls[2].args.channel, "CDEV");
  assert.equal(calls[2].args.thread_ts, "100.1");
  assert.equal(calls[2].args.user, "UACTOR");
  // @alice was an owner already, so isn't asked again.
  assert.deepEqual(drafts(calls), ["<@UBOB>, could you pick this up?"]);
});

test("@Cade assign works for each role, in any word order", async (t) => {
  for (const [text, role, reply] of [
    // No PR yet, so there's nothing to ask the reviewer.
    ["<@UBOT> assign reviewer <@UBOB>", "reviewer", undefined],
    // Not In testing yet, so nothing to ask the tester either.
    ["<@UBOT> assign tester <@UBOB>", "tester", undefined],
    ["<@UBOT> assign <@UBOB> as Tester", "tester", undefined],
    ["<@UBOT> assign owners <@UBOB>", "owner", "<@UBOB>, could you pick this up?"],
  ] as const) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual((await savedTask()).people[role], ["UBOB"], text);
    assert.equal(calls[1].args.name, "white_check_mark", text);
    assert.equal(drafts(calls)[0], reply, text);
  }
});

test("@Cade assign takes short words for each role", async (t) => {
  for (const [text, role] of [
    ["<@UBOT> assign owner <@UBOB>", "owner"],
    ["<@UBOT> assign devs <@UBOB>", "owner"],
    ["<@UBOT> assign review <@UBOB>", "reviewer"],
    ["<@UBOT> assign test <@UBOB>", "tester"],
    ["<@UBOT> assign qa <@UBOB>", "tester"],
  ] as const) {
    mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual((await savedTask()).people[role], ["UBOB"], text);
  }
});

test("@Cade unassign with a role removes people from that role only", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE", "UBOB"], reviewers: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign owner <@UALICE>"));
  const { people } = await savedTask();
  assert.deepEqual(people.owner, ["UBOB"]);
  assert.deepEqual(people.reviewer, ["UALICE"]);
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(drafts(calls), ["<@UALICE>, there's no need to work on this anymore."]);
});

test("@Cade unassign without a role removes people from every role", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE", "UBOB"], reviewers: ["UALICE"], testers: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign <@UALICE>"));
  assert.deepEqual((await savedTask()).people, { owner: ["UBOB"], reviewer: [], tester: [] });
  assert.equal(footerLines(calls[0].args)[0], "Owner <@UBOB>");
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(drafts(calls), ["<@UALICE>, there's no need to work on this anymore."]);
});

test("@Cade status updates the task's status", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add"],
  );
  const update = calls[0].args;
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.deepEqual((await savedTask()).people.owner, ["UALICE"]);
  assert.match(blockText(allBlocks(update)[1]), /^:arrow_forward: In progress  ·/);
  // A typed status gets a ✅ on the command, not a reply.
  assert.deepEqual(calls[1].args, { channel: "CDEV", timestamp: "100.5", name: "white_check_mark" });
});

test("@Cade status accepts every status name", async (t) => {
  for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "IN_TESTING", "CLIENT_REVIEW", "DONE"]) {
    mockSlack(t, {
      stored: [storedTask()],
    });
    await send("/slack/events", threadEvent(`<@UBOT> status ${status.toLowerCase()}`));
    assert.deepEqual((await savedTask()).status, status);
  }
});

test("@Cade assign in a thread that is not a task says so", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage"],
  );
  assert.equal(calls[0].args.text, "Hmm, I'm not tracking a task in this thread.");
});

test("commands outside the dev channels point to them", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "COTHER" }));
  assert.equal(
    calls[0].args.text,
    "That one works with `@Cade assign owner @person` in a task thread in <#CDEV> or <#CTESTDEV>.",
  );

  calls = mockSlack(t);
  const reply = await (
    await send("/slack/commands", slash("standup", "COTHER"))
  ).json<{ response_type: string; text: string }>();
  assert.equal(calls.length, 0);
  assert.equal(reply.response_type, "ephemeral");
  assert.match(reply.text, /^That one works with `\/cade standup` in <#CDEV> or <#CTESTDEV>\.$/);
});

test("thread commands work in the test tasks channel", async (t) => {
  const calls = mockSlack(t, {
    stored: [inChannel("CTESTDEV", storedTask())],
  });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "CTESTDEV" }));
  assert.equal(calls[0].args.channel, "CTESTDEV");
  assert.equal(calls[1].args.channel, "CTESTDEV");
  assert.deepEqual((await savedTask("CTESTDEV")).people.owner, ["UBOB"]);
});

test("a bare @Cade, @Cade help and unknown commands point to /cade help", async (t) => {
  for (const text of ["<@UBOT> help", "<@UBOT>", "<@UBOT> hello"]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    assert.equal(calls[0].args.text, "Send `/cade help` to see what I can do.");
  }
});

test("ignores messages that do not start with @Cade, bots, edits and retries", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("looks good, assign it later"));
  await send("/slack/events", threadEvent("cade is great"));
  await send("/slack/events", threadEvent("cade assign <@UBOB>"));
  await send("/slack/events", threadEvent("/cade assign <@UBOB>"));
  await send("/slack/events", threadEvent("hi <@UBOT> assign <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { bot_id: "B1" }));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { subtype: "message_changed" }));
  await send("/slack/events", threadEvent("<@UOTHER> assign <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"), {
    "x-slack-retry-num": "1",
  });
  assert.equal(calls.length, 0);
});

test("parseMessage reads the command name and mentioned people", () => {
  const command = parseMessage(
    {
      type: "message",
      text: "<@UBOT> Assign <@UBOB> <@UALICE|alice> <@UBOB> <@UBOT>",
      user: "UACTOR",
      channel: "CDEV",
      ts: "100.5",
      thread_ts: "100.1",
    },
    "UBOT",
  );
  assert.deepEqual(command, {
    name: "assign",
    text: "<@UBOB> <@UALICE|alice> <@UBOB> <@UBOT>",
    mentions: ["UBOB", "UALICE"],
    user: "UACTOR",
    channel: "CDEV",
    ts: "100.5",
    threadTs: "100.1",
  });
  assert.equal(parseMessage({ type: "message", text: "<@UBOT> TRACK" }, "UBOT").name, "track");
  assert.equal(parseMessage({ type: "message", text: "<@UBOT>" }, "UBOT").name, "");
  assert.equal(parseMessage({ type: "message", text: "@Cade task" }, "UBOT"), null);
  assert.equal(parseMessage({ type: "message", text: "<@UOTHER> track" }, "UBOT"), null);
});
test("setting Done again keeps the original completion time", async (t) => {
  const done = withStatus("DONE");
  done.task.completedAt = "2026-10-20T04:30:00.000Z";
  mockSlack(t, { ...slackUsers, stored: [done] });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.equal((await savedTask()).completedAt, "2026-10-20T04:30:00.000Z");
});
test("formatDueDate shows the picked date as DD/MM/YYYY", () => {
  assert.equal(formatDueDate("2026-10-31"), "31/10/2026");
  assert.equal(formatDueDate("2027-01-05"), "05/01/2027");
  assert.equal(formatDueDate(null), "");
  assert.equal(formatDueDate(undefined), "");
});

test("/cade help and unknown slash commands list the commands privately", async (t) => {
  for (const text of ["", "help", "hello"]) {
    mockSlack(t);
    const reply = await (await send("/slack/commands", slash(text))).json<{ response_type: string; text: string }>();
    assert.equal(reply.response_type, "ephemeral");
    // The slash commands, the messages sent in a thread, the shortcuts, and
    // the admin commands, each on its own.
    assert.deepEqual(reply.text.split("\n"), [
      "Here's what I can do:",
      "*Slash commands*, at the top of a channel:",
      "`/cade task` · `/cade incident` · `/cade standup`",
      "*Messages*, sent in a thread:",
      "• In a message's thread: `@Cade task` · `@Cade incident` · `@Cade move <link>`",
      "• In a task's thread: `@Cade assign owner @person` · `@Cade unassign owner @person` · `@Cade status in review` · `@Cade priority high` · `@Cade due 31/12/2026` · `@Cade pr add <link>` · `@Cade pr remove <link>` · `@Cade subtask <title>` · `@Cade archive`",
      "*On any message*: ⋯ → More actions → New task, New incident or Move to existing.",
      "Send `/cade help` any time to see this again.",
    ]);
    for (const usage of ["/cade task", "/cade incident", "@Cade task", "@Cade priority high", "@Cade due 31/12/2026"]) {
      assert.ok(reply.text.includes(`\`${usage}\``), usage);
    }
  }
});

test("parseDate accepts DD/MM/YYYY and YYYY-MM-DD real dates only", () => {
  assert.equal(parseDate("1/2/2027"), "01/02/2027");
  assert.equal(parseDate("01-02-2027"), "01/02/2027");
  assert.equal(parseDate("2027-02-01"), "01/02/2027");
  assert.equal(parseDate("29/02/2027"), "");
  assert.equal(parseDate("13/13/2027"), "");
  assert.equal(parseDate("tomorrow"), "");
});

test("@Cade priority and due change the task's priority and due date", async (t) => {
  for (const [text, field, value, reply] of [
    ["<@UBOT> priority low", "priority", "Low", "<@UACTOR> set the priority to :large_green_circle: Low."],
    ["<@UBOT> due 5/1/2027", "dueDate", "05/01/2027", "<@UACTOR> set the due date to 05/01/2027."],
    ["<@UBOT> due 2027-02-28", "dueDate", "28/02/2027", "<@UACTOR> set the due date to 28/02/2027."],
  ] as const) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["chat.update", "reactions.add"],
      text,
    );
    assert.equal((await savedTask())[field], value, text);
    assert.deepEqual(calls[1].args, { channel: "CDEV", timestamp: "100.5", name: "white_check_mark" }, reply);
  }
});

test("owners were called developers before, and dev and developer still mean owner", async (t) => {
  for (const word of ["owner", "owners", "dev", "developer", "developers"]) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(`<@UBOT> assign ${word} <@UBOB>`));
    assert.deepEqual((await savedTask()).people.owner, ["UBOB"], word);
    assert.deepEqual(drafts(calls), ["<@UBOB>, could you pick this up?"], word);
  }
});

test("commands without what they need say what to send", async (t) => {
  for (const [text, reply] of [
    [
      "<@UBOT> assign",
      "Who, and as what? Try `@Cade assign owner @person`, `@Cade assign review @person`, `@Cade assign test @person`.",
    ],
    [
      "<@UBOT> assign <@UBOB>",
      "Who, and as what? Try `@Cade assign owner @person`, `@Cade assign review @person`, `@Cade assign test @person`.",
    ],
    ["<@UBOT> unassign", "Who? Try `@Cade unassign owner @person`, or `@Cade unassign @person` for every role."],
    [
      "<@UBOT> status",
      "Which status? Try `@Cade status in review`: to do, in progress, in review, in testing, client review or done.",
    ],
    [
      "<@UBOT> status soon",
      'I don\'t know "soon" as a status. Try `@Cade status in review`: to do, in progress, in review, in testing, client review or done.',
    ],
    ["<@UBOT> priority", "Which priority? Try `@Cade priority high`: urgent, high, medium or low."],
    [
      "<@UBOT> priority soon",
      'I don\'t know "soon" as a priority. Try `@Cade priority high`: urgent, high, medium or low.',
    ],
    ["<@UBOT> due", "When is it due? Try `@Cade due 31/12/2026`, or `@Cade due none` to clear it."],
    [
      "<@UBOT> due 31/02/2027",
      'I couldn\'t read "31/02/2027" as a date. Try `@Cade due 31/12/2026`, or `@Cade due none` to clear it.',
    ],
  ] as const) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["chat.postMessage"],
      text,
    );
    assert.equal(calls[0].args.text, reply, text);
    assert.equal((await savedTask()).status, "TODO", text);
  }
});

test("setting the status it already has changes nothing, so asks no one", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  await send("/slack/events", threadEvent("<@UBOT> status client review"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["reactions.add"],
  );
});

test("@Cade assign tester never changes the status", async (t) => {
  mockSlack(t, { stored: [withStatus("IN_PROGRESS")] });
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UTESS>"));
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.deepEqual((await savedTask()).people.tester, ["UTESS"]);
});

test("@Cade assign owner never changes the status", async (t) => {
  mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UREX>"));
  assert.deepEqual((await savedTask()).status, "TODO");
});

test("assigning from the task's own thread still doesn't ask them again", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("owner", ["UREX"])));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("@Cade unassign of someone not assigned changes nothing", async (t) => {
  for (const [text, reply] of [
    ["<@UBOT> unassign <@UREX>", "Looks like they aren't assigned to this task."],
    ["<@UBOT> unassign tester <@UALICE>", "Looks like they aren't assigned to this task as tester."],
    ["<@UBOT> unassign <@UREX> <@UBOB>", "Looks like none of them are assigned to this task."],
  ] as const) {
    const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["chat.postMessage"],
      text,
    );
    assert.equal(calls[0].args.text, reply);
  }
});

test("removed reviewers are told they no longer need to review", async (t) => {
  const root = storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" });
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> unassign reviewer <@URIA>"));
  assert.deepEqual(drafts(calls), ["<@URIA>, there's no need to review this anymore."]);
});

test("assign-style words without a mention are left alone", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("this was assigned to the wrong sprint, I assigned it to QA board"));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("@Cade status takes short names for each status", async () => {
  const { parseStatus } = await import("../src/tasks.ts");
  for (const [input, status] of [
    ["to do", "TODO"],
    ["todo", "TODO"],
    ["in progress", "IN_PROGRESS"],
    ["progress", "IN_PROGRESS"],
    ["wip", "IN_PROGRESS"],
    ["in review", "IN_REVIEW"],
    ["review", "IN_REVIEW"],
    ["in testing", "IN_TESTING"],
    ["testing", "IN_TESTING"],
    ["QA", "IN_TESTING"],
    ["client review", "CLIENT_REVIEW"],
    ["client", "CLIENT_REVIEW"],
    ["uat", "CLIENT_REVIEW"],
    ["done", "DONE"],
    ["Finished", "DONE"],
    ["CLIENT_REVIEW", "CLIENT_REVIEW"],
    ["soon", undefined],
  ] as const) {
    assert.equal(parseStatus(input), status, input);
  }
});
