import assert from "node:assert/strict";
import test from "node:test";
import { applyChanges, changeTask } from "../src/commands/changes.ts";
import { changeLog, changeRequests, unmentioned } from "../src/notify.ts";
import type { StoredTask } from "../src/types.ts";
import { fake } from "./helpers.ts";
import {
  MR,
  PR,
  RESPONSE_URL,
  changed,
  clientReview,
  drafts,
  env,
  incidentTask,
  interaction,
  mockSlack,
  recordResponses,
  savedTask,
  seeded,
  send,
  storedTask,
  threadEvent,
  where,
  withStatus,
} from "./app.ts";

test("the draft of what a change asks of people is sent, edited or left by whoever made it", async (t) => {
  const offered = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  const offer = offered.find((call) => call.method === "chat.postEphemeral").args;
  const buttons = offer.blocks.at(-1).elements;
  assert.deepEqual(
    buttons.map((button) => button.text.text),
    ["Send", "Edit", "Not now"],
  );
  const click = (button, user = "UACTOR") =>
    interaction({
      type: "block_actions",
      user: { id: user },
      channel: { id: "CDEV" },
      container: { is_ephemeral: true },
      trigger_id: "trigger",
      response_url: RESPONSE_URL,
      actions: [{ action_id: button.action_id, value: button.value }],
    });

  // Send posts it in the task's thread, saying whose it is by name, so only those it asks are notified,
  // and removes the draft.
  let calls = mockSlack(t, {
    stored: [storedTask()],
    "users.info": (args) => ({ user: { real_name: { UACTOR: "Ann", UBOB: "Bob" }[args.user] } }),
  });
  let sent = recordResponses(t);
  await send("/slack/interactions", click(buttons[0]));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.deepEqual(
    [post.channel, post.thread_ts, post.text],
    ["CDEV", "100.1", "@Ann sent:\n<@UBOB>, could you pick this up?"],
  );
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  // Not now removes it and posts nothing.
  calls = mockSlack(t, { stored: [storedTask()] });
  sent = recordResponses(t);
  await send("/slack/interactions", click(buttons[2]));
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  // Edit opens it in a form, mentions as people, to change before it's sent.
  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/interactions", click(buttons[1]));
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.callback_id, "ask:edit");
  assert.deepEqual(form.blocks[0].element.initial_value, {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "user", user_id: "UBOB" },
          { type: "text", text: ", could you pick this up?" },
        ],
      },
    ],
  });

  // Sent, it posts what the form holds, and removes the draft.
  const submit = (elements) =>
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "ask:edit",
        private_metadata: form.private_metadata,
        state: { values: { message: { value: { rich_text_value: { type: "rich_text", elements } } } } },
      },
    });
  calls = mockSlack(t, { stored: [storedTask()] });
  sent = recordResponses(t);
  const response = await send(
    "/slack/interactions",
    submit([
      {
        type: "rich_text_section",
        elements: [
          { type: "user", user_id: "UBOB" },
          { type: "text", text: " can you test it on " },
          { type: "text", text: "staging", style: { bold: true } },
          { type: "text", text: " <today> " },
          { type: "emoji", name: "pray" },
        ],
      },
      {
        type: "rich_text_list",
        elements: [
          { type: "rich_text_section", elements: [{ type: "link", url: "https://x.example", text: "the notes" }] },
        ],
      },
    ]),
  );
  assert.deepEqual(await response.json(), { response_action: "clear" });
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UACTOR> sent:\n<@UBOB> can you test it on *staging* &lt;today&gt; :pray:\n• <https://x.example|the notes>",
  );
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  // An empty one isn't sent.
  calls = mockSlack(t, { stored: [storedTask()] });
  const empty = await send(
    "/slack/interactions",
    submit([{ type: "rich_text_section", elements: [{ type: "text", text: "  " }] }]),
  );
  assert.deepEqual(await empty.json(), {
    response_action: "errors",
    errors: { message: "Write the message, or cancel." },
  });
  assert.deepEqual(calls, []);
});

test("people are asked only when there's something for them to do now", async (t) => {
  const task = (status, prs = [], prStates = {}) => {
    const root = storedTask();
    Object.assign(root.task, { status, prs, prStates });
    return root;
  };
  const ask = (role) =>
    ({
      owner: "<@UBOB>, could you pick this up?",
      reviewer: `<@UBOB>, could you review this?`,
      tester: "<@UBOB>, could you give this a test?",
    })[role];
  for (const [role, root, asked] of [
    ["owner", task("TODO"), true],
    ["owner", task("DONE"), false],
    // Reviewers review the PRs still open.
    ["reviewer", task("IN_REVIEW", [PR]), true],
    ["reviewer", task("IN_REVIEW", [PR, MR], { [MR]: "MERGED" }), true],
    ["reviewer", task("IN_REVIEW", [PR], { [PR]: "CLOSED" }), false],
    // Testers test it once it's In testing.
    ["tester", task("IN_REVIEW"), false],
    ["tester", task("IN_TESTING"), true],
  ] as const) {
    const calls = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadEvent(`<@UBOT> assign ${role} <@UBOB>`));
    const label = `${role} on ${root.task.status} with ${root.task.prs.length} PRs`;
    assert.equal(drafts(calls)[0], asked ? ask(role) : undefined, label);

    // Those removed are told only when they would have been asked.
    root.task.people[role] = ["UBOB"];
    const again = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadEvent(`<@UBOT> unassign ${role} <@UBOB>`));
    const note = `<@UBOB>, there's no need to ${{ owner: "work on", reviewer: "review", tester: "test" }[role]} this anymore.`;
    assert.equal(drafts(again)[0], asked ? note : undefined, label);
  }
});

test("the ready to review message doesn't link to the team's task", async (t) => {
  const calls = await clientReview(t, {
    stored: [withStatus("IN_TESTING")],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  const review = calls.find(
    (call) => call.method === "chat.postMessage" && call.args.text?.startsWith("<@UACTOR> sent:"),
  ).args;
  assert.equal(
    review.text,
    "<@UACTOR> sent:\n<@UCREATOR>, could you take a look and approve it, or let us know what needs to change?",
  );
  assert.ok(!review.text.includes("slack.example/p100"));
  // No link to look up for it.
  assert.ok(!calls.some((call) => call.method === "chat.getPermalink" && call.args.channel === "CDEV"));
});

test("someone removed from several roles at once is told only for the roles they had been asked in", async (t) => {
  const root = storedTask({ owners: ["UALICE"], reviewers: ["UALICE"] });
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> unassign <@UALICE>"));
  assert.deepEqual(drafts(calls), ["<@UALICE>, there's no need to work on this anymore."]);
});

test("people assigned in several roles are asked only for the one the task is at, and people asked alike share a note", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
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
            owner: { value: { selected_users: ["UBOB", "UREX"] } },
            reviewer: { value: { selected_users: ["UBOB"] } },
            tester: { value: { selected_users: [] } },
            status: { value: { selected_option: { value: "TODO" } } },
            prs: { value: { value: PR } },
          },
        },
      },
    }),
  );
  // It is To do: owners are asked, and the reviewer waits for In review.
  assert.deepEqual(drafts(calls), ["<@UBOB>, <@UREX>, could you pick this up?"]);
});

// ---- The update engine: what actually changed ----

test("changeTask blocks and unblocks a task, keeping its status, and the thread is told", async (t) => {
  mockSlack(t, { stored: [storedTask({ status: "IN_PROGRESS" })] });
  const blocked = await changeTask(env, where, { blocked: { on: true, reason: "  waiting on\nAPI keys " } }, "UACTOR");
  assert.deepEqual(blocked.blocked, { to: true, reason: "waiting on API keys" });
  assert.deepEqual(changeLog(blocked), ["<@UACTOR> marked this as blocked: waiting on API keys"]);
  const stored = await savedTask();
  assert.deepEqual([stored.status, stored.blocked, stored.blockedReason], ["IN_PROGRESS", true, "waiting on API keys"]);
  // The same again changes nothing; a new reason does.
  assert.equal(await changeTask(env, where, { blocked: { on: true, reason: "waiting on API keys" } }, "UACTOR"), null);
  assert.equal(
    (await changeTask(env, where, { blocked: { on: true, reason: "waiting on design" } }, "UACTOR")).blocked.reason,
    "waiting on design",
  );
  const unblocked = await changeTask(env, where, { blocked: { on: false } }, "UACTOR");
  assert.deepEqual(changeLog(unblocked), ["<@UACTOR> unblocked this."]);
  assert.equal(await changeTask(env, where, { blocked: { on: false } }, "UACTOR"), null);
});

test("changeTask returns only what differs from the stored task", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
  const change = await changeTask(
    env,
    where,
    {
      // @alice is an owner already; @bob is new.
      people: { owner: { add: ["UALICE", "UBOB"] }, tester: { remove: ["UTOM"] } },
      // The priority is as it is; the due date is not.
      priority: "High",
      dueDate: "02/11/2026",
      status: "TODO",
    },
    "UACTOR",
  );
  assert.deepEqual(change.people, [{ role: "owner", added: ["UBOB"], removed: [] }]);
  assert.deepEqual([change.prs, change.priority, change.status], [null, null, null]);
  assert.deepEqual(change.dueDate, { from: "31/10/2026", to: "02/11/2026" });
  // Stored, and the card updated once, for all of it.
  const saved = await savedTask();
  assert.deepEqual([saved.people.owner, saved.dueDate], [["UALICE", "UBOB"], "02/11/2026"]);
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 1);
});

test("changeTask returns what each kind of change was from and to", async (t) => {
  const root = storedTask({ reviewers: ["UMIA"] });
  root.task.prs = [MR];
  mockSlack(t, { stored: [root] });
  const change = await changeTask(
    env,
    where,
    {
      prs: { add: [PR, MR], remove: [MR, "https://github.com/acme/other/pull/1"] },
      priority: "Low",
      status: "IN_REVIEW",
    },
    "UACTOR",
  );
  assert.deepEqual(change.prs, { added: [PR], removed: [MR] });
  assert.deepEqual(change.priority, { from: "High", to: "Low" });
  assert.deepEqual(change.status, { from: "TODO", to: "IN_REVIEW" });
  assert.equal(change.task.status, "IN_REVIEW");
});

test("changeTask returns null, and saves nothing, when nothing differs", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
  const change = await changeTask(
    env,
    where,
    {
      people: { owner: { add: ["UALICE"] } },
      priority: "High",
      dueDate: "31/10/2026",
      status: "TODO",
      prs: { remove: [PR] },
    },
    "UACTOR",
  );
  assert.equal(change, null);
  assert.deepEqual(
    calls.map((call) => call.method),
    [],
  );
});

test("changeTask leaves an incident's priority and due date, and a task that is gone", async (t) => {
  mockSlack(t, { stored: [incidentTask({})] });
  assert.equal(await changeTask(env, where, { priority: "Low", dueDate: "01/01/2027" }, "UACTOR"), null);
  assert.equal(await changeTask(env, { channel: "CDEV", ts: "999.9" }, { priority: "Low" }, "UACTOR"), null);
});

test("changeTask leaves the status when the task moved on from where the suggestion saw it", async (t) => {
  const root = storedTask();
  root.task.status = "IN_PROGRESS";
  mockSlack(t, { stored: [root] });
  const change = await changeTask(env, where, { status: "IN_REVIEW", priority: "Low" }, "UACTOR", { from: "TODO" });
  assert.equal(change.status, null);
  assert.equal(change.priority.to, "Low");
  assert.equal((await savedTask()).status, "IN_PROGRESS");
});
const team = (owner = [], reviewer = [], tester = []) => ({ owner, reviewer, tester });

test("the change log has a line for each thing that changed, in order", () => {
  const change = changed({
    people: [
      { role: "owner", added: ["UBOB"], removed: [] },
      { role: "tester", added: [], removed: ["UTOM"] },
    ],
    prs: { added: [PR], removed: [MR] },
    priority: { from: "High", to: "Low" },
    dueDate: { from: "31/10/2026", to: "" },
    status: { from: "TODO", to: "IN_PROGRESS" },
  });
  assert.deepEqual(changeLog(change), [
    `<@UACTOR> linked <${PR}|cade/42>.`,
    `<@UACTOR> unlinked <${MR}|web-app/118>.`,
    "<@UACTOR> assigned <@UBOB> as owner.",
    "<@UACTOR> removed <@UTOM> as tester.",
    "<@UACTOR> set the priority to :large_green_circle: Low.",
    "<@UACTOR> removed the due date.",
    "<@UACTOR> set the status to :arrow_forward: In progress.",
  ]);
  assert.deepEqual(changeLog(changed()), []);
});

// The change log names people without notifying them: only the draft offered to whoever made the
// change, if they send it, does.
test("the change log is posted with people's names in plain text, not mentions", async (t) => {
  const NAMES = { UACTOR: "Ann", UBOB: "Bob <Jones>" };
  const calls = mockSlack(t, {
    stored: [storedTask()],
    "users.info": (args) =>
      NAMES[args.user]
        ? { user: { profile: { display_name: NAMES[args.user] } } }
        : { ok: false, error: "user_not_found" },
  });
  await seeded;
  await applyChanges(env, { channel: "CDEV", ts: "100.1" }, { people: { owner: { add: ["UBOB"] } } }, "UACTOR");
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.text, "@Ann assigned @Bob &lt;Jones&gt; as owner.");
  // Asking them is still offered, by mention, to send or not.
  assert.deepEqual(drafts(calls), ["<@UBOB>, could you pick this up?"]);
});

test("a person who can't be named stays a mention in the change log", async (t) => {
  mockSlack(t, {
    "users.info": (args) =>
      args.user === "UACTOR" ? { user: { real_name: "Ann Lee" } } : { ok: false, error: "user_not_found" },
  });
  assert.equal(
    await unmentioned(env, "<@UACTOR> assigned <@UGHOST|ghost> as owner."),
    "@Ann Lee assigned <@UGHOST|ghost> as owner.",
  );
  // Nothing to name, nothing looked up.
  const calls = mockSlack(t);
  assert.equal(await unmentioned(env, "Auto-linked web/12."), "Auto-linked web/12.");
  assert.equal(calls.length, 0);
});

test("a person assigned in two roles is asked only for the one the task is at", () => {
  const change = (status) =>
    changed({
      people: [
        { role: "owner", added: ["UBOB", "UREX"], removed: [] },
        { role: "reviewer", added: ["UBOB"], removed: [] },
      ],
      prs: { added: [PR], removed: [] },
      task: { status, people: team(["UBOB", "UREX"], ["UBOB"]) },
    });
  // Owners work on it while it is To do or In progress, and reviewers review it while it is In review.
  assert.deepEqual(changeRequests(change("IN_PROGRESS")), ["<@UBOB>, <@UREX>, could you pick this up?"]);
  assert.deepEqual(changeRequests(change("IN_REVIEW")), [`<@UBOB>, could you review this?`]);
  assert.deepEqual(changeRequests(change("IN_TESTING")), []);
});

test("people asked alike share a note, and reviewers kept are asked about new pull requests only while it is In review", () => {
  const change = (status) =>
    changed({
      people: [{ role: "owner", added: ["UBOB", "UREX"], removed: [] }],
      prs: { added: [PR], removed: [] },
      task: { status, people: team(["UBOB", "UREX"], ["UMIA", "UZOE"]) },
    });
  assert.deepEqual(changeRequests(change("IN_REVIEW")), [`<@UMIA>, <@UZOE>, could you review this?`]);
  // Before it, the reviewers wait: they are asked when it gets to In review.
  assert.deepEqual(changeRequests(change("IN_PROGRESS")), ["<@UBOB>, <@UREX>, could you pick this up?"]);
});

test("moving to In review asks every reviewer once, those just added too, about the pull requests pending", () => {
  const pending = changed({
    people: [{ role: "reviewer", added: ["UMIA"], removed: [] }],
    status: { from: "IN_PROGRESS", to: "IN_REVIEW" },
    task: { prs: [PR, MR], people: team([], ["UZOE", "UMIA", "UACTOR"]) },
  });
  assert.deepEqual(changeRequests(pending), [`<@UZOE>, <@UMIA>, could you review this?`]);
  // With no pull requests there is nothing to list: they are asked to review it.
  const none = changed({ status: { from: "IN_PROGRESS", to: "IN_REVIEW" }, task: { people: team([], ["UZOE"]) } });
  assert.deepEqual(changeRequests(none), ["<@UZOE>, could you review this?"]);
  // Pull requests all merged or closed leave nothing to review.
  const settled = changed({
    status: { from: "IN_PROGRESS", to: "IN_REVIEW" },
    task: { prs: [PR, MR], prStates: { [PR]: "MERGED", [MR]: "CLOSED" }, people: team([], ["UZOE"]) },
  });
  assert.deepEqual(changeRequests(settled), []);
});

test("an owner is asked only while the task is To do or In progress", () => {
  const owner = (status) =>
    changed({ people: [{ role: "owner", added: ["UBOB"], removed: [] }], task: { status, people: team(["UBOB"]) } });
  for (const status of ["TODO", "IN_PROGRESS"])
    assert.deepEqual(changeRequests(owner(status)), ["<@UBOB>, could you pick this up?"], status);
  for (const status of ["IN_REVIEW", "IN_TESTING", "CLIENT_REVIEW", "DONE"])
    assert.deepEqual(changeRequests(owner(status)), [], status);
});

test("no one is asked who made the change, was told already, or has nothing to do yet", () => {
  const people = (role, ...ids) => [{ role, added: ids, removed: [] }];
  // Made the change, or told by the message the suggestion came from.
  assert.deepEqual(
    changeRequests(changed({ people: people("owner", "UACTOR"), task: { people: team(["UACTOR"]) } })),
    [],
  );
  assert.deepEqual(
    changeRequests(
      changed({ people: people("owner", "UBOB"), told: { UBOB: null }, task: { people: team(["UBOB"]) } }),
    ),
    [],
  );
  // A reviewer before In review, a tester before In testing, an owner once Done.
  assert.deepEqual(
    changeRequests(changed({ people: people("reviewer", "UMIA"), task: { prs: [PR], people: team([], ["UMIA"]) } })),
    [],
  );
  assert.deepEqual(
    changeRequests(changed({ people: people("tester", "UTOM"), task: { people: team([], [], ["UTOM"]) } })),
    [],
  );
  assert.deepEqual(
    changeRequests(changed({ people: people("owner", "UBOB"), task: { status: "DONE", people: team(["UBOB"]) } })),
    [],
  );
  // Pull requests all merged are not for reviewers to review.
  const merged = fake<StoredTask>({
    status: "IN_REVIEW",
    people: team([], ["UMIA"]),
    prs: [PR],
    prStates: { [PR]: "MERGED" },
  });
  assert.deepEqual(changeRequests(changed({ people: people("reviewer", "UMIA"), task: merged })), []);
});

test("moving to In testing asks every tester once, those just added too", () => {
  const notes = changeRequests(
    changed({
      people: [{ role: "tester", added: ["UTESS"], removed: [] }],
      status: { from: "IN_REVIEW", to: "IN_TESTING" },
      task: { people: team([], [], ["UTOM", "UTESS", "UACTOR"]) },
    }),
  );
  assert.deepEqual(notes, ["<@UTESS>, <@UTOM>, could you give this a test?"]);
});

test("people removed are told only if they had been asked, and once", () => {
  // Removed from two roles: told only for the one they had been asked in, by the stage it was at.
  const both = (status) =>
    changed({
      people: [
        { role: "owner", added: [], removed: ["UALICE"] },
        { role: "reviewer", added: [], removed: ["UALICE"] },
      ],
      task: { status, prs: [PR] },
    });
  assert.deepEqual(changeRequests(both("IN_PROGRESS")), ["<@UALICE>, there's no need to work on this anymore."]);
  assert.deepEqual(changeRequests(both("IN_REVIEW")), ["<@UALICE>, there's no need to review this anymore."]);

  // A tester removed as it moves to In testing was never asked to test it.
  const testing = changed({
    people: [{ role: "tester", added: [], removed: ["UTOM"] }],
    status: { from: "IN_REVIEW", to: "IN_TESTING" },
  });
  assert.deepEqual(changeRequests(testing), []);

  // Nor a reviewer removed as the only pull request goes, or when it is Done.
  const noPrs = changed({ people: [{ role: "reviewer", added: [], removed: ["UMIA"] }] });
  assert.deepEqual(changeRequests(noPrs), []);
  const done = changed({ people: [{ role: "owner", added: [], removed: ["UBOB"] }], task: { status: "DONE" } });
  assert.deepEqual(changeRequests(done), []);
});

test("changes that are not about people ask no one", () => {
  assert.deepEqual(
    changeRequests(changed({ priority: { from: "High", to: "Low" }, dueDate: { from: "", to: "01/01/2027" } })),
    [],
  );
  assert.deepEqual(changeRequests(changed({ status: { from: "TODO", to: "IN_PROGRESS" } })), []);
});
