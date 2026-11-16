import assert from "node:assert/strict";
import test from "node:test";
import {
  MR,
  PR,
  PR3,
  RESPONSE_URL,
  RESYNC_TS,
  cardButtons,
  cardMenu,
  cardMenuClick,
  createdTask,
  env,
  footerLines,
  interaction,
  messageLink,
  mockSlack,
  ownTask,
  recordResponses,
  runTasksCommand,
  savedTask,
  send,
  statusLine,
  storedTask,
  submission,
  subtaskOf,
  threadEvent,
} from "./app.ts";

test("Cade never pins or unpins a task: not when it's made, done, reopened or archived", async (t) => {
  const pins = (calls) => calls.filter((call) => call.method.startsWith("pins."));
  let calls = mockSlack(t, createdTask);
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "Low" })));
  assert.deepEqual(pins(calls), []);

  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add"],
  );

  const done = storedTask();
  done.task.status = "DONE";
  calls = mockSlack(t, { stored: [done] });
  await send("/slack/events", threadEvent("<@UBOT> status IN_TESTING"));
  assert.deepEqual(pins(calls), []);

  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> archive"));
  assert.deepEqual(pins(calls), []);
});

test("a task's card has Edit, Subtasks and Pull requests buttons, and a menu with Archive; a subtask's has no Subtasks", async (t) => {
  const row = async (record, ts = "100.1") => {
    const calls = mockSlack(t, { stored: [record].flat() });
    await send("/slack/events", threadEvent("<@UBOT> status in progress", { thread_ts: ts }));
    const card = calls.find((call) => call.method === "chat.update" && call.args.ts === ts).args;
    return {
      buttons: cardButtons(card).map((element) => [element.type, element.action_id, element.text?.text]),
      menu: cardMenu(card).options.map((option) => option.text.text),
    };
  };
  const withPrs = ownTask();
  withPrs.task.prs = [PR, MR];
  // They sit in one row under the title: the buttons first, then the ⋯ menu.
  for (const record of [ownTask(), withPrs]) {
    assert.deepEqual(await row(record), {
      buttons: [
        ["button", "task:edit", "Edit"],
        ["button", "task:subtasks", "Subtasks"],
        ["button", "task:prs", "Pull requests"],
        ["overflow", "task:menu", undefined],
      ],
      menu: ["Archive"],
    });
  }
  assert.deepEqual(
    (await row([ownTask(), subtaskOf("100.2")], "100.2")).buttons.map(([, id]) => id),
    ["task:edit", "task:prs", "task:menu"],
  );
});

test("Release in the menu of a card posted before partial releases went opens Edit, and a release's old buttons say they're gone", async (t) => {
  let calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", cardMenuClick("release"));
  assert.equal(calls.find((call) => call.method === "views.open").args.view.callback_id, "task:edit");

  for (const action_id of ["release:open", "release:approve", "release:reject"]) {
    calls = mockSlack(t, { stored: [ownTask()] });
    const sent = recordResponses(t);
    await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: "UCLIENT" },
        channel: { id: "CDEV" },
        response_url: RESPONSE_URL,
        message: { ts: "100.9", thread_ts: "100.1" },
        actions: [{ action_id, value: "{}" }],
      }),
    );
    assert.equal(sent.length, 1, action_id);
    assert.match(sent[0].text, /^Partial releases are gone\./, action_id);
    assert.equal(sent[0].replace_original, false, action_id);
  }
});

test("a card's Edit button opens the edit form, as Edit in the menu of a card posted before does", async (t) => {
  for (const click of [
    interaction({
      type: "block_actions",
      trigger_id: "T1",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      message: { ts: "100.1" },
      actions: [{ action_id: "task:edit" }],
    }),
    cardMenuClick("edit"),
  ]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/interactions", click);
    const { view } = calls.find((call) => call.method === "views.open").args;
    assert.equal(view.callback_id, "task:edit");
    assert.equal(JSON.parse(view.private_metadata).ts, "100.1");
  }
});

test("@Cade archive and the card's Archive stop tracking the task, keeping its card and thread", async (t) => {
  for (const archive of [
    () => send("/slack/events", threadEvent("<@UBOT> archive")),
    () => send("/slack/interactions", cardMenuClick("archive")),
  ]) {
    const calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })] });
    await archive();
    // Cade no longer finds it, but nothing is deleted.
    assert.equal(await savedTask(), null);
    assert.ok(!calls.some((call) => call.method === "chat.delete"));
    // The card says who archived it, and has no buttons.
    const card = calls.find((call) => call.method === "chat.update").args;
    assert.equal(card.ts, "100.1");
    assert.equal(cardButtons(card), undefined);
    assert.match(statusLine(card), /^:file_cabinet: Archived by <@UACTOR>  ·  Due 31\/10\/2026$/);
    // The thread hears who did.
    const post = calls.find((call) => call.method === "chat.postMessage").args;
    assert.deepEqual([post.thread_ts, post.text], ["100.1", "<@UACTOR> archived this task."]);
  }

  // Its thread no longer has a task.
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> archive"));
  assert.match(calls[0].args.text, /not tracking a task in this thread/);
});

test("/cade resync <link> redraws a task's card quietly", async (t) => {
  const calls = mockSlack(t, { stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }] });
  await runTasksCommand(`resync ${messageLink("CDEV", RESYNC_TS)}`, "CDEV", env);
  const card = calls.find((call) => call.method === "chat.update").args;
  assert.equal(card.ts, RESYNC_TS);
  assert.equal(footerLines(card)[0], "Owner <@UREX>");
  // Nothing is posted, so no one is notified.
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral", "views.open"].includes(call.method)));
});

test("choosing from a task card's menu opens its form, and an old card's choices open Edit", async (t) => {
  for (const [choice, callbackId] of [
    // Release, before partial releases went.
    ["release", "task:edit"],
    ["assign", "task:edit"],
    ["status", "task:edit"],
    ["more", "task:edit"],
  ] as const) {
    const record = ownTask({ owners: ["UREX"] });
    record.task.prs = ["https://github.com/acme/web/pull/9"];
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/interactions", cardMenuClick(choice));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["views.open"],
      choice,
    );
    assert.equal(calls[0].args.trigger_id, "T1");
    assert.equal(calls[0].args.view.callback_id, callbackId, choice);
  }
});

test("a task card's menu on a task that's gone says so privately", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/interactions", cardMenuClick("status"));
  assert.deepEqual(
    calls.map((call) => [call.method, call.args.user]),
    [["chat.postEphemeral", "UACTOR"]],
  );
});

test("the card's Edit opens one form with everything, and saving it applies what changed as one message", async (t) => {
  const record = ownTask({ owners: ["UREX"], reviewers: ["UMIA"] });
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/interactions", cardMenuClick("edit"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["views.open"],
  );
  const form = calls[0].args.view;
  assert.equal(form.callback_id, "task:edit");
  assert.deepEqual(
    form.blocks.map((block) => block.block_id),
    ["kind", "owner", "reviewer", "tester", "status", "priority", "due_date", "blocked", "blocked_reason"],
  );
  assert.equal(form.blocks[0].element.initial_option.value, "task");
  assert.deepEqual(form.blocks[1].element.initial_users, ["UREX"]);
  assert.equal(form.blocks[4].element.initial_option.value, "TODO");

  // A tester added with the status left alone keeps it. The pull requests box of a form opened
  // before they had a form of their own is ignored.
  const values = {
    owner: { value: { selected_users: ["UREX"] } },
    reviewer: { value: { selected_users: ["UMIA"] } },
    tester: { value: { selected_users: ["UTESS"] } },
    status: { value: { selected_option: { value: "TODO" } } },
    priority: { value: { selected_option: { value: "High" } } },
    due_date: { value: { selected_date: "2026-10-31" } },
    prs: { value: { value: "https://github.com/acme/web/pull/12" } },
  };
  const submit = (state) =>
    send(
      "/slack/interactions",
      interaction({
        type: "view_submission",
        user: { id: "UACTOR" },
        view: { callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values: state } },
      }),
    );
  await submit(values);
  const saved = await savedTask();
  assert.deepEqual([saved.status, saved.prs, saved.people.tester], ["TODO", [], ["UTESS"]]);
  const posts = calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].args.text, "<@UACTOR> assigned <@UTESS> as tester.");
});

test("Edit saves a new status and a tester who is the person saving, in one update, and posts the log", async (t) => {
  const task = storedTask({ reviewers: ["UMIA"] });
  task.task.status = "IN_REVIEW";
  const calls = mockSlack(t, { stored: [task] });
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
            reviewer: { value: { selected_users: ["UMIA"] } },
            tester: { value: { selected_users: ["UACTOR"] } },
            status: { value: { selected_option: { value: "IN_TESTING" } } },
            prs: { value: { value: "" } },
          },
        },
      },
    }),
  );
  const saved = await savedTask();
  assert.deepEqual([saved.status, saved.people.tester], ["IN_TESTING", ["UACTOR"]]);
  // One update of the card, for all of it.
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 1);
  const post = calls.find((call) => call.method === "chat.postMessage");
  assert.equal(
    post.args.text,
    "<@UACTOR> assigned themselves as tester.\n<@UACTOR> set the status to :test_tube: In testing.",
  );
});

test("a blocked task's card and the Home tab show it, with its reason", async () => {
  const { blockedLine, cleanReason, MAX_BLOCKED_REASON } = await import("../src/tasks.ts");
  assert.equal(blockedLine({ blocked: false, blockedReason: "x" }), "");
  assert.equal(blockedLine({ blocked: true }), ":no_entry: *Blocked*");
  assert.equal(
    blockedLine({ blocked: true, blockedReason: "waiting on <keys>" }),
    ":no_entry: *Blocked*: waiting on &lt;keys&gt;",
  );
  assert.equal(cleanReason("x".repeat(500)).length, MAX_BLOCKED_REASON);
});

test("a subtask's card has its Subtask of line and its page links in one block, as close as its people and who tracked it", async () => {
  const { taskMessage } = await import("../src/tasks.ts");
  const task = { ...subtaskOf("100.2").task, export: { url: "https://cade.example/t/1" } };
  const [first] = taskMessage(task).attachments![0]!.blocks as { elements: { text: string }[] }[];
  assert.equal(
    first!.elements[0]!.text,
    ":arrow_right_hook: Subtask of *Fix login*\nFull history <https://cade.example/t/1|here>",
  );
});

test("a task's card is in three parts: its pages and subtasks' and PRs' counts, its work (status and people), and who tracked it", async () => {
  const { taskMessage } = await import("../src/tasks.ts");
  const task = {
    ...storedTask({ owners: ["UREX"] }).task,
    prs: [PR, MR, PR3],
    prStates: { [MR]: "MERGED" as const, [PR3]: "CLOSED" as const },
    export: { url: "https://cade.example/t/1" },
    subtaskCounts: { open: 1, closed: 2 },
  };
  const blocks = taskMessage(task).attachments![0]!.blocks as { elements: { text: string }[] }[];
  assert.deepEqual(
    blocks.map((block) => block.elements[0]!.text.split("\n")),
    [
      // A closed one is neither open nor merged.
      [
        "Full history <https://cade.example/t/1|here>",
        "Subtasks: 1 open  ·  2 closed",
        "Pull requests: 1 open  ·  1 merged",
      ],
      [":memo: To do  ·  Due 31/10/2026", "Owner <@UREX>"],
      ["Tracked by <@UCREATOR>"],
    ],
  );
});
