import assert from "node:assert/strict";
import test from "node:test";
import {
  DB,
  RESPONSE_URL,
  blockText,
  cardMenuClick,
  createdTask,
  incidentTask,
  interaction,
  mockSlack,
  moveSlack,
  projectOptions,
  recordResponses,
  savedTask,
  send,
  shortcutClick,
  slash,
  statusLine,
  storedTask,
  submission,
  threadEvent,
  withoutSummary,
} from "./app.ts";

test("modal submission rejects a blank title", async (t) => {
  const calls = mockSlack(t);
  const response = await send("/slack/interactions", interaction(submission({ title: "   ", priority: "High" })));

  assert.equal(calls.length, 0);
  assert.deepEqual(await response.json(), {
    response_action: "errors",
    errors: { title: "Please give the task a title." },
  });
});

test("modal submission without a due date leaves it out", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "Low" })));
  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV");
  assert.equal(statusLine(post.args), ":memo: To do");
});

test("modal submission tells the creator when the task cannot be posted", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: new URL(url).pathname.replace("/api/", ""), args: Object.fromEntries(init.body) });
    return Response.json({ ok: false, error: "channel_not_found" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "Low" })));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage", "chat.postEphemeral"],
  );
  assert.equal(calls[1].args.user, "UCREATOR");
  assert.equal(calls[1].args.channel, "CDEV");
  assert.match(
    calls[1].args.text,
    /^Sorry, I couldn't post the task "Fix login" just now\. I'll try again in a few minutes\.$/,
  );
  // The task is stored, waiting to be posted.
  const row = await DB.prepare("SELECT ts, post_attempts, origin FROM tasks").first<{
    ts: string | null;
    post_attempts: number;
    origin: string;
  }>();
  assert.equal(row.ts, null);
  assert.equal(row.post_attempts, 1);
  assert.deepEqual(JSON.parse(row.origin), {});
});

test("a task is announced, then linked, before its summary canvas is made", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = new URL(url).pathname.replace("/api/", "");
    calls.push(method);
    if (method === "chat.getPermalink") return Response.json({ ok: true, permalink: "https://slack.example/p100" });
    if (method === "conversations.canvases.create") return Response.json({ ok: true, canvas_id: "F0CANVAS" });
    return Response.json({ ok: true, channel: "CDEV", ts: "100.1" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "Low" })));
  // Then the group's summary canvas is made (see summary.js).
  assert.deepEqual(calls.slice(0, 2), ["chat.postMessage", "chat.getPermalink"]);
});

test("/cade task and /cade incident in any channel open their form, with the Project to choose", async (t) => {
  for (const [kind, callback] of [
    ["task", "track"],
    ["incident", "incident"],
  ]) {
    // In a channel that isn't a project's, no project is chosen to begin with.
    let calls = mockSlack(t);
    await send("/slack/commands", slash(kind, "COTHER"));
    let { view } = calls[0].args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].block_id, "project");
    assert.equal(view.blocks[0].optional, undefined, "the Project is required");
    assert.deepEqual(projectOptions(view), [
      ["acme", "CDEV"],
      ["test", "CTESTDEV"],
    ]);
    assert.equal(view.blocks[0].element.initial_option, undefined);
    assert.deepEqual(JSON.parse(view.private_metadata), {});

    // In a project's channel, its project is chosen.
    calls = mockSlack(t);
    await send("/slack/commands", slash(kind, "CTESTDEV"));
    ({ view } = calls[0].args);
    assert.equal(view.blocks[0].element.initial_option.value, "CTESTDEV");
  }
});

test("the Project chosen on the form decides where the task goes", async (t) => {
  const calls = mockSlack(t, createdTask);
  const form = submission({ title: "Fix login", priority: "High" }, { channel: "CDEV" });
  const values = { ...form.view.state.values, project: { value: { selected_option: { value: "CTESTDEV" } } } };
  await send("/slack/interactions", interaction({ ...form, view: { ...form.view, state: { values } } }));
  assert.equal(calls[0].method, "chat.postMessage");
  assert.equal(calls[0].args.channel, "CTESTDEV");
});

test("@Cade task in the thread of a message in any channel Cade is in offers to track it, asking for the Project", async (t) => {
  const root = { ts: "300.1", user: "UBOB", text: "Invoices miss the VAT number" };
  let calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadEvent("<@UBOT> task", { channel: "COTHER", ts: "300.2", thread_ts: "300.1" }));
  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.channel, "COTHER");
  const button = question.blocks[1].elements[0];

  calls = mockSlack(t);
  recordResponses(t);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "T1",
      response_url: RESPONSE_URL,
      user: { id: "UACTOR" },
      channel: { id: "COTHER" },
      actions: [{ action_id: button.action_id, value: button.value }],
    }),
  );
  const { view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(view.blocks[0].block_id, "project");
  assert.equal(view.blocks[0].element.initial_option, undefined);
  assert.deepEqual(JSON.parse(view.private_metadata), {
    move: { channel: "COTHER", ts: "300.1" },
    title: "Invoices miss the VAT number",
  });
});

test("New task on a message in a channel Cade isn't in warns to invite it, and offers no AI prompt", async (t) => {
  for (const [info, away] of [
    [{ channel: { id: "CPUBLIC", is_member: false } }, true],
    [{ ok: false, error: "channel_not_found" }, true],
    [{ channel: { id: "CPUBLIC", is_member: true } }, false],
  ] as const) {
    const calls = mockSlack(t, { "conversations.info": info });
    await send("/slack/interactions", shortcutClick("convert", undefined, "CPUBLIC"));
    const { view } = calls.find((call) => call.method === "views.open").args;
    const warning = view.blocks.find((block) => block.type === "context" && /not in <#CPUBLIC>/.test(blockText(block)));
    assert.equal(Boolean(warning), away);
    if (away) assert.match(blockText(warning), /Invite me with `\/invite @Cade` in <#CPUBLIC>/);
    assert.equal(JSON.parse(view.private_metadata).move.away, away || undefined);
  }

  // The task is still made, with the message copied in, but without the AI prompt, which reads the
  // thread it came from.
  const calls = mockSlack(t, {
    ...moveSlack(),
    "conversations.info": { channel: { id: "CPUBLIC", is_member: false } },
  });
  await send("/slack/interactions", shortcutClick("convert", undefined, "CPUBLIC"));
  const { view } = calls.find((call) => call.method === "views.open").args;
  const values = {
    project: { value: { selected_option: { value: "CDEV" } } },
    title: { value: { value: "Payments down" } },
    due_date: { value: { selected_date: null } },
    priority: { value: { selected_option: { value: "High" } } },
  };
  const answer = await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: { callback_id: "track", private_metadata: view.private_metadata, state: { values } },
    }),
  );
  assert.deepEqual(await answer.json(), { response_action: "clear" });
});
test("tasks tracked in the test channel go to the test channel", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "High" }, { channel: "CTESTDEV" })),
  );
  assert.equal(calls[0].args.channel, "CTESTDEV");
});

test("/cade task opens the task form straight away", async (t) => {
  const calls = mockSlack(t);
  const response = await send("/slack/commands", slash("task", "CDEV"));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["views.open"],
  );
  assert.equal(calls[0].args.trigger_id, "trigger-9");
  assert.equal(calls[0].args.view.callback_id, "track");
  assert.deepEqual(JSON.parse(calls[0].args.view.private_metadata), { channel: "CDEV" });
});

test("/cade task in the dev channel posts the task without an announcement", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" }, { channel: "CDEV" })),
  );
  assert.deepEqual(
    withoutSummary(calls).map((call) => call.method),
    ["chat.postMessage", "chat.getPermalink", "conversations.replies", "chat.update"],
  );
});

test("/cade incident opens a form that asks only what the incident is, in a dev channel", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/commands", slash("incident", "CDEV"));
  const { view } = calls[0].args;
  assert.equal(view.callback_id, "incident");
  assert.deepEqual(JSON.parse(view.private_metadata), { channel: "CDEV" });
  assert.deepEqual(
    view.blocks.map((block) => block.block_id ?? block.type),
    ["project", "title", "context"],
  );

  // An incident needs a description.
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "incident",
        private_metadata: view.private_metadata,
        state: { values: { title: { value: { value: " " } } } },
      },
    }),
  );
  assert.deepEqual(await response.json(), {
    response_action: "errors",
    errors: { title: "Please tell us what's going on." },
  });
});

test("an incident's priority and due date can't be changed, and its Edit form leaves them out", async (t) => {
  for (const text of ["<@UBOT> priority low", "<@UBOT> due 15/12/2026"]) {
    const calls = mockSlack(t, { stored: [incidentTask()] });
    await send("/slack/events", threadEvent(text));
    assert.equal(
      calls.at(-1).args.text,
      "Incidents are always :red_circle: Urgent and due Immediate, so I can't change their priority or due date.",
    );
  }
  const calls = mockSlack(t, { stored: [incidentTask()] });
  await send("/slack/interactions", cardMenuClick("edit"));
  const form = calls[0].args.view;
  assert.deepEqual(
    form.blocks.map((block) => block.block_id ?? block.type),
    ["owner", "reviewer", "tester", "status", "context", "blocked", "blocked_reason"],
  );
  assert.match(blockText(form.blocks[4]), /Incidents are always :red_circle: Urgent and due Immediate/);
});

test("a task can be made a bug on the New task form, and changed between task and bug with Edit", async (t) => {
  let calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Login fails on Safari", priority: "High", kind: "bug" })),
  );
  assert.equal((await savedTask()).bug, true);
  const card = calls.find((call) => call.method === "chat.postMessage" && !call.args.thread_ts);
  assert.match(card.args.blocks[0].text.text, /^\[HIGH\] \[Bug\] \*Login fails on Safari\*/);
  assert.equal(card.args.text, "High bug: Login fails on Safari");
  assert.match(JSON.stringify(card.args.attachments), /Reported by <@UCREATOR>/);

  // Its Edit form starts at Bug; saving it as Task makes it a task again, and the thread is told.
  const bug = storedTask();
  bug.task.bug = true;
  calls = mockSlack(t, { stored: [bug] });
  await send("/slack/interactions", cardMenuClick("edit"));
  const form = calls[0].args.view;
  assert.equal(form.blocks[0].element.initial_option.value, "bug");
  const save = (kind?: string) => {
    const values = {
      ...(kind && { kind: { value: { selected_option: { value: kind } } } }),
      owner: { value: { selected_users: [] } },
      reviewer: { value: { selected_users: [] } },
      tester: { value: { selected_users: [] } },
      status: { value: { selected_option: { value: "TODO" } } },
      priority: { value: { selected_option: { value: bug.task.priority } } },
      due_date: {
        value: {
          selected_date: form.blocks.find((block) => block.block_id === "due_date").element.initial_date ?? null,
        },
      },
    };
    return send(
      "/slack/interactions",
      interaction({
        type: "view_submission",
        user: { id: "UACTOR" },
        view: { callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values } },
      }),
    );
  };
  await save("task");
  assert.equal((await savedTask()).bug, false);
  const told = calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1");
  assert.equal(told.args.text, "<@UACTOR> marked this as a task, not a bug.");
  const redrawn = calls.find((call) => call.method === "chat.update");
  assert.doesNotMatch(redrawn.args.blocks[0].text.text, /\[Bug\]/);

  await save("bug");
  assert.equal((await savedTask()).bug, true);
  assert.ok(calls.some((call) => call.args.text === "<@UACTOR> marked this as a bug."));
  // A form opened before it had the Type leaves it as it is.
  await save();
  assert.equal((await savedTask()).bug, true);
});

test("a task made without choosing is a task, and an incident's Edit form has no Type and stays an incident", async (t) => {
  mockSlack(t, createdTask);
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "High" })));
  assert.equal(Boolean((await savedTask()).bug), false);

  const calls = mockSlack(t, { stored: [incidentTask()] });
  await send("/slack/interactions", cardMenuClick("edit"));
  const form = calls[0].args.view;
  assert.equal(
    form.blocks.some((block) => block.block_id === "kind"),
    false,
  );
  // Even a Type sent anyway leaves it an incident.
  const values = {
    kind: { value: { selected_option: { value: "bug" } } },
    owner: { value: { selected_users: [] } },
    reviewer: { value: { selected_users: [] } },
    tester: { value: { selected_users: [] } },
    status: { value: { selected_option: { value: "TODO" } } },
  };
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: { callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values } },
    }),
  );
  const task = await savedTask();
  assert.deepEqual([task.incident, task.bug], [true, false]);
});
