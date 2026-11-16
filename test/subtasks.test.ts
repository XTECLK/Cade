import assert from "node:assert/strict";
import test from "node:test";
import { getTask } from "../src/db.ts";
import { changeTask } from "../src/commands/changes.ts";
import { editForm } from "../src/commands/edit.ts";
import type { AppEnv } from "../src/env.ts";
import type { StoredTask } from "../src/types.ts";
import { fake } from "./helpers.ts";
import {
  type Stored,
  T1,
  T2,
  T3,
  add,
  aiSuggestion,
  allBlocks,
  answerPrivately,
  asAdmin,
  blockText,
  canvasMarkdown,
  canvasResponses,
  cardButtons,
  cardLink,
  cardMenu,
  cardMenuClick,
  duplicateActionIds,
  env,
  footerLines,
  historyTask,
  incidentHistoryTask,
  incidentTask,
  interaction,
  mockSlack,
  ownTask,
  runTasksCommand,
  savedTask,
  seeded,
  send,
  subtaskOf,
  suggestedChanges,
  summaryRows,
  taskWith,
  threadEvent,
} from "./app.ts";

// Clicking a card's Subtasks button, on the task at CDEV/`ts`; then Add subtask under the list it opens.
const subtasksClick = (ts = "100.1") =>
  interaction({
    type: "block_actions",
    trigger_id: "T1",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    message: { ts },
    actions: [{ action_id: "task:subtasks" }],
  });
const addFromList = (list, user = "UACTOR") => {
  const button = list.blocks.at(-1).elements[0];
  return interaction({
    type: "block_actions",
    trigger_id: "T2",
    user: { id: user },
    view: { id: "VLIST" },
    actions: [{ action_id: button.action_id, value: button.value }],
  });
};

test("a task with subtasks gets no status suggestion for a part, but its pull requests and people are still suggested", async (t) => {
  // A real subtask of the task (100.1), which makes it done in parts.
  const withSubtasks = (record) => [record, subtaskOf("100.2")];
  for (const [text, record, raw, changes] of [
    // A part reaching a stage isn't the whole task reaching it.
    ["lgtm", withSubtasks(taskWith("IN_REVIEW", { reviewers: ["UACTOR"] })), { status: "IN_TESTING" }, null],
    // People still are, and the status that would come with asking for a test is left out.
    [
      "<@UTOM> please test it",
      withSubtasks(taskWith("IN_PROGRESS")),
      { tester: add("UTOM"), status: "IN_TESTING" },
      { people: { tester: add("UTOM") } },
    ],
    // Without subtasks the same answer moves the status.
    ["lgtm", taskWith("IN_REVIEW", { reviewers: ["UACTOR"] }), { status: "IN_TESTING" }, { status: "IN_TESTING" }],
  ] as const) {
    const { question } = await aiSuggestion(t, text, record, raw);
    assert.deepEqual(question ? suggestedChanges(question) : null, changes, text);
  }
});

test("the Edit form has no Has subtasks box, and a form opened before it went changes nothing for it", async (t) => {
  const record = ownTask({ owners: ["UREX"] });
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/interactions", cardMenuClick("edit"));
  const form = calls[0].args.view;
  assert.equal(
    form.blocks.some((block) => block.block_id === "subtasks"),
    false,
  );
  // An Edit form opened before the box went still sends it; it's ignored.
  const values = {
    owner: { value: { selected_users: ["UREX"] } },
    reviewer: { value: { selected_users: [] } },
    tester: { value: { selected_users: [] } },
    status: { value: { selected_option: { value: "TODO" } } },
    priority: { value: { selected_option: { value: "High" } } },
    due_date: { value: { selected_date: null } },
    prs: { value: { value: "" } },
    subtasks: { value: { selected_options: [{ value: "subtasks" }] } },
  };
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: { callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values } },
    }),
  );
  assert.equal("subtasks" in (await savedTask()), false);
  assert.ok(!calls.some((call) => /Has subtasks|having subtasks/.test(JSON.stringify(call.args))));
});

// A card's text, every block's, a line each.
const cardText = (args) =>
  allBlocks(args)
    .map((block) => blockText(block) ?? "")
    .join("\n");

// The choices on the ⋯ menu of a card Cade posted or updated.
const menuChoices = (args) => cardMenu(args).options.map((option) => option.text.text);

test("Add subtask, under the card's list of subtasks, makes a subtask with the task's people, in its own thread, and the task's card counts it", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask({ owners: ["UREX"], testers: ["UTESS"] })],
    "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: args.channel, ts: "200.1" }),
    "chat.getPermalink": { permalink: "https://slack.example/p200" },
    "conversations.replies": { messages: [] },
    "users.info": (args) => ({ user: { real_name: { UTESS: "Tess" }[args.user] } }),
  });
  // Subtasks opens the list, empty for now, with Add subtask under it.
  await send("/slack/interactions", subtasksClick());
  const list = calls.find((call) => call.method === "views.open").args.view;
  assert.match(list.blocks.map((block) => blockText(block) ?? "").join("\n"), /No subtasks yet\./);
  assert.equal(list.blocks.at(-1).elements[0].text.text, "Add subtask");
  // Add subtask opens the form over the list.
  await send("/slack/interactions", addFromList(list));
  const pushed = calls.find((call) => call.method === "views.push").args;
  assert.equal(pushed.trigger_id, "T2");
  const form = pushed.view;
  assert.equal(form.callback_id, "subtask:add");
  assert.match(blockText(form.blocks[0]), /Subtask of \*Fix login\*/);
  // It starts with the task's due date, which can be changed, and has its priority, which can't.
  assert.match(blockText(form.blocks[0]), /with its priority, :large_orange_circle: High/);
  const field = (id) => form.blocks.find((block) => block.block_id === id)?.element;
  assert.equal(field("due_date").initial_date, "2026-10-31");
  assert.equal(field("priority"), undefined);

  calls.length = 0;
  const values = {
    title: { value: { value: "Fails on Safari" } },
    due_date: { value: { selected_date: "2026-11-20" } },
  };
  // Sending it closes the form and the list under it.
  const sent = await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UTESS" },
      view: { callback_id: "subtask:add", private_metadata: form.private_metadata, state: { values } },
    }),
  );
  assert.deepEqual(await sent.json(), { response_action: "clear" });

  // Its own card, naming the task, with no Subtasks button: they go one level deep.
  const card = calls.find((call) => call.method === "chat.postMessage" && !call.args.thread_ts).args;
  assert.match(cardText(card), /^\[HIGH\] \*Fails on Safari\*\n:arrow_right_hook: Subtask of \*Fix login\*\n/);
  assert.deepEqual(
    cardButtons(card).map((element) => element.action_id),
    ["task:edit", "task:prs", "task:menu"],
  );
  assert.deepEqual(menuChoices(card), ["Archive"]);
  const subtask = (await getTask(env, "CDEV", "200.1"))!;
  assert.deepEqual(
    [subtask.parent?.ts, subtask.priority, subtask.dueDate, subtask.people.owner, subtask.people.tester],
    ["100.1", "High", "20/11/2026", ["UREX"], ["UTESS"]],
  );
  // The task's thread hears of it, by name, notifying no one, and its card counts it.
  const told = calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").args;
  assert.equal(
    told.text,
    "@Tess added a subtask: <https://slack.example/p200|Fails on Safari>. It's tracked in its own thread.",
  );
  const parent = calls.filter((call) => call.method === "chat.update" && call.args.ts === "100.1").at(-1).args;
  assert.match(cardText(parent), /\nSubtasks: 1 open  ·  0 closed\n/);
  assert.deepEqual(menuChoices(parent), ["Archive"]);
});

test("Add subtask on a subtask, from an older card's menu or a list opened before, says they go one level deep", async (t) => {
  const subtask = subtaskOf("100.2");
  const calls = mockSlack(t, { stored: [ownTask(), subtask] });
  await send(
    "/slack/interactions",
    interaction({
      ...JSON.parse(new URLSearchParams(cardMenuClick("subtask")).get("payload")!),
      message: { ts: "100.2" },
    }),
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postEphemeral"],
  );
  assert.match(calls[0].args.text, /subtasks don't have their own/);
  // Add subtask in a list naming a task that has since become a subtask says so over the list.
  calls.length = 0;
  const list = {
    blocks: [
      {
        type: "actions",
        elements: [{ action_id: "subtasks:add", value: JSON.stringify({ channel: "CDEV", ts: "100.2" }) }],
      },
    ],
  };
  await send("/slack/interactions", addFromList(list));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["views.push"],
  );
  assert.match(blockText(calls[0].args.view.blocks[0]), /subtasks don't have their own/);
});

test("a subtask moving to Done moves it from open to closed on its task's card", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask(), subtaskOf("100.2", { status: "IN_TESTING" }), subtaskOf("100.3", { title: "Wrong total" })],
  });
  await send("/slack/events", threadEvent("<@UBOT> status done", { thread_ts: "100.2" }));
  const parent = calls.filter((call) => call.method === "chat.update" && call.args.ts === "100.1").at(-1).args;
  assert.match(cardText(parent), /\nSubtasks: 1 open  ·  1 closed\n/);
});

test("Subtasks lists a task's subtasks, open first, each linking to its thread, then Add subtask", async (t) => {
  const calls = mockSlack(t, {
    stored: [
      ownTask(),
      subtaskOf("100.2", { title: "Closed one", status: "DONE", link: "https://slack.example/p1002" }),
      subtaskOf("100.3", {
        title: "Open one",
        status: "IN_PROGRESS",
        owners: ["UREX"],
        link: "https://slack.example/p1003",
      }),
    ],
  });
  await send("/slack/interactions", subtasksClick());
  const view = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(view.title.text, "Subtasks");
  assert.deepEqual(JSON.parse(view.blocks.at(-1).elements[0].value), { channel: "CDEV", ts: "100.1" });
  const text = view.blocks.map((block) => blockText(block) ?? "").join("\n");
  assert.match(text, /Subtasks: 1 open  ·  1 closed/);
  // Each in three lines, as on the Home tab: its title; its priority, status and due date; its people.
  assert.match(
    text,
    /\*Open \(1\)\*\n\*<https:\/\/slack\.example\/p1003\|Open one>\*\n:[a-z_]+: \w+  ·  :arrow_forward: In progress[^\n]*\nOwner <@UREX>\n\n\*Closed \(1\)\*\n\*<https:\/\/slack\.example\/p1002\|Closed one>\*\n[^\n]+  ·  :white_check_mark: Done/,
  );
});

test("the summary lists subtasks under their task, wherever its urgency puts it", async (t) => {
  const calls = mockSlack(t, {
    ...canvasResponses,
    stored: [
      historyTask("100.1", { title: "Parent", priority: "Low" }),
      historyTask("100.2", { title: "Other", priority: "High" }),
      subtaskOf("100.3", { title: "Done part", status: "DONE", completedAt: "2026-10-10T09:00:00.000Z" }),
      subtaskOf("100.4", { title: "Urgent part", priority: "Urgent" }),
    ],
  });
  await runTasksCommand("resync summary", "CDEV");
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  const titles = (section) =>
    summaryRows(markdown, section).map((row) =>
      row
        .match(/^\| (↳ )?\[([^\]]+)\]/)
        .slice(1)
        .join(""),
    );
  assert.deepEqual(titles("Open"), ["Other", "Parent", "↳ Urgent part", "↳ Done part"]);
  assert.deepEqual(titles("Closed"), []);
});

test("the Home tab lists subtasks under their task, which a subtask of yours brings to My Tasks", async (t) => {
  const stored = [
    historyTask("100.1", { title: "Checkout redesign", owners: ["UOTHER"], status: "IN_TESTING" }),
    subtaskOf("100.2", { title: "Payment fails", owners: ["UME"], status: "IN_PROGRESS" }),
    subtaskOf("100.3", { title: "Fixed already", owners: ["UME"], status: "DONE" }),
    subtaskOf("100.4", { title: "Someone else's part", owners: ["UOTHER"] }),
  ];
  const view = async (action_id: string) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    await send(
      "/slack/interactions",
      interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id }] }),
    );
    const { blocks } = calls.find((call) => call.method === "views.publish").args.view;
    assert.deepEqual(duplicateActionIds(blocks), []);
    return blocks.map((block) => blockText(block) ?? "").join("\n");
  };
  // My Tasks: the task, though not theirs, with only their subtask under it.
  const mine = await view("home:tab:mine");
  // Each subtask as a card of its own under it: ↪ and its title, then its details, then its people.
  assert.match(
    mine,
    /:hammer_and_wrench: To work on \(1\)\n\*<[^|]+\|Checkout redesign>\*\n[^\n]+\nOwner <@UOTHER>\n_Your subtasks:_\n:arrow_right_hook: \*<[^|]+\|Payment fails>\*\n:large_orange_circle: High  ·  :arrow_forward: In progress  ·  [^\n]*\nOwner you\n/,
  );
  assert.doesNotMatch(mine, /Someone else's part|Fixed already/);
  // All Tasks: each subtask once, under its task, with how many are done.
  const all = await view("home:tab:all");
  assert.equal(all.match(/\|Payment fails>/g)?.length, 1);
  assert.match(all, /\|Checkout redesign>\*\n[^]*\|Payment fails>[^]*\|Someone else's part>[^]*_\+1 done_/);

  // The task's owner sees all its open subtasks under it, whoever's they are.
  stored[0] = historyTask("100.1", { title: "Checkout redesign", owners: ["UME"], status: "IN_TESTING" });
  const owner = await view("home:tab:mine");
  assert.match(
    owner,
    /\|Checkout redesign>\*\n[^\n]+\nOwner you\n:arrow_right_hook: \*<[^|]+\|Payment fails>\*\n[^\n]+\nOwner you\n:arrow_right_hook: \*<[^|]+\|Someone else's part>\*\n[^\n]+\nOwner <@UOTHER>\n_\+1 done_/,
  );
  assert.doesNotMatch(owner, /Your subtasks/);
  assert.equal(owner.match(/\|Payment fails>/g)?.length, 1);
});

test("a task done in parts by its subtasks is moved by no message about a part", async () => {
  const { statusFits } = await import("../src/ai.ts");
  const task = (subtaskCounts?: { open: number; closed: number }) =>
    fake<StoredTask>({ status: "IN_PROGRESS", subtaskCounts });
  assert.equal(statusFits("IN_REVIEW", task(), "PR is up"), true);
  assert.equal(statusFits("IN_REVIEW", task({ open: 1, closed: 0 }), "PR is up"), false);
});

test("a subtask of an incident is an incident too, asking only for its title, Urgent and due Immediate for good", async (t) => {
  const calls = mockSlack(t, {
    stored: [incidentTask({ owners: ["UREX"] })],
    "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: args.channel, ts: "200.1" }),
    "chat.getPermalink": { permalink: "https://slack.example/p200" },
    "conversations.replies": { messages: [] },
  });
  await send("/slack/interactions", cardMenuClick("subtask"));
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.deepEqual(
    form.blocks.filter((block) => block.type === "input").map((block) => block.block_id),
    ["title"],
  );
  assert.match(blockText(form.blocks[0]), /Urgent and due Immediate/);
  const values = { title: { value: { value: "Restart the payment worker" } } };
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UREX" },
      view: { callback_id: "subtask:add", private_metadata: form.private_metadata, state: { values } },
    }),
  );
  const subtask = (await getTask(env, "CDEV", "200.1"))!;
  assert.deepEqual(
    [subtask.priority, subtask.dueDate, subtask.incident, subtask.parent?.ts],
    ["Urgent", "Immediate", true, "100.1"],
  );
  // Its Edit form leaves out the priority and due date, as an incident's does.
  const edit = editForm({ channel: "CDEV", ts: "200.1" }, subtask);
  assert.deepEqual(
    edit.blocks.map((block) => block.block_id).filter((id) => id === "priority" || id === "due_date"),
    [],
  );
});

test("a subtask with no owner of its own shows its task's owner, on its card and the Home tab, until it has one", async (t) => {
  const stored = [
    historyTask("100.1", { title: "Checkout redesign", owners: ["UME"] }),
    subtaskOf("100.2", { title: "Payment fails", testers: ["UTESS"] }),
  ];
  const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await send("/slack/events", threadEvent("<@UBOT> status in progress", { thread_ts: "100.2" }));
  const card = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.2").args;
  assert.equal(footerLines(card)[0], "Owner <@UME>  ·  Test <@UTESS>");
  // It isn't stored as theirs, so it follows the task's owner: a new one redraws the subtask's card.
  assert.deepEqual((await getTask(env, "CDEV", "100.2"))!.people.owner, []);
  calls.length = 0;
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UREX>", { thread_ts: "100.1" }));
  const redrawn = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.2").args;
  assert.match(footerLines(redrawn)[0], /^Owner <@UME>, <@UREX>/);
});

test("Unassigned on the Home tab lists only tasks with no one on them, with their subtasks under them", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      historyTask("100.1", { title: "Taken task", owners: ["UOTHER"] }),
      subtaskOf("100.2", { title: "Ownerless part" }),
      historyTask("100.3", { title: "Nobody's task" }),
      subtaskOf("100.4", { title: "Its part", owners: ["UOTHER"], parent: { ts: "100.3", title: "Nobody's task" } }),
    ],
  });
  await send(
    "/slack/interactions",
    interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:unassigned" }] }),
  );
  const { blocks } = calls.find((call) => call.method === "views.publish").args.view;
  const text = blocks.map((block) => blockText(block) ?? "").join("\n");
  assert.doesNotMatch(text, /Taken task|Ownerless part/);
  assert.match(text, /\|Nobody's task>\*\n[^]*:arrow_right_hook: \*<[^|]+\|Its part>\*\n[^\n]+\nOwner <@UOTHER>/);
  const buttons = blocks
    .flatMap((block) => block.elements ?? [])
    .filter((element) => element.type === "button" && element.action_id.startsWith("home:claim"));
  assert.deepEqual(
    buttons.map((button) => [button.action_id, button.text.text]),
    [["home:claim:CDEV:100.3", "Assign to me"]],
  );
});

test("Coming up on My Tasks lists a task's subtasks under it, so they need no label", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      historyTask("100.1", { title: "Checkout redesign", owners: ["UOTHER"] }),
      subtaskOf("100.2", { title: "Payment fails", testers: ["UME"], status: "IN_PROGRESS" }),
    ],
  });
  await send(
    "/slack/interactions",
    interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:mine" }] }),
  );
  const text = calls
    .find((call) => call.method === "views.publish")
    .args.view.blocks.map((block) => blockText(block) ?? "")
    .join("\n");
  assert.match(
    text,
    /\*Coming up\*\n<[^|]+\|Checkout redesign>  ·  :memo: To do\n:arrow_right_hook: <[^|]+\|Payment fails>  ·  :arrow_forward: In progress/,
  );
  assert.doesNotMatch(text, /subtask of/i);
});

test("a task with open subtasks doesn't move to Client review or Done: whoever tried is warned, privately", async (t) => {
  for (const status of ["done", "client review"]) {
    const calls = mockSlack(t, {
      stored: [
        ownTask({ status: "IN_TESTING" }),
        subtaskOf("100.2", { title: "Payment fails", link: "https://slack.example/p1002" }),
        subtaskOf("100.3", { status: "DONE" }),
      ],
    });
    await send("/slack/events", threadEvent(`<@UBOT> status ${status}`));
    assert.equal((await savedTask())!.status, "IN_TESTING");
    // No ✅, and nothing in the thread: only the warning, to them.
    assert.ok(
      !calls.some(
        (call) =>
          call.method === "reactions.add" || call.method === "chat.postMessage" || call.method === "chat.update",
      ),
    );
    const warning = calls.find((call) => call.method === "chat.postEphemeral").args;
    assert.deepEqual([warning.user, warning.thread_ts], ["UACTOR", "100.1"]);
    assert.match(
      warning.text,
      /^:warning: 1 subtask is still open: <https:\/\/slack\.example\/p1002\|Payment fails>\. A task moves to .* only once all its subtasks are done/,
    );
    assert.deepEqual(
      warning.blocks[1].elements.map((button) => button.text.text),
      ["Close all subtasks", "Cancel"],
    );
  }
  // Any other status, and a task with every subtask done, move as before.
  mockSlack(t, { stored: [ownTask({ status: "IN_TESTING" }), subtaskOf("100.3", { status: "DONE" })] });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.equal((await savedTask())!.status, "DONE");
});

test("Edit saves the rest when its status waits for subtasks, and says so in the warning", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask({ status: "IN_TESTING" }), subtaskOf("100.2")] });
  await seeded;
  await changeTask(env, { channel: "CDEV", ts: "100.1" }, { status: "DONE", priority: "Low" }, "UACTOR");
  const task = (await savedTask())!;
  assert.deepEqual([task.status, task.priority], ["IN_TESTING", "Low"]);
  assert.match(calls.find((call) => call.method === "chat.postEphemeral").args.text, /Your other changes are saved\.$/);
});

test("Close all subtasks moves each to Done, then the task where it was going; Cancel just removes the warning", async (t) => {
  const calls = mockSlack(t, {
    stored: [
      ownTask({ status: "IN_TESTING" }),
      subtaskOf("100.2"),
      subtaskOf("100.3", { title: "Wrong total", status: "IN_PROGRESS" }),
    ],
  });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  const warning = calls.find((call) => call.method === "chat.postEphemeral").args;
  calls.length = 0;
  const responses = await answerPrivately(t, warning, "subtasks:close");
  for (const ts of ["100.2", "100.3"]) assert.equal((await getTask(env, "CDEV", ts))!.status, "DONE", ts);
  assert.equal((await savedTask())!.status, "DONE");
  // Each subtask's thread hears it, then the task's, once for all of them, then that it moved.
  const told = calls
    .filter((call) => call.method === "chat.postMessage")
    .map((call) => [call.args.thread_ts, call.args.text]);
  assert.deepEqual(
    told.map(([ts]) => ts),
    ["100.2", "100.3", "100.1", "100.1"],
  );
  assert.equal(told[2]![1], "<@UACTOR> closed all its subtasks: *Fails on Safari*, *Wrong total*.");
  assert.deepEqual(responses.at(-1), {
    response_type: "ephemeral",
    replace_original: true,
    text: "Closed 2 subtasks and moved the task to :white_check_mark: Done.",
  });

  mockSlack(t, { stored: [ownTask({ status: "IN_TESTING" }), subtaskOf("100.2")] });
  const cancelled = await answerPrivately(t, warning, "subtasks:cancel");
  assert.deepEqual(cancelled.at(-1), { response_type: "ephemeral", delete_original: true });
  assert.equal((await savedTask())!.status, "IN_TESTING");
});

test("@Cade subtask <title> adds a subtask with the task's due date and priority, and links it in the thread", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask({ owners: ["UREX"] })],
    "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: args.channel, ts: "200.1" }),
    "chat.getPermalink": { permalink: "https://slack.example/p200" },
    "conversations.replies": { messages: [] },
  });
  await send("/slack/events", threadEvent("<@UBOT> subtask Fails on   Safari"));
  const subtask = (await getTask(env, "CDEV", "200.1"))!;
  assert.deepEqual(
    [subtask.title, subtask.dueDate, subtask.priority, subtask.people.owner, subtask.parent?.ts],
    ["Fails on Safari", "31/10/2026", "High", ["UREX"], "100.1"],
  );
  assert.ok(calls.some((call) => call.method === "reactions.add" && call.args.name === "white_check_mark"));
  const told = calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").args;
  assert.equal(
    told.text,
    "<@UACTOR> added a subtask: <https://slack.example/p200|Fails on Safari>. It's tracked in its own thread.",
  );

  // Without a title it says what to send; in a subtask's thread, that they go one level deep.
  const empty = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/events", threadEvent("<@UBOT> subtask"));
  assert.match(empty.find((call) => call.method === "chat.postMessage").args.text, /Give the subtask a title/);
  const nested = mockSlack(t, { stored: [ownTask(), subtaskOf("100.2")] });
  await send("/slack/events", threadEvent("<@UBOT> subtask Another", { thread_ts: "100.2" }));
  assert.match(nested.find((call) => call.method === "chat.postMessage").args.text, /subtasks don't have their own/);
});
// A subtask of the task at T1 ("Main"), at `ts`.
const subtaskOfT1 = (ts: string, fields: Record<string, unknown> = {}) =>
  subtaskOf(ts, { parent: { ts: T1, title: "Main" }, ...fields });

test("/cade subtask link makes an older task a subtask, for admins only, and isn't in help", async (t) => {
  const calls = mockSlack(t, {
    stored: [
      historyTask(T1, { title: "Checkout redesign", owners: ["UMIA"] }),
      historyTask(T2, {
        title: "Payment fails",
        priority: "Low",
        dueDate: "01/12/2026",
        owners: ["UREX"],
        link: "https://slack.example/p2",
      }),
    ],
  });
  const { later } = await runTasksCommand(`subtask link ${cardLink(T2)} ${cardLink(T1)}`, "CDEV", asAdmin);
  assert.equal(later.text, "Made <https://slack.example/p2|Payment fails> a subtask of *Checkout redesign*.");
  // It keeps its own due date and people, and takes the main task's priority; both cards show the link.
  const subtask = (await getTask(env, "CDEV", T2))!;
  assert.deepEqual(
    [subtask.parent?.ts, subtask.priority, subtask.dueDate, subtask.people.owner],
    [T1, "High", "01/12/2026", ["UREX"]],
  );
  const card = (ts) =>
    cardText(calls.filter((call) => call.method === "chat.update" && call.args.ts === ts).at(-1).args);
  assert.match(card(T2), /:arrow_right_hook: Subtask of \*Checkout redesign\*/);
  assert.match(card(T1), /Subtasks: 1 open  ·  0 closed/);
  // The main task's thread hears it as it does a new subtask.
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === T1).args.text,
    "<@UACTOR> added a subtask: <https://slack.example/p2|Payment fails>. It's tracked in its own thread.",
  );

  // Unlinked, it is a task of its own again.
  calls.length = 0;
  const undone = await runTasksCommand(`subtask unlink ${cardLink(T2)}`, "CDEV", asAdmin);
  assert.equal(undone.later.text, "Made <https://slack.example/p2|Payment fails> a task of its own again.");
  assert.equal((await getTask(env, "CDEV", T2))!.parent, undefined);
  assert.doesNotMatch(card(T1), /Subtasks:/);

  // Not for anyone else, and not listed.
  const refused = await runTasksCommand(`subtask link ${cardLink(T2)} ${cardLink(T1)}`, "CDEV", {
    ...env,
    ADMINS: "[]",
  } as AppEnv);
  assert.equal(JSON.parse(refused.now).text, "Only Cade's admins can do that.");
  const help = await runTasksCommand("help", "CDEV", asAdmin);
  assert.doesNotMatch(help.now, /subtask link/);
});

test("/cade subtask link keeps the rules a new subtask follows", async (t) => {
  const tryLink = async (stored: Stored[], child: string, parent: string) => {
    mockSlack(t, { stored });
    return (await runTasksCommand(`subtask link ${cardLink(child)} ${cardLink(parent)}`, "CDEV", asAdmin)).later.text;
  };
  const main = historyTask(T1, { title: "Main" });
  const other = historyTask(T3, { title: "Other" });
  assert.match(await tryLink([main, subtaskOfT1(T2), other], T3, T2), /is a subtask itself/);
  assert.match(await tryLink([main, subtaskOfT1(T2), other], T1, T3), /has subtasks of its own/);
  assert.match(
    await tryLink([historyTask(T1, { title: "Main", status: "DONE" }), other], T3, T1),
    /waits for all its subtasks to be done/,
  );
  assert.match(
    await tryLink([main, incidentHistoryTask(T3, { title: "Down" })], T3, T1),
    /an incident's main task must be one too/,
  );
  // Under an incident, a task becomes one.
  assert.match(await tryLink([incidentHistoryTask(T1, { title: "Down" }), other], T3, T1), /It's an incident now/);
  const made = (await getTask(env, "CDEV", T3))!;
  assert.deepEqual([made.incident, made.priority, made.dueDate], [true, "Urgent", "Immediate"]);
});

test("closing or reopening a subtask tells its task's thread how its subtasks stand; other moves don't", async (t) => {
  const calls = mockSlack(t, {
    stored: [
      ownTask({ status: "IN_TESTING" }),
      subtaskOf("100.2", { link: "https://slack.example/p2" }),
      subtaskOf("100.3", { title: "Wrong total" }),
    ],
    "users.info": { user: { real_name: "Ann" } },
  });
  const told = () =>
    calls
      .filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1")
      .map((call) => call.args.text);
  await send("/slack/events", threadEvent("<@UBOT> status in progress", { thread_ts: "100.2" }));
  assert.deepEqual(told(), []);
  await send("/slack/events", threadEvent("<@UBOT> status done", { thread_ts: "100.2" }));
  // By name, notifying no one.
  assert.deepEqual(told(), [
    "@Ann closed the subtask <https://slack.example/p2|Fails on Safari>. Subtasks: 1 open  ·  1 closed.",
  ]);
  calls.length = 0;
  await send("/slack/events", threadEvent("<@UBOT> status in testing", { thread_ts: "100.2" }));
  assert.deepEqual(told(), [
    "@Ann reopened the subtask <https://slack.example/p2|Fails on Safari>. Subtasks: 2 open  ·  0 closed.",
  ]);
});

test("a subtask has its task's priority: not on its forms, nor changed by a command, and it follows the task's", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask(), subtaskOf("100.2", { priority: "High" })] });
  await seeded;
  // Its Edit form has the due date but not the priority.
  const ids = editForm({ channel: "CDEV", ts: "100.2" }, (await getTask(env, "CDEV", "100.2"))!).blocks.map(
    (block) => block.block_id,
  );
  assert.ok(ids.includes("due_date") && !ids.includes("priority"));
  // @Cade priority in its thread says where to change it, and changes nothing.
  await send("/slack/events", threadEvent("<@UBOT> priority low", { thread_ts: "100.2" }));
  assert.match(calls.find((call) => call.method === "chat.postMessage").args.text, /A subtask has its task's priority/);
  assert.equal((await getTask(env, "CDEV", "100.2"))!.priority, "High");
  // The task's priority changing brings it along, and redraws its card.
  calls.length = 0;
  await send("/slack/events", threadEvent("<@UBOT> priority urgent"));
  assert.equal((await getTask(env, "CDEV", "100.2"))!.priority, "Urgent");
  assert.match(
    cardText(calls.find((call) => call.method === "chat.update" && call.args.ts === "100.2").args),
    /^\[URGENT\] \*Fails on Safari\*/,
  );
});
