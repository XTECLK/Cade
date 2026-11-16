import assert from "node:assert/strict";
import test from "node:test";
import type { Project } from "../src/channels.ts";
import {
  RESPONSE_URL,
  TARGET,
  allBlocks,
  blockText,
  devStray,
  devTask,
  env,
  footerLines,
  interaction,
  messageLink,
  mockSlack,
  moveSlack,
  projectOptions,
  recordResponses,
  savedTask,
  send,
  shortcutClick,
  statusLine,
  storedTask,
  submission,
  threadEvent,
} from "./app.ts";

// `@Cade move`, replied in the stray message's thread.
const moveEvent = (overrides = {}) => threadEvent("<@UBOT> move", { ts: "100.8", thread_ts: "100.7", ...overrides });

// Clicks Move on the picker, with `picked` (a task's ts) chosen.
const moveClick = (picked, actionId = "move:confirm") =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    state: { values: { "move:target": { "move:pick": { selected_option: picked ? { value: picked } : null } } } },
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.7" }) }],
  });

// Cade's note under a message it moved already.
const movedNote = {
  ts: "100.71",
  bot_id: "BCADE",
  text: "<@UACTOR> moved this message to the task thread <https://slack.example/100.9|Fix login>. Please carry on the conversation there.",
};

const optionsOf = (element) => element.options.map((option) => [option.text.text, option.value]);

test("@Cade move without a link says to add one, or use Move to existing", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  await send("/slack/events", moveEvent());
  assert.match(calls.at(-1).args.text, /^Add the link to the task: `@Cade move <link>`.*Move to existing\.$/);
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("@Cade move says why it can't move a message", async (t) => {
  for (const [event, stored, root, text] of [
    [
      moveEvent({ ts: "100.7", thread_ts: undefined }),
      [],
      devStray,
      "Reply `@Cade move` in the thread of the message you want to move.",
    ],
    [moveEvent({ thread_ts: "100.1" }), [storedTask()], devStray, "This is already a task thread."],
    [moveEvent(), [], { ...devStray, bot_id: "BOTHER" }, "I can only move people's messages."],
  ] as const) {
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    await send("/slack/events", event);
    assert.equal(calls.at(-1).args.text, text);
  }

  // A message moved already is pointed to, privately.
  const calls = mockSlack(t, moveSlack(devStray, [movedNote]));
  await send("/slack/events", moveEvent());
  assert.equal(calls.at(-1).method, "chat.postEphemeral");
  assert.equal(calls.at(-1).args.text, "This message was already moved: <https://slack.example/100.9|see it there>.");
});

test("Move copies the message into the task's thread and points the original there", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick("100.1"));
  const posts = calls
    .filter((call) => call.method === "chat.postMessage")
    .map((call) => [call.args.channel, call.args.thread_ts, call.args.text]);
  assert.deepEqual(posts, [
    [
      "CDEV",
      "100.1",
      "Moved from <@UACTOR>'s <https://slack.example/100.7?thread_ts=100.7&cid=CDEV|message>:\n> The login bug also hits SSO\n> for some people",
    ],
    [
      "CDEV",
      "100.7",
      "<@UACTOR> moved this message to the task thread <https://slack.example/100.9|Fix login>. Please carry on the conversation there.",
    ],
  ]);
  assert.ok(
    calls.some(
      (call) => call.method === "reactions.add" && call.args.timestamp === "100.7" && call.args.name === "outbox_tray",
    ),
  );
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Move says an incident thread, notes attachments, and leaves a pinned message's pin alone", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack({ ...devStray, files: [{ id: "F1" }], pinned_to: ["CDEV"] }),
    stored: [devTask("100.1", "Checkout is down", "TODO", { incident: true })],
  });
  recordResponses(t);
  await send("/slack/interactions", moveClick("100.1"));
  const [copy, note] = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.text);
  assert.match(copy, /\n_There's more in the original\._$/);
  assert.match(note, /moved this message to the incident thread/);
  assert.ok(!calls.some((call) => call.method.startsWith("pins.")));
});

test("Move moves nothing if the task was closed or the message deleted since", async (t) => {
  for (const [stored, root, text] of [
    [
      [devTask("100.1", "Fix login", "DONE")],
      devStray,
      "That task has been closed or deleted since, so I didn't move anything.",
    ],
    [[devTask("100.1", "Fix login", "TODO")], null, "That message has been deleted since, so there's nothing to move."],
  ] as const) {
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    const responses = recordResponses(t);
    await send("/slack/interactions", moveClick("100.1"));
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
    assert.equal(responses[0].text, text);
  }
});

test("Move without a pick asks for one, and Cancel removes the picker", async (t) => {
  const calls = mockSlack(t, { stored: [devTask("100.1", "Fix login", "TODO")] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick(null));
  assert.equal(calls[0].args.text, "Pick where it goes first, then press Move.");
  await send("/slack/interactions", moveClick(null, "move:cancel"));
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("a move stands without its reaction, and a thread that's gone can't be moved", async (t) => {
  let calls = mockSlack(t, {
    ...moveSlack(),
    "reactions.add": { ok: false, error: "already_reacted" },
    stored: [devTask("100.1", "Fix login", "TODO")],
  });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick("100.1"));
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 2);
  assert.deepEqual(responses.at(-1), { response_type: "ephemeral", delete_original: true });

  calls = mockSlack(t, {
    "conversations.replies": { ok: false, error: "message_not_found" },
    stored: [devTask("100.1", "Fix login", "TODO")],
  });
  await send("/slack/events", moveEvent());
  assert.equal(calls.at(-1).args.text, "I can only move people's messages.");
});

test("@Cade move with a link moves the message there straight away and acknowledges it", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask(TARGET, "Fix login", "IN_PROGRESS")] });
  await send(
    "/slack/events",
    moveEvent({ text: `<@UBOT> move <${messageLink("CDEV", TARGET, `?thread_ts=${TARGET}&cid=CDEV`)}|link>` }),
  );
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.thread_ts),
    [TARGET, "100.7"],
  );
  assert.deepEqual(calls.at(-1).args, { channel: "CDEV", timestamp: "100.8", name: "white_check_mark" });
});

test("@Cade move with a link says why it can't move the message", async (t) => {
  for (const [stored, text] of [
    [[], "That link isn't to a task. Use Copy link on its message."],
    [[devTask(TARGET, "Fix login", "DONE")], "That task is done, so I didn't move anything."],
  ] as const) {
    const calls = mockSlack(t, { ...moveSlack(), stored });
    await send("/slack/events", moveEvent({ text: `<@UBOT> move <${messageLink("CDEV", TARGET)}>` }));
    assert.equal(calls.at(-1).args.text, text);
  }
});

test("Make new task and Make new incident open their forms, with the project outside a dev channel", async (t) => {
  for (const [callbackId, callback] of [
    ["convert", "track"],
    ["incident", "incident"],
  ]) {
    let calls = mockSlack(t);
    await send("/slack/interactions", shortcutClick(callbackId));
    let { view } = calls[0].args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].block_id, "project");
    assert.deepEqual(projectOptions(view), [
      ["acme", "CDEV"],
      ["test", "CTESTDEV"],
    ]);
    assert.equal(view.blocks.find((block) => block.block_id === "title").element.initial_value, "Customers can't pay");
    const origin = JSON.parse(view.private_metadata);
    assert.equal(origin.channel, undefined);
    assert.deepEqual(origin.move, {
      channel: "D0BOB",
      ts: "500.1",
      threadTs: "500.1",
      author: "UBOB",
      text: "Customers can't pay\nsince the deploy",
      files: false,
      link: "https://acme.slack.com/archives/D0BOB/p5001?thread_ts=500.1&cid=D0BOB",
    });

    // In a dev channel, that channel's project is chosen.
    calls = mockSlack(t, moveSlack());
    await send("/slack/interactions", shortcutClick(callbackId, devStray, "CDEV"));
    ({ view } = calls.find((call) => call.method === "views.open").args);
    assert.equal(view.blocks[0].block_id, "project");
    assert.equal(view.blocks[0].element.initial_option.value, "CDEV");
    assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");
  }
});

test("a task made from a message anywhere goes to the chosen project, and the message is copied into it", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), "reactions.add": { ok: false, error: "channel_not_found" } });
  const opened = mockSlack(t);
  await send("/slack/interactions", shortcutClick("convert"));
  const { view } = opened[0].args;
  const all = mockSlack(t, {
    ...moveSlack(),
    "chat.postMessage": (args) =>
      args.channel === "D0BOB" ? { ok: false, error: "channel_not_found" } : moveSlack()["chat.postMessage"](args),
  });

  // Without a project, the form says to choose one.
  const values = (project) => ({
    ...(project && { project: { value: { selected_option: { value: project } } } }),
    title: { value: { value: "Payments down" } },
    due_date: { value: { selected_date: null } },
    priority: { value: { selected_option: { value: "High" } } },
  });
  const submit = (project) =>
    send(
      "/slack/interactions",
      interaction({
        type: "view_submission",
        user: { id: "UACTOR" },
        view: { callback_id: "track", private_metadata: view.private_metadata, state: { values: values(project) } },
      }),
    );
  const refused = await (await submit(null)).json();
  assert.deepEqual(refused, { response_action: "errors", errors: { project: "Please choose a project." } });

  await submit("CTESTDEV");
  const posts = all
    .filter((call) => call.method === "chat.postMessage")
    .map((call) => [call.args.channel, call.args.thread_ts, call.args.text]);
  assert.deepEqual(posts.slice(0, 2), [
    ["CTESTDEV", undefined, "High task: Payments down"],
    [
      "CTESTDEV",
      "100.1",
      "Moved from <@UBOB>'s <https://acme.slack.com/archives/D0BOB/p5001?thread_ts=500.1&cid=D0BOB|message>:\n> Customers can't pay\n> since the deploy",
    ],
  ]);
  // Cade isn't in the DM, so the note under the original is tried and the
  // task stands without it.
  assert.deepEqual(posts[2].slice(0, 2), ["D0BOB", "500.1"]);
  assert.ok((await savedTask("CTESTDEV")).title, "Payments down");
  assert.equal(calls.length, 0);
});

test("Make new incident reports an urgent incident in the dev channel, labelled on its card", async (t) => {
  const calls = mockSlack(t, moveSlack());
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "incident",
        private_metadata: JSON.stringify({ channel: "CDEV", move: { channel: "CDEV", ts: "100.7" } }),
        state: { values: { title: { value: { value: "Checkout is down" } } } },
      },
    }),
  );
  const card = calls.find((call) => call.method === "chat.postMessage" && !call.args.thread_ts).args;
  assert.equal(card.text, "Urgent incident: Checkout is down");
  assert.equal(allBlocks(card)[0].text.text, "[URGENT] [Incident] *Checkout is down*");
  assert.equal(statusLine(card), ":memo: To do  ·  Due Immediate");
  assert.match(footerLines(card)[1], /^Reported by <@UACTOR>$/);
  const task = await savedTask();
  assert.deepEqual([task.incident, task.priority, task.dueDate], [true, "Urgent", "Immediate"]);
  const notes = calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.7");
  assert.match(notes[0].args.text, /moved this message to the incident thread/);
});

test("Move to existing outside a dev channel asks for the project, then lists its open tasks", async (t) => {
  const stored = [
    devTask("100.1", "Fix login", "IN_PROGRESS"),
    devTask("100.3", "Checkout is down", "TODO", { incident: true }),
  ];
  let calls = mockSlack(t, { stored });
  await send("/slack/interactions", shortcutClick("move"));
  let { view } = calls[0].args;
  assert.equal(view.callback_id, "move:form");
  // Two projects: none is picked, so there are no tasks to choose yet.
  assert.equal(view.blocks[0].dispatch_action, true);
  assert.equal(view.blocks[0].element.action_id, "move:project");
  assert.equal(view.blocks[0].element.initial_option, undefined);
  assert.equal(blockText(view.blocks[1]), "Choose a project to see its open tasks.");

  // Choosing a project lists its open tasks, incidents included.
  calls = mockSlack(t, { stored });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      view: {
        id: "V1",
        hash: "H1",
        private_metadata: view.private_metadata,
        state: { values: { project: { "move:project": { selected_option: { value: "CDEV" } } } } },
      },
      actions: [{ action_id: "move:project", selected_option: { value: "CDEV" } }],
    }),
  );
  assert.equal(calls[0].method, "views.update");
  assert.deepEqual([calls[0].args.view_id, calls[0].args.hash], ["V1", "H1"]);
  ({ view } = calls[0].args);
  assert.equal(view.blocks[0].element.initial_option.value, "CDEV");
  assert.deepEqual(optionsOf(view.blocks[1].element), [
    ["To do · Incident · Checkout is down", "100.3"],
    ["In progress · Fix login", "100.1"],
  ]);

  // Moving copies the message from the DM into the task's thread.
  calls = mockSlack(t, { ...moveSlack(), stored });
  const values = {
    project: { "move:project": { selected_option: { value: "CDEV" } } },
    target: { value: { selected_option: { value: "100.1" } } },
  };
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: { callback_id: "move:form", private_metadata: view.private_metadata, state: { values } },
    }),
  );
  const copy = calls.find((call) => call.method === "chat.postMessage").args;
  assert.deepEqual([copy.channel, copy.thread_ts], ["CDEV", "100.1"]);
  assert.match(
    copy.text,
    /^Moved from <@UBOB>'s <https:\/\/acme\.slack\.com\/archives\/D0BOB\/p5001\?thread_ts=500\.1&cid=D0BOB\|message>:/,
  );

  // A project with no open tasks can't be moved to.
  const empty = await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "move:form",
        private_metadata: view.private_metadata,
        state: { values: { project: values.project } },
      },
    }),
  );
  assert.deepEqual(await empty.json(), {
    response_action: "errors",
    errors: { project: "Choose a project with open tasks." },
  });
});

test("with only one group, the shortcuts anywhere choose its project", async (t) => {
  const single = { ...env, PROJECTS: [{ name: "acme", channel: "CDEV" }] };
  for (const [callbackId, callback] of [
    ["convert", "track"],
    ["incident", "incident"],
  ]) {
    const calls = mockSlack(t);
    await send("/slack/interactions", shortcutClick(callbackId), {}, single);
    const { view } = calls[0].args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].element.initial_option.value, "CDEV", callbackId);
    assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");
  }

  // Move to existing lists the group's open tasks straight away.
  let calls = mockSlack(t, { stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  await send("/slack/interactions", shortcutClick("move"), {}, single);
  const { view } = calls[0].args;
  assert.equal(view.blocks[0].block_id, "target");
  assert.deepEqual(optionsOf(view.blocks[0].element), [["In progress · Fix login", "100.1"]]);
  assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");

  // With nothing open, it says so instead of opening the form.
  calls = mockSlack(t);
  const responses = recordResponses(t);
  await send("/slack/interactions", shortcutClick("move"), {}, single);
  assert.ok(!calls.some((call) => call.method === "views.open"));
  assert.match(responses[0].text, /There are no open tasks there/);
});

test("Move to existing in a dev channel lists that channel's open tasks, without the project", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  await send("/slack/interactions", shortcutClick("move", devStray, "CDEV"));
  const { view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(view.blocks[0].block_id, "target");
  assert.deepEqual(optionsOf(view.blocks[0].element), [["In progress · Fix login", "100.1"]]);
  assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");
});

test("Message shortcuts in a dev channel say privately why they can't, without opening a form", async (t) => {
  for (const [callbackId, message, stored, text] of [
    ["move", { ...devStray, thread_ts: "100.1" }, [], /not replies in a thread/],
    ["convert", { ...devStray, ts: "100.1" }, [storedTask()], /already a task thread/],
    ["incident", devStray, [], /There are no open tasks|people's messages/],
    ["move", devStray, [], /There are no open tasks there/],
  ] as const) {
    const root = callbackId === "incident" ? { ...devStray, bot_id: "B1" } : devStray;
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    const responses = recordResponses(t);
    await send("/slack/interactions", shortcutClick(callbackId, message, "CDEV"));
    assert.ok(!calls.some((call) => call.method === "views.open"), callbackId);
    assert.match(responses[0].text, text, callbackId);
  }
});

// Someone adding `reaction` to the message at `ts` in `channel`.
const reactionEvent = (reaction, ts = "100.7", channel = "CDEV", user = "UACTOR") =>
  JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UBOT" }],
    event: { type: "reaction_added", user, reaction, item: { type: "message", channel, ts } },
  });

test("🎫 and 🔀 on a message in a dev channel offer privately to track or move it", async (t) => {
  let calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "TODO")] });
  await send("/slack/events", reactionEvent("twisted_rightwards_arrows"));
  assert.deepEqual(optionsOf(calls.at(-1).args.blocks[1].elements[0]), [["To do · Fix login", "100.1"]]);

  calls = mockSlack(t, moveSlack());
  await send("/slack/events", reactionEvent("ticket"));
  const offer = calls.at(-1).args;
  assert.equal(offer.text, "Shall I track this message as a task?");
  assert.equal(offer.blocks[1].elements[0].action_id, "move:track-task");

  // Elsewhere, and other emoji, are left alone.
  calls = mockSlack(t, moveSlack());
  await send("/slack/events", reactionEvent("ticket", "500.1", "CRANDOM"));
  await send("/slack/events", reactionEvent("thumbsup"));
  assert.equal(calls.length, 0);
});

// Clicks a button on the question about a message posted on its own.
const promptClick = (actionId) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    trigger_id: "trigger-9",
    response_url: RESPONSE_URL,
    actions: [
      {
        action_id: actionId,
        value: JSON.stringify({ channel: "CDEV", ts: "100.7", title: "The login bug also hits SSO" }),
      },
    ],
  });

test("a message posted on its own in a dev channel is asked whether it's a task, an incident or part of one", async (t) => {
  for (const [stored, buttons] of [
    [[devTask("100.1", "Fix login", "IN_PROGRESS")], ["New task", "New incident", "Move to existing", "Not now"]],
    [[devTask("100.1", "Fix login", "DONE")], ["New task", "New incident", "Not now"]],
  ] as const) {
    const calls = mockSlack(t, { stored });
    await send("/slack/events", threadEvent("The login bug also hits SSO", { ts: "100.7", thread_ts: undefined }));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["chat.postEphemeral"],
    );
    const question = calls[0].args;
    assert.equal(question.text, "Is this a new task, a new incident, or part of an existing one?");
    assert.deepEqual(
      question.blocks[1].elements.map((button) => button.text.text),
      buttons,
    );
  }
});

test("with suggestions off, a message posted on its own is still asked about; others aren't", async (t) => {
  let calls = mockSlack(t);
  await send(
    "/slack/events",
    threadEvent("hi", { ts: "100.7", thread_ts: undefined }),
    {},
    { ...env, TASK_CHANGE_DETECTION: "false" },
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postEphemeral"],
  );

  calls = mockSlack(t);
  await send("/slack/events", threadEvent("deploying now", { channel: "CRANDOM", ts: "500.1", thread_ts: undefined }));
  await send("/slack/events", threadEvent("done", { ts: "100.7", thread_ts: undefined, bot_id: "BOTHER" }));
  await send("/slack/events", threadEvent("edited", { ts: "100.7", thread_ts: undefined, subtype: "message_changed" }));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("newTaskDetection false stops the question about a message posted on its own, for one project or every one", async (t) => {
  const post = (environment) =>
    send("/slack/events", threadEvent("hi", { ts: "100.7", thread_ts: undefined }), {}, environment);
  const projects = (settings) => ({
    ...env,
    PROJECTS: (env.PROJECTS as Project[]).map((project) =>
      project.name === "acme" ? { ...project, ...settings } : project,
    ),
  });
  for (const [environment, asked] of [
    [env, true],
    [projects({ newTaskDetection: false }), false],
    [{ ...env, NEW_TASK_DETECTION: "off" }, false],
    [{ ...projects({ newTaskDetection: true }), NEW_TASK_DETECTION: "off" }, true],
  ] as const) {
    const calls = mockSlack(t);
    await post(environment);
    assert.equal(
      calls.some((call) => call.method === "chat.postEphemeral"),
      asked,
    );
  }
  // Messages in other threads and the other project are unaffected.
  const calls = mockSlack(t);
  await send(
    "/slack/events",
    threadEvent("hi", { channel: "CTESTDEV", ts: "100.7", thread_ts: undefined }),
    {},
    projects({ newTaskDetection: false }),
  );
  assert.ok(calls.some((call) => call.method === "chat.postEphemeral"));
});

test("Track as task and Report incident open their forms, named from the message", async (t) => {
  for (const [actionId, callback] of [
    ["move:track-task", "track"],
    ["move:report-incident", "incident"],
  ]) {
    const calls = mockSlack(t);
    const responses = recordResponses(t);
    await send("/slack/interactions", promptClick(actionId));
    const { view } = calls.find((call) => call.method === "views.open").args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].element.initial_option.value, "CDEV");
    assert.equal(
      view.blocks.find((block) => block.block_id === "title").element.initial_value,
      "The login bug also hits SSO",
    );
    // A task asks whether it is a task or a bug, starting at Task; an incident is one already.
    const kind = view.blocks.find((block) => block.block_id === "kind");
    assert.equal(kind?.element.initial_option.value, callback === "track" ? "task" : undefined);
    assert.deepEqual(JSON.parse(view.private_metadata), {
      channel: "CDEV",
      move: { channel: "CDEV", ts: "100.7" },
      title: "The login bug also hits SSO",
    });
    assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
  }
});

test("Move to existing opens the shortcut's form, and Not now removes the question", async (t) => {
  const stored = [devTask("100.1", "Fix login", "IN_PROGRESS")];
  let calls = mockSlack(t, { stored });
  const responses = recordResponses(t);
  await send("/slack/interactions", promptClick("move:existing"));
  const { view, trigger_id } = calls.find((call) => call.method === "views.open").args;
  assert.equal(trigger_id, "trigger-9");
  assert.equal(view.callback_id, "move:form");
  // The channel's project, so no project picker.
  assert.equal(view.blocks[0].block_id, "target");
  assert.deepEqual(optionsOf(view.blocks[0].element), [["In progress · Fix login", "100.1"]]);
  assert.equal(blockText(view.blocks[1]), "The login bug also hits SSO");
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);

  // Moving reads the message from the channel and copies it in.
  calls = mockSlack(t, { ...moveSlack(), stored });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "move:form",
        private_metadata: view.private_metadata,
        state: { values: { target: { value: { selected_option: { value: "100.1" } } } } },
      },
    }),
  );
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.thread_ts);
  assert.deepEqual(posts, ["100.1", "100.7"]);

  // With everything closed since, the question says so instead.
  calls = mockSlack(t, { stored: [devTask("100.1", "Fix login", "DONE")] });
  const later = recordResponses(t);
  await send("/slack/interactions", promptClick("move:existing"));
  assert.ok(!calls.some((call) => call.method === "views.open"));
  assert.match(later.at(-1).text, /^Everything here has been closed since/);

  await send("/slack/interactions", promptClick("move:dismiss"));
  assert.deepEqual(later.at(-1), { response_type: "ephemeral", delete_original: true });
});

test("a task tracked from a message takes the message into its thread", async (t) => {
  const calls = mockSlack(t, moveSlack());
  await send(
    "/slack/interactions",
    interaction(
      submission({ title: "SSO login", priority: "High" }, { channel: "CDEV", move: { channel: "CDEV", ts: "100.7" } }),
    ),
  );
  const posts = calls
    .filter((call) => call.method === "chat.postMessage")
    .map((call) => [call.args.thread_ts, call.args.text]);
  assert.equal(posts[0][1], "High task: SSO login");
  assert.deepEqual(posts.slice(1), [
    [
      "100.1",
      "Moved from <@UACTOR>'s <https://slack.example/100.7?thread_ts=100.7&cid=CDEV|message>:\n> The login bug also hits SSO\n> for some people",
    ],
    [
      "100.7",
      "<@UCREATOR> moved this message to the task thread <https://slack.example/100.9|SSO login>. Please carry on the conversation there.",
    ],
  ]);
});

// `@Cade <kind>` replied in the thread of the stray message.
const startEvent = (kind, threadTs = "100.7") => threadEvent(`<@UBOT> ${kind}`, { ts: "100.8", thread_ts: threadTs });

test("@Cade task and @Cade incident in a message's thread offer to start one from it", async (t) => {
  for (const [kind, question, button, actionId] of [
    ["task", "Shall I track this message as a task?", "New task", "move:track-task"],
    ["incident", "Shall I report an incident from this message?", "New incident", "move:report-incident"],
  ] as const) {
    const calls = mockSlack(t, moveSlack());
    await send("/slack/events", startEvent(kind));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["conversations.replies", "chat.postEphemeral"],
      kind,
    );
    const offer = calls[1].args;
    assert.equal(offer.thread_ts, "100.7", kind);
    assert.equal(offer.text, question, kind);
    const [start, dismiss] = offer.blocks[1].elements;
    assert.deepEqual([start.text.text, start.action_id, dismiss.action_id], [button, actionId, "move:dismiss"], kind);
    assert.deepEqual(
      JSON.parse(start.value),
      { channel: "CDEV", ts: "100.7", title: "The login bug also hits SSO" },
      kind,
    );
  }

  // A task's own thread isn't a message to start one from.
  const calls = mockSlack(t, { ...moveSlack(), stored: [storedTask()] });
  await send("/slack/events", startEvent("incident", "100.1"));
  assert.equal(calls.at(-1).args.text, "This is already a task thread.");
});

test("@Cade task and @Cade incident at the top of the dev channel point to replying in a thread", async (t) => {
  for (const kind of ["task", "incident"]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(`<@UBOT> ${kind}`, { ts: "100.7", thread_ts: undefined }));
    assert.equal(
      calls[0].args.text,
      `To start one from a message, reply \`@Cade ${kind}\` in its thread, or use \`/cade ${kind}\` for something new.`,
    );
  }
});
