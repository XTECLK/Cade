import assert from "node:assert/strict";
import test from "node:test";
import type { Status, StoredTask } from "../src/types.ts";
import { fake } from "./helpers.ts";
import type { Allowed } from "../src/ai.ts";
import type { PlainMessage } from "../src/types.ts";
import {
  MR,
  PR,
  RESPONSE_URL,
  aiEnv,
  aiRead,
  aiSuggestion,
  ephemeral,
  incidentTask,
  interaction,
  mockSlack,
  noteValue,
  ownTask,
  recordResponses,
  savedTask,
  send,
  slackUsers,
  storedTask,
  suggestedChanges,
  threadEvent,
  withStatus,
} from "./app.ts";

// The private question about changes, not the note that a pasted PR was linked (see linkPasted).
const suggestion = (calls) =>
  calls.find((call) => call.method === "chat.postEphemeral" && call.args.text.startsWith("Should I update"))?.args;

const aiClick = (button, extra = {}) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    trigger_id: "T1",
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: button.action_id, value: button.value }],
    ...extra,
  });

test("a task with subtasks only moves to DONE, and only for a message about the whole", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const people = { owner: [], reviewer: [], tester: [] };
  const allowed = { roles: [], status: true, details: false };
  const status = (task, text, to) =>
    checkChanges(aiRead({ status: to }), { task, message: { user: "UACTOR", mentions: [], text }, allowed })?.status ??
    null;
  const parts = { status: "IN_PROGRESS", people, subtaskCounts: { open: 1, closed: 1 } };
  assert.equal(status(parts, "we can close this as done", "DONE"), "DONE");
  assert.equal(status(parts, "all subtasks are done", "DONE"), "DONE");
  assert.equal(status(parts, "subtask 2 is done", "DONE"), null);
  assert.equal(status(parts, "backend merged, we're done here", "DONE"), null);
  assert.equal(status(parts, "everything is ready for review", "IN_REVIEW"), null);
  assert.equal(status(parts, "lgtm", "DONE"), null);
  // Work begun on any part starts the task, but only from TODO.
  assert.equal(status({ ...parts, status: "TODO" }, "started on subtask 1", "IN_PROGRESS"), "IN_PROGRESS");
  assert.equal(status(parts, "started on subtask 2", "IN_PROGRESS"), null);
  assert.equal(status({ ...parts, status: "TODO" }, "ready for review", "IN_REVIEW"), null);
  // Without subtasks the same words move it as before, even for a task the old "Has subtasks" box was
  // ticked on: only real subtasks make a task done in parts now.
  assert.equal(status({ ...parts, subtaskCounts: undefined }, "ready for review", "IN_REVIEW"), "IN_REVIEW");
  assert.equal(
    status({ ...parts, subtaskCounts: undefined, subtasks: true }, "ready for review", "IN_REVIEW"),
    "IN_REVIEW",
  );
});

test("AI's changes are checked against the message and the task", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const task = fake<StoredTask>({
    status: "IN_PROGRESS",
    priority: "High",
    dueDate: "31/10/2026",
    people: { owner: ["UBOB"], reviewer: [], tester: [] },
  });
  const message = fake<PlainMessage>({ user: "UACTOR", mentions: ["UREX", "UMIA"] });
  const allowed: Allowed = { roles: ["owner", "reviewer", "tester"], status: true, details: true };
  const raw = aiRead({
    // UZED wasn't mentioned, and UBOB is an owner already.
    owner: { add: ["UREX", "UZED", "UBOB"], remove: ["UMIA"] },
    reviewer: { add: ["UMIA", "UMIA"], remove: [] },
    tester: { add: [], remove: ["UTOM"] },
    status: "IN_REVIEW",
    priority: "High",
    dueDate: "2026-02-30",
  });
  assert.deepEqual(checkChanges(raw, { task, message, allowed }), {
    people: { owner: { add: ["UREX"], remove: [] }, reviewer: { add: ["UMIA"], remove: [] } },
    status: "IN_REVIEW",
  });
  assert.deepEqual(checkChanges(aiRead({ priority: "Urgent", dueDate: "2026-11-06" }), { task, message, allowed }), {
    priority: "Urgent",
    dueDate: "06/11/2026",
  });
  assert.deepEqual(checkChanges(aiRead({ dueDate: "clear" }), { task, message, allowed }), { dueDate: "" });
  // What isn't allowed is dropped; with nothing left, nothing changes.
  const narrow: Allowed = { roles: ["reviewer"], status: false, details: false, author: false };
  assert.equal(
    checkChanges(aiRead({ owner: { add: ["UREX"], remove: [] }, status: "DONE" }), { task, message, allowed: narrow }),
    null,
  );
  // The author is added only when allowed.
  assert.deepEqual(
    checkChanges(aiRead({ reviewer: { add: ["UACTOR", "UREX"], remove: [] } }), { task, message, allowed: narrow }),
    { people: { reviewer: { add: ["UREX"], remove: [] } } },
  );
  assert.equal(checkChanges(aiRead({ status: "IN_PROGRESS", priority: "Loud" }), { task, message, allowed }), null);
});

test("with AI on, a message is read for every change and confirmed privately", async (t) => {
  const { environment, asked } = aiEnv(
    aiRead({
      owner: { add: ["UREX"], remove: ["UBOB"] },
      reviewer: { add: ["UMIA"], remove: [] },
      status: "IN_PROGRESS",
      priority: "Urgent",
      dueDate: "2026-10-30",
    }),
  );
  const calls = mockSlack(t, { ...slackUsers, stored: [ownTask({ owners: ["UBOB"] })] });
  calls.responses = recordResponses(t);
  const text =
    "<@UREX> can you take this over from <@UBOB>? <@UMIA> please review. Need it by Friday, it's blocking the release";
  await send("/slack/events", threadEvent(text), {}, environment);

  assert.equal(asked[0].model, "@cf/zai-org/glm-4.7-flash");
  assert.deepEqual(asked[0].input.chat_template_kwargs, { enable_thinking: false });
  const input = JSON.parse(asked[0].input.messages[1].content);
  assert.deepEqual(input.mentioned, ["UREX", "UBOB", "UMIA"]);
  assert.equal(input.task.status, "TODO");

  const question = ephemeral(calls);
  assert.equal(question.user, "UACTOR");
  assert.equal(question.text, "Should I update the task? From your message:");
  assert.equal(
    question.blocks[1].text.text,
    [
      "*Owners:* <@UREX> (Add) · <@UBOB> (Remove)",
      "*Reviewers:* <@UMIA> (Add)",
      "*Status:* :memo: To do → :arrow_forward: In progress",
      "*Priority:* :large_orange_circle: High → :red_circle: Urgent",
      "*Due:* 31/10/2026 → 30/10/2026",
    ].join("\n"),
  );
  const [confirm, change, skip] = question.blocks[2].elements;
  assert.deepEqual([confirm.text.text, change.text.text, skip.text.text], ["Accept", "Edit…", "Reject"]);

  // Accept applies it all, and the thread hears it as one message. Everyone
  // it names was mentioned in the message, so they're named, not notified
  // again, and asked nothing.
  await send("/slack/interactions", aiClick(confirm), {}, environment);
  const saved = await savedTask();
  assert.deepEqual(saved.people, { owner: ["UREX"], reviewer: ["UMIA"], tester: [] });
  assert.deepEqual([saved.status, saved.priority, saved.dueDate], ["IN_PROGRESS", "Urgent", "30/10/2026"]);
  const posts = calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1");
  assert.equal(posts.length, 1);
  assert.equal(
    posts[0].args.text,
    [
      "<@UACTOR> assigned @Rex as owner.",
      "<@UACTOR> removed @Bob as owner.",
      "<@UACTOR> assigned @Mia as reviewer.",
      "<@UACTOR> set the priority to :red_circle: Urgent.",
      "<@UACTOR> set the due date to 30/10/2026.",
      "<@UACTOR> set the status to :arrow_forward: In progress.",
    ].join("\n"),
  );
  assert.deepEqual(calls.responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Edit… opens the task's Edit form filled in with what AI read, and saving it applies the form", async (t) => {
  const { environment } = aiEnv(aiRead({ tester: { add: ["UTESS"], remove: [] }, status: "IN_TESTING" }));
  const calls = mockSlack(t, { ...slackUsers, stored: [ownTask({ testers: ["UTOM"] })] });
  calls.responses = recordResponses(t);
  await send("/slack/events", threadEvent("<@UTESS> can you test this now?"), {}, environment);
  const [, change] = ephemeral(calls).blocks[2].elements;

  await send("/slack/interactions", aiClick(change), {}, environment);
  const form = calls.at(-1).args.view;
  assert.equal(calls.at(-1).method, "views.open");
  assert.equal(form.callback_id, "task:edit");
  assert.deepEqual(
    form.blocks.map((block) => block.block_id),
    ["kind", "owner", "reviewer", "tester", "status", "priority", "due_date", "blocked", "blocked_reason"],
  );
  assert.deepEqual(form.blocks[3].element.initial_users, ["UTOM", "UTESS"]);
  assert.equal(form.blocks[4].element.initial_option.value, "IN_TESTING");
  assert.equal(form.blocks[6].element.initial_date, "2026-10-31");

  // Whoever saved it changed their mind about UTOM, and moved the due date.
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: form.callback_id,
        private_metadata: form.private_metadata,
        state: {
          values: {
            owner: { value: { selected_users: [] } },
            reviewer: { value: { selected_users: [] } },
            tester: { value: { selected_users: ["UTESS"] } },
            status: { value: { selected_option: { value: "IN_TESTING" } } },
            priority: { value: { selected_option: { value: "High" } } },
            due_date: { value: { selected_date: "2026-11-02" } },
            prs: { value: { value: "" } },
          },
        },
      },
    }),
    {},
    environment,
  );
  const saved = await savedTask();
  assert.deepEqual(saved.people.tester, ["UTESS"]);
  assert.deepEqual([saved.status, saved.dueDate], ["IN_TESTING", "02/11/2026"]);
  assert.equal(
    calls.filter((call) => call.method === "chat.postMessage").at(-1).args.text,
    [
      // Named, not mentioned (UACTOR has no name here, so stays a mention).
      "<@UACTOR> assigned @Tess as tester.",
      "<@UACTOR> removed @Tom as tester.",
      "<@UACTOR> set the due date to 02/11/2026.",
      "<@UACTOR> set the status to :test_tube: In testing.",
    ].join("\n"),
  );
  // The private question goes once the form is saved.
  assert.deepEqual(calls.responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("AI isn't asked about the priority and due date of an incident", async (t) => {
  const { environment } = aiEnv(aiRead({ priority: "Low", dueDate: "2026-10-30" }));
  const calls = mockSlack(t, { stored: [incidentTask()] });
  await send("/slack/events", threadEvent("This is urgent, need it by Friday"), {}, environment);
  assert.equal(ephemeral(calls), undefined);
});

test("with AI on, a message saying the task is blocked, or no longer, is read and asked about", async (t) => {
  const blockedTask = () => {
    const record = storedTask({ status: "IN_PROGRESS" });
    record.task.blocked = true;
    record.task.blockedReason = "waiting on design";
    return record;
  };
  for (const [text, record, raw, changes, line] of [
    // None of these words were in the phrases that decide what AI reads before.
    [
      "we're waiting on the API keys",
      storedTask({ status: "IN_PROGRESS" }),
      { blocked: "block", blockedReason: "waiting on the API keys" },
      { blocked: { on: true, reason: "waiting on the API keys" } },
      "*Blocked:* no → yes (waiting on the API keys)",
    ],
    [
      "design arrived, unblocked",
      blockedTask(),
      { blocked: "unblock" },
      { blocked: { on: false } },
      "*Blocked:* yes → no",
    ],
  ] as const) {
    const { environment, asked } = aiEnv(aiRead(raw));
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadEvent(text), {}, environment);
    assert.equal(asked.length, 1, text);
    const question = ephemeral(calls);
    assert.deepEqual(suggestedChanges(question), changes, text);
    assert.match(JSON.stringify(question.blocks), new RegExp(line.replace(/[*()]/g, "\\$&")), text);
  }
});

test("the model isn't asked about pull requests, and what it says of them is ignored", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const people = { owner: [], reviewer: [], tester: [] };
  const task = fake<StoredTask>({ status: "IN_PROGRESS", people, prs: [MR] });
  const message = fake<PlainMessage>({ user: "UA", mentions: [], text: `closed ${MR}, new PR is ${PR}` });
  const allowed: Allowed = { roles: [], status: true };
  // As an older model's answer might still say.
  const answer = { ...aiRead(), prs: { add: [PR], remove: [MR] } };
  assert.equal(checkChanges(answer, { task, message, allowed }), null);
});

test("with AI on, a pasted pull request is linked whatever the model reads, and nothing is suggested about it", async (t) => {
  const withMr = () => {
    const record = storedTask({ status: "IN_PROGRESS" });
    record.task.prs = [MR];
    return record;
  };
  for (const [text, prs] of [
    [`PR is up: ${PR}`, [MR, PR]],
    // A link pasted for reference is linked too: Unlink on the note takes it off.
    [`see ${PR} for how they did it`, [MR, PR]],
    [`${MR} is abandoned`, [MR]],
  ] as const) {
    const { calls, asked } = await aiSuggestion(t, text, withMr(), {});
    assert.deepEqual((await savedTask()).prs, prs, text);
    assert.equal(suggestion(calls), undefined, text);
    // The model is told nothing of pull requests.
    assert.doesNotMatch(JSON.stringify(asked), /pullRequests/, text);
  }
  // The model failing: the link is still linked, from the text.
  const { environment } = aiEnv(new Error("model unavailable"));
  const calls = mockSlack(t, { stored: [withMr()] });
  await send("/slack/events", threadEvent(`PR is up: ${PR}`), {}, environment);
  assert.deepEqual((await savedTask()).prs, [MR, PR]);
  assert.equal(suggestion(calls), undefined);
});

test("with AI on, a message that changes nothing gets no question", async (t) => {
  const { environment, asked } = aiEnv(aiRead());
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("cc <@UREX>, thanks for the review earlier"), {}, environment);
  assert.equal(asked.length, 1);
  assert.equal(ephemeral(calls), undefined);
});

test("AI doesn't read messages in a task that's Done", async (t) => {
  const { environment, asked } = aiEnv(aiRead({ reviewer: { add: ["UMIA"], remove: [] } }));
  const calls = mockSlack(t, { stored: [withStatus("DONE")] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, environment);
  assert.equal(asked.length, 0);
  assert.equal(ephemeral(calls), undefined);
});

test("when AI fails, nothing is suggested from the words, but a pull request link is still linked, and who it mentions offered as reviewer", async (t) => {
  const { environment } = aiEnv(new Error("model unavailable"));
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, environment);
  assert.equal(suggestion(calls), undefined);

  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UMIA> please review ${PR}`), {}, environment);
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.deepEqual(noteValue(calls).changes, { people: { reviewer: { add: ["UMIA"], remove: [] } } });
});

test("with suggestions off, AI isn't asked and only commands work", async (t) => {
  const { environment, asked } = aiEnv(aiRead({ reviewer: { add: ["UMIA"], remove: [] } }));
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send(
    "/slack/events",
    threadEvent("<@UMIA> can you review this?"),
    {},
    { ...environment, TASK_CHANGE_DETECTION: "false" },
  );
  assert.equal(asked.length, 0);
  assert.equal(ephemeral(calls), undefined);
});

test("AI reads messages whenever the binding is there, with aiModel naming the one model", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = (settings) => [{ name: "acme", channel: "C0000000002", ...settings }];
  const config = (top, settings) => readConfig(JSON.stringify({ projects: projects(settings), ...top }));
  // The model is one for every project, at the top of the file; without it, the secret is empty.
  assert.equal(config({ aiModel: "@cf/qwen/qwen3-30b-a3b-fp8" }, {}).AI_MODEL_NAME, "@cf/qwen/qwen3-30b-a3b-fp8");
  assert.equal(config({}, {}).AI_MODEL_NAME, "");
  assert.throws(() => config({ aiModel: "gpt" }, {}), /aiModel is a Workers AI/);
  assert.throws(() => config({}, { aiModel: "@cf/x/y" }), /acme's aiModel is set once at the top of the file/);
  const { aiModel } = await import("../src/ai.ts");
  assert.equal(aiModel(fake({ AI: {} })), "@cf/zai-org/glm-4.7-flash");
  assert.equal(aiModel(fake({ AI: {}, AI_MODEL_NAME: "@cf/x/y" })), "@cf/x/y");
  assert.equal(aiModel(fake({ AI_MODEL_NAME: "@cf/x/y" })), null, "no binding");
});

test("AI only adds the author to a role when their message speaks of themselves", async (t) => {
  // The model adds the author to whatever the message is about.
  for (const [text, suggested] of [
    ["this is urgent, client needs it by Friday", false],
    ["lgtm, approved", false],
    ["<@UREX> can you build this? I'll do the review", true],
    ["on it", true],
  ] as const) {
    const { environment } = aiEnv(aiRead({ reviewer: { add: ["UACTOR"], remove: [] } }));
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text), {}, environment);
    assert.equal(Boolean(ephemeral(calls)), suggested, text);
  }
});

test("AI is given the dates of the coming week, for deadlines like Friday", async () => {
  const { comingDays } = await import("../src/ai.ts");
  const days = comingDays("2026-10-27");
  assert.equal(days.Friday, "2026-10-30");
  assert.equal(days.Tuesday, "2026-11-03");
  assert.equal(Object.keys(days).length, 7);
});

test("AI is given the dates of next week's days too, for deadlines like next Friday", async () => {
  const { nextWeekDays } = await import("../src/ai.ts");
  const days = nextWeekDays("2026-10-27");
  assert.equal(days["next Friday"], "2026-11-06");
  assert.equal(days["in a week"], "2026-11-03");
  assert.equal(days["in two weeks"], "2026-11-10");
});

test("AI blocks and unblocks only when the task's state and the message agree", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const people = { owner: [], reviewer: [], tester: [] };
  const allowed = { roles: [], blocked: true };
  const run = (task, text, raw) =>
    checkChanges(aiRead(raw), {
      task: { status: "IN_PROGRESS", people, ...task },
      message: { user: "UA", mentions: [], text },
      allowed,
    })?.blocked ?? null;
  assert.deepEqual(run({}, "blocked on the API keys", { blocked: "block", blockedReason: "waiting on the API keys" }), {
    on: true,
    reason: "waiting on the API keys",
  });
  assert.deepEqual(run({ blocked: true }, "keys arrived, unblocked", { blocked: "unblock" }), { on: false });
  // Already in that state, or a question: nothing.
  assert.equal(run({ blocked: true }, "still blocked", { blocked: "block" }), null);
  assert.equal(run({}, "unblocked", { blocked: "unblock" }), null);
  assert.equal(run({}, "are we blocked on design?", { blocked: "block" }), null);
  // Off when blocked suggestions are.
  assert.equal(
    checkChanges(aiRead({ blocked: "block" }), {
      task: fake<StoredTask>({ status: "TODO", people }),
      message: { user: "UA", mentions: [], text: "blocked" },
      allowed: { roles: [] },
    }),
    null,
  );
});

test("AI moves a task's status forward only, never back or sideways", async () => {
  const { checkChanges, laterStatuses } = await import("../src/ai.ts");
  const message = fake<PlainMessage>({ user: "UACTOR", mentions: [] });
  const allowed: Allowed = { roles: [], status: true, details: false };
  const at = (status: Status) =>
    fake<StoredTask>({ status, priority: "High", dueDate: "", people: { owner: [], reviewer: [], tester: [] } });
  assert.deepEqual(laterStatuses("IN_REVIEW"), ["IN_TESTING", "CLIENT_REVIEW", "DONE"]);
  assert.deepEqual(laterStatuses("DONE"), []);
  // Forward, even by several steps, is offered.
  assert.deepEqual(checkChanges(aiRead({ status: "IN_TESTING" }), { task: at("IN_REVIEW"), message, allowed }), {
    status: "IN_TESTING",
  });
  assert.deepEqual(checkChanges(aiRead({ status: "DONE" }), { task: at("IN_PROGRESS"), message, allowed }), {
    status: "DONE",
  });
  // Back, or the same status, is not.
  for (const [from, to] of [
    ["IN_REVIEW", "IN_PROGRESS"],
    ["IN_TESTING", "TODO"],
    ["DONE", "IN_REVIEW"],
    ["IN_REVIEW", "IN_REVIEW"],
  ] as const) {
    assert.equal(checkChanges(aiRead({ status: to }), { task: at(from), message, allowed }), null, `${from} -> ${to}`);
  }
});

test("AI doesn't move a task's status for work done on only a part of it", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const allowed: Allowed = { roles: [], status: true, details: false };
  const task = fake<StoredTask>({
    status: "IN_PROGRESS",
    priority: "High",
    dueDate: "",
    people: { owner: [], reviewer: [], tester: [] },
  });
  const read = (text: string) =>
    checkChanges(aiRead({ status: "IN_TESTING" }), { task, message: { user: "UACTOR", mentions: [], text }, allowed });
  for (const text of [
    "the login part is done",
    "subtask 2 is in testing",
    "backend merged, frontend pending",
    "finished the first step",
    "half of it is ready for QA",
    "the API is done",
  ]) {
    assert.equal(read(text), null, text);
  }
  assert.deepEqual(read("all done, ready for QA"), { status: "IN_TESTING" });
});
