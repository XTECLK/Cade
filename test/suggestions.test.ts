import assert from "node:assert/strict";
import test from "node:test";
import { editForm } from "../src/commands/edit.ts";
import type { AppEnv } from "../src/env.ts";
import type { Project } from "../src/channels.ts";
import { fake } from "./helpers.ts";
import type { PlainMessage } from "../src/types.ts";
import {
  DB,
  MR,
  PR,
  RESPONSE_URL,
  add,
  aiEnv,
  aiRead,
  aiSuggestion,
  assignValue,
  blockText,
  clickAssign,
  drafts,
  env,
  ephemeral,
  interaction,
  lastCalls,
  mockSlack,
  ownTask,
  recordResponses,
  savedTask,
  send,
  slackUsers,
  storedTask,
  suggestedChanges,
  suggestionButtons,
  taskWith,
  threadEvent,
  threadReply,
  withStatus,
} from "./app.ts";

test("a typed status gets a ✅ and never a question", async (t) => {
  for (const [root, input] of [
    [withStatus("TODO"), "in progress"],
    [withStatus("IN_PROGRESS"), "in review"],
    [withStatus("CLIENT_REVIEW"), "done"],
    [withStatus("DONE"), "client review"],
    [withStatus("DONE"), "done"],
    [withStatus("DONE"), "in progress"],
    [ownTask(), "done"],
  ] as const) {
    const calls = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadEvent(`<@UBOT> status ${input}`));
    assert.ok(
      calls.some((call) => call.method === "reactions.add"),
      input,
    );
    // Nothing is posted in the thread but the ✅.
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"), input);
  }
});

test("a task started before the click is not moved again", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("owner", ["UREX"], "IN_PROGRESS")));
  assert.deepEqual((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("saying you've started asks nothing when there's nothing to change, or it isn't a task thread", async (t) => {
  for (const [text, root, overrides] of [
    // A owner on a task that's under way.
    [
      "started working on this",
      (() => {
        const root = withStatus("IN_PROGRESS");
        root.task.people.owner = ["UACTOR"];
        return root;
      })(),
      {},
    ],
    // Anyone, on a task that's Done.
    ["picking this up", withStatus("DONE"), {}],
    // Not about the task, or not a task thread.
    ["can you comment on it?", storedTask(), {}],
    ["started working on this", null, {}],
    ["started working on this", storedTask(), { channel: "COTHER" }],
  ] as const) {
    const calls = mockSlack(t, { stored: root ? [root] : [] });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${overrides.channel ?? ""}`);
  }
});

test("other typed statuses get only the ✅", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("TODO")] });
  await send("/slack/events", threadEvent("<@UBOT> status in review"));
  assert.equal(calls.at(-1).method, "reactions.add");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("suggestions can be turned off, all or some, and a kind turned off asks the model nothing about it", async (t) => {
  const record = () => {
    const task = ownTask({ owners: ["UDEV1"] });
    task.task.status = "IN_PROGRESS";
    return task;
  };
  for (const [suggestions, text, offered] of [
    [undefined, "<@UREX> please review this", true],
    ["false", "<@UREX> please review this", false],
    ['["hand-offs"]', "<@UREX> please review this", true],
    ['["pr-links"]', "<@UREX> please review this", false],
  ] as const) {
    const { environment } = aiEnv(aiRead({ reviewer: add("UREX") }));
    const calls = mockSlack(t, { stored: [record()] });
    await send(
      "/slack/events",
      threadEvent(text, { user: "UDEV1" }),
      {},
      suggestions === undefined ? environment : { ...environment, TASK_CHANGE_DETECTION: suggestions },
    );
    assert.equal(
      calls.some((call) => call.method === "chat.postEphemeral"),
      offered,
      `${suggestions}: ${text}`,
    );
  }
});

test("intent phrases match whole words, or word starts with *", async () => {
  const { intent, plainMessage } = await import("../src/intents.ts");
  const message = (text: string) =>
    plainMessage({ type: "message", text, user: "U", channel: "C", ts: "1.2", thread_ts: "1.1" }, "UBOT");
  const whole = intent({ name: "whole", order: 1, phrases: ["work on"], handle() {} });
  assert.ok(whole.test(message("can you work on this")));
  assert.ok(!whole.test(message("that would work only later")));
  const start = intent({ name: "start", order: 1, phrases: ["test*"], handle() {} });
  assert.ok(start.test(message("ready for testing")));
  assert.ok(!start.test(message("the latest build")));
  assert.throws(() => intent({ name: "neither", order: 1, handle() {} }), /needs either phrases or match/);
});

test("the first intent by order wins, and needs are checked first", async () => {
  const { findIntent, intent, plainMessage } = await import("../src/intents.ts");
  const event = (text: string, extra = {}) => ({
    type: "message",
    text,
    user: "U",
    channel: "C",
    ts: "1.2",
    thread_ts: "1.1",
    ...extra,
  });
  const late = intent({ name: "late", order: 50, phrases: ["deploy*"], handle() {} });
  const early = intent({ name: "early", order: 5, phrases: ["deploy*"], needs: { mention: true }, handle() {} });
  // Order wins over the order they're listed in…
  assert.equal(findIntent([late, early], plainMessage(event("<@UREX> deploying now"), "UBOT")).name, "early");
  // …but an intent whose needs aren't met is passed over.
  assert.equal(findIntent([late, early], plainMessage(event("deploying now"), "UBOT")).name, "late");
  // Cade mentioning itself isn't someone mentioned.
  assert.equal(findIntent([early], plainMessage(event("<@UBOT> deploying"), "UBOT")), undefined);
  const threaded = intent({ name: "threaded", order: 1, phrases: ["deploy*"], needs: { thread: true }, handle() {} });
  assert.equal(findIntent([threaded], plainMessage(event("deploying", { thread_ts: undefined }), "UBOT")), undefined);
  // Edits and bot posts are never intents.
  assert.equal(plainMessage(event("deploying", { subtype: "message_changed" }), "UBOT"), null);
  assert.equal(plainMessage(event("deploying", { bot_id: "B1" }), "UBOT"), null);
});

test("handlers' intents are registered in order: work, then new threads", async () => {
  const { intents } = await import("../src/commands/registry.ts");
  assert.deepEqual(
    [...intents].sort((a, b) => a.order - b.order).map((each) => each.name),
    ["work", "new-thread"],
  );
});

test("messages about work already in hand suggest nothing", async (t) => {
  // UDEV1 and UDEV2 develop it, UMIA reviews and UTOM tests, and it's In
  // progress: none of these needs a question.
  const task = () => {
    const record = ownTask({ owners: ["UDEV1", "UDEV2"], reviewers: ["UMIA"], testers: ["UTOM"] });
    record.task.status = "IN_PROGRESS";
    return record;
  };
  for (const [user, text] of [
    ["UDEV1", "<@UDEV2> started working on some subtask"],
    ["UDEV1", "<@UDEV2> started working on the review comments"],
    ["UDEV1", "<@UDEV2> started working on the test cases"],
    ["UDEV1", "<@UDEV2> is working on the login part"],
    ["UDEV1", "<@UDEV2> started on the subtask"],
    ["UDEV1", "<@UMIA> started working on the review"],
    ["UDEV1", "<@UTOM> is working on the test plan"],
    ["UMIA", "started working on the review"],
    ["UTOM", "started working on the test cases"],
    ["UDEV2", "finished the login subtask"],
    ["UDEV2", "first part is done"],
    ["UDEV2", "fixed one of the bugs"],
  ] as const) {
    const calls = mockSlack(t, { stored: [task()] });
    await send("/slack/events", threadEvent(text, { user }));
    assert.deepEqual(
      calls.map((call) => call.method),
      [],
      `${user}: ${text}`,
    );
  }
});

// Clicks the suggestion `question`'s button `index`: 0 Accept, 1 Edit…, 2 Reject.
const answerSuggestion = (question, index = 0, user = "UACTOR") => {
  const button = suggestionButtons(question)[index];
  return interaction({
    type: "block_actions",
    user: { id: user },
    channel: { id: "CDEV" },
    trigger_id: "T1",
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: button.action_id, value: button.value }],
  });
};

test("a suggestion moving the task to In review or In testing with no one in that role says so under it, and accepting it asks nothing more", async (t) => {
  const line = (question) =>
    question.blocks.find((block) => block.type === "context" && !blockText(block).startsWith("Don't want these"));
  for (const [label, record, raw, expected] of [
    [
      "no reviewer",
      taskWith("IN_PROGRESS"),
      { status: "IN_REVIEW" },
      "No one is reviewing this yet. Add a reviewer with Edit…, so they're asked.",
    ],
    [
      "no tester",
      taskWith("IN_REVIEW", { reviewers: ["UACTOR"] }),
      { status: "IN_TESTING" },
      "No one is testing this yet. Add a tester with Edit…, so they're asked.",
    ],
    // Someone there, or suggested, or a stage that waits on no one.
    ["a reviewer", taskWith("IN_PROGRESS", { reviewers: ["UMIA"] }), { status: "IN_REVIEW" }, undefined],
    [
      "one suggested",
      taskWith("IN_PROGRESS"),
      { status: "IN_REVIEW", reviewer: { add: ["UMIA"], remove: [] } },
      undefined,
    ],
  ] as const) {
    const text =
      label === "one suggested"
        ? "<@UMIA> ready for review, can you review?"
        : label === "no tester"
          ? "lgtm"
          : "ready for review";
    const { question } = await aiSuggestion(t, text, record, raw);
    assert.ok(question, label);
    assert.equal(line(question) && blockText(line(question)), expected, label);
  }

  // Accepting it moves the task, and asks for no one privately again: the line said so.
  const { calls, question } = await aiSuggestion(t, "ready for review", taskWith("IN_PROGRESS"), {
    status: "IN_REVIEW",
  });
  calls.length = 0;
  recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  assert.equal((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("saving the Edit form into In review with no reviewer asks nothing more: the form shows who's missing", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("IN_PROGRESS")] });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "task:edit",
        private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", details: false }),
        state: {
          values: {
            owner: { value: { selected_users: [] } },
            reviewer: { value: { selected_users: [] } },
            tester: { value: { selected_users: [] } },
            status: { value: { selected_option: { value: "IN_REVIEW" } } },
          },
        },
      },
    }),
  );
  assert.equal((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("a suggestion asks whoever wrote the message, privately, with Accept, Edit… and Reject", async (t) => {
  const { question } = await aiSuggestion(
    t,
    "<@UMIA> can you review this? cc <@UREX>",
    taskWith("IN_PROGRESS", { reviewers: ["URIA"] }),
    { reviewer: add("UMIA") },
  );
  assert.equal(question.user, "UACTOR");
  assert.equal(question.thread_ts, "100.1");
  assert.equal(question.text, "Should I update the task? From your message:");
  assert.equal(question.blocks[1].text.text, "*Reviewers:* <@UMIA> (Add)");
  assert.deepEqual(suggestedChanges(question), { people: { reviewer: add("UMIA") } });
  assert.deepEqual(
    suggestionButtons(question).map((button) => button.text.text),
    ["Accept", "Edit…", "Reject"],
  );
});

test("suggestions turned off in Settings aren't offered to that person, nor their messages read with AI, until turned on", async (t) => {
  const { environment, asked } = aiEnv(aiRead({ reviewer: add("UMIA") }));
  const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored: [taskWith("IN_PROGRESS")] });
  const turn = async (on: boolean) => {
    await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: "UACTOR" },
        actions: [{ action_id: "home:suggestions", value: JSON.stringify({ on }) }],
      }),
      {},
      environment,
    );
    const view = calls.filter((call) => call.method === "views.publish").at(-1).args.view;
    assert.equal(view.private_metadata, "configure", "Configure is drawn again");
    return view.blocks.find((block) => block.accessory?.action_id === "home:suggestions");
  };
  const questions = () => calls.filter((call) => call.method === "chat.postEphemeral").length;

  const off = await turn(false);
  assert.match(blockText(off), /\*Suggestions\*\n:x: Off for you/);
  assert.equal(off.accessory.text.text, "Turn on");
  assert.deepEqual(JSON.parse(off.accessory.value), { on: true });
  await send("/slack/events", threadReply("<@UMIA> can you review this?", { user: "UACTOR" }), {}, environment);
  assert.equal(questions(), 0);
  assert.equal(asked.length, 0, "the model isn't asked");
  // Someone else still gets theirs.
  await send(
    "/slack/events",
    threadReply("<@UMIA> can you review this?", { user: "UOTHER", ts: "100.6" }),
    {},
    environment,
  );
  assert.equal(questions(), 1);

  const on = await turn(true);
  assert.match(blockText(on), /\*Suggestions\*\n:white_check_mark: On/);
  assert.equal(on.accessory.text.text, "Turn off");
  await send(
    "/slack/events",
    threadReply("<@UMIA> can you review this?", { user: "UACTOR", ts: "100.7" }),
    {},
    environment,
  );
  assert.equal(questions(), 2);
  // Each question says where to turn them off.
  assert.match(
    blockText(
      calls
        .filter((call) => call.method === "chat.postEphemeral")
        .at(-1)
        .args.blocks.at(-1),
    ),
    /Home tab → Settings → Suggestions/,
  );
});

test("three rejects in a row offer to turn suggestions off: Accept or Edit… starts the count again, Keep them stops it for 30 days", async (t) => {
  const { environment } = aiEnv(aiRead({ reviewer: add("UMIA") }));
  const calls = mockSlack(t, { stored: [taskWith("IN_PROGRESS")] });
  let ts = 100.5;
  // A message from UACTOR, and the private question it gets, or undefined.
  const suggest = async () => {
    const before = calls.length;
    await send(
      "/slack/events",
      threadReply("<@UMIA> can you review this?", { user: "UACTOR", ts: String((ts += 0.1).toFixed(1)) }),
      {},
      environment,
    );
    return calls.slice(before).find((call) => call.method === "chat.postEphemeral")?.args;
  };
  // Clicks the question's button `index` (0 Accept, 1 Edit…, 2 Reject), or a button of the offer by its label; returns what replaced it.
  const click = async (button) => {
    const before = calls.length;
    await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: "UACTOR" },
        channel: { id: "CDEV" },
        trigger_id: "T1",
        response_url: RESPONSE_URL,
        actions: [{ action_id: button.action_id, value: button.value }],
      }),
      {},
      environment,
    );
    return calls.slice(before).find((call) => call.method === "respond")?.args;
  };
  const reject = async () => click(suggestionButtons(await suggest())[2]);
  const offerButton = (offer, label) => suggestionButtons(offer).find((button) => button.text.text === label);

  // Two rejects, then an Edit…: it starts the count again (Accept does too, in the next test).
  assert.equal((await reject()).delete_original, true);
  assert.equal((await reject()).delete_original, true);
  await click(suggestionButtons(await suggest())[1]);
  assert.equal((await reject()).delete_original, true);
  assert.equal((await reject()).delete_original, true);
  // The third in a row: the suggestion becomes the offer.
  const offer = await reject();
  assert.equal(offer.replace_original, true);
  assert.match(offer.text, /turned down my last 3 suggestions/);
  assert.deepEqual(
    suggestionButtons(offer).map((button) => button.text.text),
    ["Turn off", "Keep them"],
  );
  assert.match(blockText(offer.blocks.at(-1)), /Home tab → Settings → Suggestions/);

  // Keep them: no offer for the next rejects, and suggestions stay on.
  assert.match((await click(offerButton(offer, "Keep them"))).text, /won't ask about this for 30 days/);
  for (let i = 0; i < 4; i++) assert.equal((await reject()).delete_original, true);
  // Thirty days on, the count runs again.
  await DB.prepare(
    "UPDATE user_preferences SET rejects_paused_until = datetime('now', '-1 minute') WHERE user_id = 'UACTOR'",
  ).run();
  await reject();
  await reject();
  const again = await reject();
  assert.equal(again.replace_original, true);

  // Turn off: the same switch as Settings, so the next message gets no question.
  assert.match((await click(offerButton(again, "Turn off"))).text, /won't suggest changes from your messages/);
  assert.equal(await suggest(), undefined);
});

test("accepting a suggestion starts the count of rejects in a row again", async (t) => {
  const { environment } = aiEnv(aiRead({ reviewer: add("UMIA") }));
  mockSlack(t, { stored: [taskWith("IN_PROGRESS")] });
  await DB.prepare("INSERT INTO user_preferences (user_id, suggestion_rejects) VALUES ('UACTOR', 2)").run();
  const before = lastCalls.length;
  await send("/slack/events", threadReply("<@UMIA> can you review this?", { user: "UACTOR" }), {}, environment);
  const question = lastCalls.slice(before).find((call) => call.method === "chat.postEphemeral").args;
  await send("/slack/interactions", answerSuggestion(question, 0, "UACTOR"), {}, environment);
  assert.equal(
    (await DB.prepare("SELECT suggestion_rejects FROM user_preferences WHERE user_id = 'UACTOR'").first())
      .suggestion_rejects,
    0,
  );
});

test("Accept applies the suggestion and tells the thread who changed what", async (t) => {
  const record = () => taskWith("IN_REVIEW", { reviewers: ["URIA"], testers: ["UTOM"] });
  const { question } = await aiSuggestion(t, "<@UTESS> please test it", record(), {
    tester: add("UTESS"),
    status: "IN_TESTING",
  });

  const calls = mockSlack(t, { ...slackUsers, stored: [record()] });
  const sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  const saved = await savedTask();
  assert.deepEqual(saved.people.tester, ["UTOM", "UTESS"]);
  assert.equal(saved.status, "IN_TESTING");
  const post = calls.filter((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV").at(-1).args;
  assert.equal(post.thread_ts, "100.1");
  assert.equal(
    post.text,
    ["<@UACTOR> assigned @Tess as tester.", "<@UACTOR> set the status to :test_tube: In testing."].join("\n"),
  );
  // Tess was mentioned in the message, so is named and not asked again; moving to In testing means
  // asking the other testers, offered to whoever accepted it.
  assert.deepEqual(drafts(calls), ["<@UTOM>, could you give this a test?"]);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("someone who assigns or removes themselves is named as themselves, and isn't asked anything", async (t) => {
  // Commands only get a ✅, and whoever else is asked.
  for (const [text, record, reply] of [
    ["<@UBOT> assign owner <@UACTOR>", storedTask(), undefined],
    ["<@UBOT> assign owner <@UACTOR> <@UBOB>", storedTask(), "<@UBOB>, could you pick this up?"],
    ["<@UBOT> unassign owner <@UACTOR>", storedTask({ owners: ["UACTOR"] }), undefined],
    ["<@UBOT> unassign <@UACTOR>", storedTask({ owners: ["UACTOR"] }), undefined],
  ] as const) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadEvent(text));
    assert.equal(drafts(calls)[0], reply, text);
  }

  // Accepting "started working on this" makes the writer an owner, and
  // asks no one.
  const { question } = await aiSuggestion(t, "okay, started working on this", taskWith("TODO"), {
    owner: add("UACTOR"),
    status: "IN_PROGRESS",
  });
  let calls = mockSlack(t, { stored: [taskWith("TODO")] });
  recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  const post = calls.filter((call) => call.method === "chat.postMessage").at(-1).args;
  assert.equal(
    post.text,
    "<@UACTOR> assigned themselves as owner.\n<@UACTOR> set the status to :arrow_forward: In progress.",
  );

  // A tester who moves it to In testing isn't asked to test it.
  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { testers: ["UACTOR", "UTOM"] })] });
  await send("/slack/events", threadEvent("<@UBOT> status in testing"));
  assert.deepEqual(drafts(calls), ["<@UTOM>, could you give this a test?"]);
});

test("Edit… on a suggestion opens the task's Edit form, filled in with it", async (t) => {
  const { question } = await aiSuggestion(
    t,
    "<@UMIA> can you review this?",
    taskWith("IN_REVIEW", { reviewers: ["URIA"] }),
    { reviewer: add("UMIA") },
  );
  const calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { reviewers: ["URIA"] })] });
  await send("/slack/interactions", answerSuggestion(question, 1));
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.callback_id, "task:edit");
  assert.deepEqual(form.blocks.find((block) => block.block_id === "reviewer").element.initial_users, ["URIA", "UMIA"]);
});

test("Accept leaves a suggested status alone once the task has moved, and Reject changes nothing", async (t) => {
  const { question } = await aiSuggestion(t, "on it", taskWith("TODO", { owners: ["UACTOR"] }), {
    status: "IN_PROGRESS",
  });

  // Someone moved it to In review meanwhile.
  let calls;
  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { owners: ["UACTOR"] })] });
  let sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  assert.equal((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  calls = mockSlack(t, { stored: [taskWith("TODO", { owners: ["UACTOR"] })] });
  sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question, 2));
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("progressOptions reads the task, the writer and their words", async () => {
  const { progressOptions } = await import("../src/commands/status.ts");
  const task = (status, people = {}) => taskWith(status, people).task;
  const says = (text: string) => fake<PlainMessage>({ text });
  assert.deepEqual(progressOptions(task("IN_REVIEW", { reviewers: ["U1"] }), "U1", says("lgtm")), ["IN_TESTING"]);
  assert.deepEqual(progressOptions(task("IN_TESTING", { testers: ["U1"] }), "U1", says("lgtm")), ["DONE"]);
  assert.deepEqual(progressOptions(task("IN_PROGRESS", { owners: ["U1"] }), "U1", says("lgtm")), []);
  assert.deepEqual(progressOptions(task("DONE", { owners: ["U1"] }), "U1", says("done")), []);
});

// Paths that only run when something goes wrong, or at the edges.

test("the started intent asks nothing outside the paired channels", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadReply("started working on this", { channel: "COTHER" }));
  assert.deepEqual(calls, []);
});

test("moving a task to In review with no reviewer, or In testing with no tester, suggests whoever moved it assign one, with Edit… and Reject", async (t) => {
  for (const [status, record, note] of [
    ["review", storedTask(), "No one is reviewing this yet. Add a reviewer with Edit…, so they're asked."],
    ["testing", storedTask(), "No one is testing this yet. Add a tester with Edit…, so they're asked."],
    // Someone is there, or the stage waits on no one.
    ["review", storedTask({ reviewers: ["UMIA"] }), undefined],
    ["testing", storedTask({ testers: ["UTOM"] }), undefined],
    ["in progress", storedTask(), undefined],
  ] as const) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadEvent(`<@UBOT> status ${status}`));
    const asked = ephemeral(calls);
    assert.equal(asked?.text, note, `${status} ${JSON.stringify(record.task.people)}`);
    if (!asked) continue;
    assert.deepEqual([asked.user, asked.thread_ts], ["UACTOR", "100.1"]);
    // A suggestion with nothing to accept: the same buttons, but Accept.
    assert.deepEqual(
      suggestionButtons(asked).map((button) => [button.action_id, button.text.text]),
      [
        ["ai-suggest:edit", "Edit…"],
        ["ai-suggest:reject", "Reject"],
      ],
    );
    assert.equal(
      JSON.parse(suggestionButtons(asked)[0].value).changes &&
        Object.keys(JSON.parse(suggestionButtons(asked)[0].value).changes).length,
      0,
    );
  }
});

test("Edit… on the assign-someone suggestion opens the task's Edit form as it stands, which removes it once saved; Reject removes it", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_PROGRESS")] });
  await send("/slack/events", threadEvent("<@UBOT> status review"));
  const question = ephemeral(calls);
  const sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question, 0));
  const { view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(view.callback_id, "task:edit");
  assert.deepEqual(JSON.parse(view.private_metadata), {
    channel: "CDEV",
    ts: "100.1",
    details: true,
    responseUrl: RESPONSE_URL,
  });
  assert.deepEqual(view.blocks.find((block) => block.block_id === "reviewer").element.initial_users, undefined);

  await send("/slack/interactions", answerSuggestion(question, 1));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("suggestions can be set per group, over the setting for every group", async (t) => {
  const pairs = (acme) =>
    (env.PROJECTS as Project[]).map((pair) => (pair.name === "acme" ? { ...pair, ...acme } : pair));

  // acme turns the proactive agent off, though it's on for every group.
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send(
    "/slack/events",
    threadEvent("<@UMIA> can you review this?"),
    {},
    { ...env, PROJECTS: pairs({ taskChangeDetection: false }) },
  );
  assert.equal(ephemeral(calls), undefined);

  // acme turns it on, with a kind, though it's off for every group.
  const { environment, asked } = aiEnv(aiRead({ reviewer: { add: ["UMIA"], remove: [] } }));
  calls = mockSlack(t, { stored: [storedTask()] });
  await send(
    "/slack/events",
    threadEvent("<@UMIA> can you review this?"),
    {},
    { ...environment, TASK_CHANGE_DETECTION: "false", PROJECTS: pairs({ taskChangeDetection: true }) },
  );
  assert.equal(asked.length, 1);
  assert.equal(ephemeral(calls).text, "Should I update the task? From your message:");

  // Another group keeps the setting for every group.
  const { suggesting } = await import("../src/intents.ts");
  const split = fake<AppEnv>({
    AI: {},
    TASK_CHANGE_DETECTION: "false",
    PROJECTS: pairs({ taskChangeDetection: ["hand-offs"] }),
  });
  assert.equal(suggesting(split, "hand-offs", "CDEV"), true);
  assert.equal(suggesting(split, "progress", "CDEV"), false);
  assert.equal(suggesting(split, "hand-offs", "CTESTDEV"), false);
});

test("the Edit form of a suggestion shows the task as it will be, with its people and status, and no pull requests", () => {
  const { task } = storedTask({ reviewers: ["URIA"] });
  task.status = "IN_PROGRESS";
  task.prs = [MR];
  const field = (view, id) => view.blocks.find((block) => block.block_id === id)?.element;

  // One suggested before pull requests stopped being suggested still has them; the form leaves them out.
  const form = editForm({ channel: "CDEV", ts: "100.1" }, task, {
    changes: { prs: { add: [PR], remove: [MR] }, people: { reviewer: { add: ["UREX"], remove: [] } } },
  });
  assert.equal(field(form, "status").initial_option.value, "IN_PROGRESS");
  assert.deepEqual(field(form, "reviewer").initial_users, ["URIA", "UREX"]);
  assert.equal(field(form, "prs"), undefined);

  // As the task stands, without a suggestion.
  const plain = editForm({ channel: "CDEV", ts: "100.1" }, task);
  assert.equal(field(plain, "status").initial_option.value, "IN_PROGRESS");
});
