import assert from "node:assert/strict";
import test from "node:test";
import type { AppEnv } from "../src/env.ts";
import type { StoredTask } from "../src/types.ts";
import type { Project } from "../src/channels.ts";
import {
  DB,
  type Stored,
  blockText,
  duplicateActionIds,
  env,
  historyTask,
  interaction,
  mockSlack,
  send,
  storedTask,
  subtaskOf,
} from "./app.ts";

test("opening the Home tab shows the person's open tasks by what they do on them, most urgent first", async (t) => {
  const task = (ts, title, priority, status, people, dueDate = "") => ({
    channel: "CDEV",
    ts,
    task: {
      ...storedTask().task,
      title,
      priority,
      status,
      dueDate,
      people: { owner: [], reviewer: [], tester: [], ...people },
    },
  });
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      task("1.1", "Low chore", "Low", "TODO", { owner: ["UME"] }),
      task("2.1", "Urgent fix", "Urgent", "IN_PROGRESS", { owner: ["UME"] }, "01/01/2020"),
      task("3.1", "Review me", "High", "IN_REVIEW", { reviewer: ["UME"] }),
      task("4.1", "Not yet testable", "High", "IN_PROGRESS", { tester: ["UME"] }),
      task("5.1", "Someone else's", "Urgent", "TODO", { owner: ["UOTHER"] }),
      task("6.1", "Finished", "Urgent", "DONE", { owner: ["UME"] }),
    ],
  });
  const body = JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UBOT" }],
    event: { type: "app_home_opened", user: "UME", tab: "home" },
  });
  assert.equal((await send("/slack/events", body)).status, 200);

  const [publish] = calls.filter((call) => call.method === "views.publish");
  assert.equal(publish.args.user_id, "UME");
  const text = publish.args.view.blocks.map((block) => blockText(block) ?? "").join("\n");
  // Each task's title links to its thread.
  assert.match(text, /\*<https:\/\/acme\.slack\.com\/archives\/CDEV\/p21\?thread_ts=2\.1&cid=CDEV\|Urgent fix>\*/);
  assert.deepEqual(duplicateActionIds(publish.args.view.blocks), []);
  assert.ok(text.indexOf("Urgent fix") < text.indexOf("Low chore"));
  assert.match(text, /Overdue/);
  assert.match(text, /\|Urgent fix>\*\n:red_circle: Urgent  ·  :arrow_forward: In progress/);
  assert.match(text, /Review me/);
  assert.match(text, /Coming up[^]*Not yet testable/);
  assert.doesNotMatch(text, /Someone else's|Finished/);
  const headers = publish.args.view.blocks.filter((block) => block.type === "header").map(blockText);
  assert.deepEqual(headers, [
    "Your tasks",
    ":hammer_and_wrench: To work on (2)",
    ":eyes: To review (1)",
    ":test_tube: To test (0)",
    ":outbox_tray: Worked on (0)",
  ]);
  // No section ends with a gap before its divider, whatever its last line: To work on a card, To review
  // Coming up, To test and Worked on their empty line.
  const blocks = publish.args.view.blocks;
  const ends = blocks.filter((block, i) => block.type === "context" && blocks[i + 1]?.type === "divider");
  assert.equal(ends.length, 5);
  for (const block of ends) assert.doesNotMatch(blockText(block), /\u2800/);
  assert.match(text, /Worked on \(0\)\n_Nothing handed over yet\._/);
});

test("My Tasks lists what is before a role's turn as Coming up, and what is past it once, at the bottom, as Worked on", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      historyTask("1.1", { title: "Built it", owners: ["UME"], status: "IN_REVIEW" }),
      historyTask("2.1", { title: "Reviewed and built it", owners: ["UME"], reviewers: ["UME"], status: "IN_TESTING" }),
      historyTask("3.1", { title: "Review later", reviewers: ["UME"], status: "TODO" }),
      historyTask("3.5", { title: "Review now", reviewers: ["UME"], status: "IN_REVIEW" }),
      historyTask("4.1", { title: "Test later", testers: ["UME"], status: "IN_REVIEW" }),
      historyTask("5.1", { title: "Tested it", testers: ["UME"], status: "CLIENT_REVIEW" }),
    ],
  });
  await send(
    "/slack/interactions",
    interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:mine" }] }),
  );
  const blocks = calls.find((call) => call.method === "views.publish").args.view.blocks;
  const text = blocks.map((block) => blockText(block) ?? "").join("\n");
  const section = (from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to) : undefined);
  // Nothing comes before working on a task, so To work on has no Coming up.
  assert.doesNotMatch(section("To work on", "To review"), /Coming up/);
  assert.match(section("To review", "To test"), /\*Coming up\*\n<[^|]+\|Review later>  ·  :memo: To do$/m);
  // A card keeps its gap before Coming up, though not before a divider.
  const comingUp = blocks.findIndex((block) => /^\*Coming up\*\n[^\n]*Review later/.test(blockText(block) ?? ""));
  assert.match(blockText(blocks[comingUp - 1]), /\n\u2800$/);
  assert.doesNotMatch(blockText(blocks[comingUp]), /\u2800/);
  assert.match(section("To test", "Worked on ("), /\*Coming up\*\n<[^|]+\|Test later>  ·  :eyes: In review$/m);
  // Each handed-over task once, in small type under a header like the others, with the roles it was theirs in.
  const header = blocks.findIndex(
    (block) => block.type === "header" && blockText(block) === ":outbox_tray: Worked on (3)",
  );
  assert.ok(header > 0);
  assert.equal(blocks[header + 1].type, "context");
  const lines = blockText(blocks[header + 1]).split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines.some((line) => /\|Built it>  ·  :eyes: In review  ·  _Owner_$/.test(line)));
  assert.ok(
    lines.some((line) => /\|Reviewed and built it>  ·  :test_tube: In testing  ·  _Owner, Reviewer_$/.test(line)),
  );
  assert.ok(lines.some((line) => /\|Tested it>  ·  :raising_hand: Client review  ·  _Tester_$/.test(line)));
  assert.ok(text.indexOf("Worked on (") > text.indexOf("To test"));
});

test("By person shows a picked team member's tasks as My Tasks shows yours, and Refresh keeps the pick", async (t) => {
  const stored = [
    historyTask("1.1", { title: "Rex builds", owners: ["UREX"], status: "IN_PROGRESS" }),
    historyTask("2.1", { title: "Rex reviews", owners: ["UME"], reviewers: ["UREX"], status: "IN_REVIEW" }),
    historyTask("3.1", { title: "Rex handed over", owners: ["UREX"], status: "IN_TESTING" }),
    historyTask("4.1", { title: "Not Rex's", owners: ["UOTHER"] }),
  ];
  const draw = async (action) => {
    const calls = mockSlack(t, {
      "auth.test": { url: "https://acme.slack.com/", user_id: "UBOT" },
      "conversations.members": { members: ["UREX", "UBOT", "UME", "UBOB"] },
      "users.info": ({ user }) => ({
        user: { profile: { display_name: { UREX: "Rex", UME: "Me", UBOB: "Bob" }[user] } },
      }),
      stored,
    });
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [action] }));
    const { blocks } = calls.find((call) => call.method === "views.publish").args.view;
    assert.deepEqual(duplicateActionIds(blocks), []);
    return blocks;
  };
  const text = (blocks) => blocks.map((block) => blockText(block) ?? "").join("\n");
  const picker = (blocks) =>
    blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === "home:person");

  // No one picked yet: the project channel's people by name, without Cade, and a line asking for one.
  const empty = await draw({ action_id: "home:tab:person" });
  assert.deepEqual(
    picker(empty).options.map((option) => [option.text.text, option.value]),
    [
      ["Bob", "UBOB"],
      ["Me", "UME"],
      ["Rex", "UREX"],
    ],
  );
  assert.equal(picker(empty).initial_option, undefined);
  assert.match(text(empty), /Pick a team member to see their tasks/);
  assert.doesNotMatch(text(empty), /Rex builds/);

  // Picking Rex shows Rex's tasks, in the sections My Tasks has, and says whose.
  const rex = await draw({ action_id: "home:person", selected_option: { value: "UREX" } });
  assert.equal(picker(rex).initial_option.value, "UREX");
  const headers = rex.filter((block) => block.type === "header").map(blockText);
  assert.deepEqual(headers, [
    "Rex's tasks",
    ":hammer_and_wrench: To work on (1)",
    ":eyes: To review (1)",
    ":test_tube: To test (0)",
    ":outbox_tray: Worked on (1)",
  ]);
  assert.match(text(rex), /\*2\* waiting on <@UREX>/);
  assert.match(text(rex), /\|Rex builds>/);
  // The people line still speaks to the viewer: their own part is "you".
  assert.match(text(rex), /\|Rex reviews>\*\n[^\n]+\nOwner you/);
  assert.doesNotMatch(text(rex), /Not Rex's/);

  // Refresh and the project picker draw the view again on Rex, as the view carries the pick.
  const refresh = rex[0].elements.find((element) => element.action_id === "home:refresh");
  assert.equal(refresh.value, "person:UREX");
  const again = await draw({ action_id: "home:refresh", value: refresh.value });
  assert.equal(picker(again).initial_option.value, "UREX");
  assert.match(text(again), /Rex builds/);
  // The pick isn't kept beyond the view: the tab opens without one.
  const reopened = await draw({ action_id: "home:tab:person" });
  assert.equal(picker(reopened).initial_option, undefined);
});

test("By person asks for a pick again when the one picked isn't in the project's channel, as after switching project", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/", user_id: "UBOT" },
    "conversations.members": { members: ["UME"] },
  });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UME" },
      actions: [{ action_id: "home:refresh", value: "person:UGONE" }],
    }),
  );
  const text = calls
    .find((call) => call.method === "views.publish")
    .args.view.blocks.map((block) => blockText(block) ?? "")
    .join("\n");
  assert.match(text, /Pick a team member/);
});

test("All Tasks splits tasks by status into Working on, In review, In testing and Delivered, by priority, with subtasks under their task", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      historyTask("1.1", { title: "Low todo", priority: "Low", status: "TODO" }),
      historyTask("2.1", { title: "Urgent doing", priority: "Urgent", status: "IN_PROGRESS" }),
      historyTask("3.1", { title: "Reviewing", status: "IN_REVIEW" }),
      subtaskOf("3.2", {
        title: "Low part",
        priority: "Low",
        status: "TODO",
        parent: { ts: "3.1", title: "Reviewing" },
      }),
      subtaskOf("3.3", {
        title: "Urgent part",
        priority: "Urgent",
        status: "IN_TESTING",
        parent: { ts: "3.1", title: "Reviewing" },
      }),
      historyTask("4.1", { title: "With client", status: "CLIENT_REVIEW" }),
    ],
  });
  await send(
    "/slack/interactions",
    interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:all" }] }),
  );
  const blocks = calls.find((call) => call.method === "views.publish").args.view.blocks;
  const text = blocks.map((block) => blockText(block) ?? "").join("\n");
  const headers = blocks.filter((block) => block.type === "header").map(blockText);
  assert.deepEqual(headers, [
    "All open tasks",
    ":arrow_forward: Working on (2)",
    ":eyes: In review (1)",
    ":test_tube: In testing (0)",
    ":raising_hand: Delivered (1)",
  ]);
  const at = (title) => text.indexOf(`|${title}>`);
  // Most urgent first within a section.
  assert.ok(at("Urgent doing") < at("Low todo") && at("Low todo") < text.indexOf("In review ("));
  // Subtasks go with their task, whatever their own status, most urgent first.
  assert.ok(
    text.indexOf("In review (") < at("Reviewing") &&
      at("Reviewing") < at("Urgent part") &&
      at("Urgent part") < at("Low part"),
  );
  assert.ok(at("Low part") < text.indexOf("In testing ("));
  assert.match(text, /In testing \(0\)\n_Nothing in testing\._/);
  assert.ok(text.indexOf("Delivered (") < at("With client"));
});

test("the Home tab's buttons switch between My Tasks, Unassigned and All Tasks, and Refresh stays on the view", async (t) => {
  const task = (ts: string, title: string, people?: Partial<StoredTask["people"]>): Stored => ({
    channel: "CDEV",
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: [], reviewer: [], tester: [], ...people } },
  });
  const stored = [
    task("1.1", "Mine", { owner: ["UME"] }),
    task("2.1", "Nobody's", {}),
    task("3.1", "Theirs", { owner: ["UOTHER"] }),
  ];
  const view = async (action_id: string, value?: string) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    const body = interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id, value }] });
    assert.equal((await send("/slack/interactions", body)).status, 200);
    const [publish] = calls.filter((call) => call.method === "views.publish");
    assert.deepEqual(duplicateActionIds(publish.args.view.blocks), []);
    const buttons = publish.args.view.blocks
      .flatMap((block) => block.elements ?? [])
      .filter((element) => element.type === "button");
    return {
      text: publish.args.view.blocks.map((block) => blockText(block) ?? "").join("\n"),
      primary: buttons.filter((b) => b.style).map((b) => b.text.text),
    };
  };
  const unassigned = await view("home:tab:unassigned");
  assert.match(unassigned.text, /Nobody's/);
  assert.doesNotMatch(unassigned.text, /Mine|Theirs/);
  assert.deepEqual(unassigned.primary, ["Home", "Unassigned"]);
  const all = await view("home:tab:all");
  assert.match(all.text, /Mine[^]*Nobody's[^]*Theirs|Mine[^]*Theirs[^]*Nobody's/);
  assert.doesNotMatch(all.text, /Assign to me/);
  assert.deepEqual(all.primary, ["Home", "All Tasks"]);
  const refreshed = await view("home:refresh", "unassigned");
  assert.deepEqual(refreshed.primary, ["Home", "Unassigned"]);
  assert.deepEqual((await view("home:tab:mine")).primary, ["Home", "My Tasks"]);
});

test("Assign to me on the Home tab's Unassigned view makes the person the owner, unless someone took it", async (t) => {
  const task = (ts: string, title: string, people?: Partial<StoredTask["people"]>): Stored => ({
    channel: "CDEV",
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: [], reviewer: [], tester: [], ...people } },
  });
  const stored = [
    task("1.1", "Mine", { owner: ["UME"] }),
    task("2.1", "Nobody's", {}),
    task("3.1", "Taken", { owner: ["UOTHER"] }),
  ];
  const claim = async (ts) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    const body = interaction({
      type: "block_actions",
      user: { id: "UME" },
      actions: [{ action_id: `home:claim:CDEV:${ts}` }],
    });
    assert.equal((await send("/slack/interactions", body)).status, 200);
    return calls;
  };
  const buttons = (calls) =>
    calls
      .find((call) => call.method === "views.publish")
      .args.view.blocks.flatMap((block) => block.elements ?? [])
      .filter((e) => e.text?.text === "Assign to me");
  const claimed = await claim("2.1");
  assert.equal(claimed.filter((call) => call.method === "chat.update").length, 1);
  assert.equal(claimed.find((call) => call.method === "views.publish").args.user_id, "UME");
  // It is drawn again without the task, now owned.
  assert.deepEqual(buttons(claimed), []);
  const drawn = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [task("2.1", "Nobody's", {}), task("1.1", "Mine", { owner: ["UME"] })],
  });
  await send(
    "/slack/interactions",
    interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:unassigned" }] }),
  );
  assert.deepEqual(
    buttons(drawn).map((b) => b.action_id),
    ["home:claim:CDEV:2.1"],
  );
  const late = await claim("3.1");
  assert.equal(late.filter((call) => call.method === "chat.update").length, 0);
  assert.equal(late.filter((call) => call.method === "views.publish").length, 1);
});

test("the Home tab shows only the projects whose channel the person is in, public or private", async (t) => {
  const task = (channel: string, ts: string, title: string): Stored => ({
    channel,
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: ["UME"], reviewer: [], tester: [] } },
  });
  const stored = [task("CDEV", "1.1", "In acme"), task("CTESTDEV", "2.1", "In test")];
  const publishOf = (calls) => calls.findLast((call) => call.method === "views.publish").args.view;
  const textOf = (view) => view.blocks.map((block) => blockText(block) ?? "").join("\n");
  const picker = (view) =>
    view.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === "home:project");
  const opened = () =>
    send(
      "/slack/events",
      JSON.stringify({
        type: "event_callback",
        authorizations: [{ user_id: "UBOT" }],
        event: { type: "app_home_opened", user: "UME", tab: "home" },
      }),
    );

  // UME is in test's channel only, and had picked acme before.
  let calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "conversations.members": (args) => ({ members: args.channel === "CTESTDEV" ? ["UME"] : ["UBOB"] }),
    stored,
  });
  await DB.prepare("INSERT INTO user_preferences (user_id, home_project) VALUES (?, ?)").bind("UME", "acme").run();
  await opened();
  let view = publishOf(calls);
  assert.deepEqual(
    picker(view).options.map((option) => option.value),
    ["test"],
  );
  assert.match(textOf(view), /In test/);
  assert.doesNotMatch(textOf(view), /In acme/);

  // In none: no tasks, and told why.
  calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "conversations.members": { members: ["UBOB"] },
    stored,
  });
  await opened();
  view = publishOf(calls);
  assert.equal(picker(view), undefined);
  assert.match(textOf(view), /aren't in any project's channel yet/);
  assert.doesNotMatch(textOf(view), /In acme|In test/);
});

test("the Home tab's project picker keeps the person's project for next time", async (t) => {
  const task = (channel: string, ts: string, title: string): Stored => ({
    channel,
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: ["UME"], reviewer: [], tester: [] } },
  });
  const stored = [task("CDEV", "1.1", "In acme"), task("CTESTDEV", "2.1", "In test")];
  const publishOf = (calls) => calls.find((call) => call.method === "views.publish").args.view;
  const textOf = (view) => view.blocks.map((block) => blockText(block) ?? "").join("\n");
  const interact = (action) =>
    send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: "UME" },
        view: { private_metadata: "mine" },
        actions: [action],
      }),
    );

  let calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await interact({ action_id: "home:project", selected_option: { value: "test" } });
  let view = publishOf(calls);
  assert.match(textOf(view), /In test/);
  assert.doesNotMatch(textOf(view), /In acme/);
  const picker = view.blocks
    .flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === "home:project");
  assert.equal(picker.initial_option.value, "test");

  // Remembered when the tab is opened later, without the stored tasks being reset.
  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await DB.prepare("INSERT INTO user_preferences (user_id, home_project) VALUES (?, ?)").bind("UME", "test").run();
  await send(
    "/slack/events",
    JSON.stringify({
      type: "event_callback",
      authorizations: [{ user_id: "UBOT" }],
      event: { type: "app_home_opened", user: "UME", tab: "home" },
    }),
  );
  assert.doesNotMatch(textOf(publishOf(calls)), /In acme/);

  // With none chosen, or one that is gone, the first project is shown, and the picker has no "all".
  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await interact({ action_id: "home:project", selected_option: { value: "gone" } });
  view = publishOf(calls);
  assert.match(textOf(view), /In acme/);
  assert.doesNotMatch(textOf(view), /In test/);
  const options = view.blocks
    .flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === "home:project").options;
  assert.deepEqual(
    options.map((option) => option.value),
    ["acme", "test"],
  );
  // The tab is remembered too: it opens on Unassigned after that was last used.
  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await interact({ action_id: "home:tab:unassigned" });
  await send(
    "/slack/events",
    JSON.stringify({
      type: "event_callback",
      authorizations: [{ user_id: "UBOT" }],
      event: { type: "app_home_opened", user: "UME", tab: "home" },
    }),
  );
  assert.match(textOf(calls.filter((call) => call.method === "views.publish").at(-1).args.view), /Unassigned tasks/);
  assert.equal(
    await DB.prepare("SELECT home_project FROM user_preferences WHERE user_id = ?")
      .bind("UME")
      .first()
      .then((row) => row.home_project),
    null,
  );
});

test("Settings on the Home tab has the person's own setup, and for an admin a project picker with that project's settings and Edit", async (t) => {
  const stored: Stored[] = [
    {
      channel: "CDEV",
      ts: "1.1",
      task: { ...storedTask().task, status: "TODO", people: { owner: ["UME"], reviewer: [], tester: [] } },
    },
  ];
  const open = async (action: string, user: string, environment: AppEnv = env, seed?: () => Promise<unknown>) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    await seed?.();
    await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: user },
        view: { private_metadata: "mine" },
        actions: [{ action_id: action }],
      }),
      {},
      environment,
    );
    const view = calls.find((call) => call.method === "views.publish").args.view;
    assert.deepEqual(duplicateActionIds(view.blocks), []);
    const elements = view.blocks.flatMap((block) => [
      ...(block.elements ?? []),
      ...(block.accessory ? [block.accessory] : []),
    ]);
    const buttons = elements.filter((element) => element.type === "button");
    return {
      view,
      names: buttons.map((button) => button.text.text),
      pickers: elements.filter((element) => element.action_id === "home:project").length,
      settings: buttons.find((button) => button.action_id === "home:settings"),
      text: view.blocks.map((block) => blockText(block) ?? "").join("\n"),
    };
  };
  const settings = (user: string, environment?: AppEnv, seed?: () => Promise<unknown>) =>
    open("home:section:configure", user, environment, seed);
  const admin = { ...env, ADMINS: JSON.stringify(["UME"]) };
  // Everyone: Home, Settings and Refresh along the top, then their own setup, each with how it stands and a button to change it.
  // No project picker, task tabs or Add project there.
  const member = await settings("UME");
  assert.equal(member.view.private_metadata, "configure");
  assert.deepEqual(member.names, ["Home", "Settings", "Refresh", "Manage", "Manage", "Turn off"]);
  assert.equal(member.view.blocks[0].elements[1].style, "primary");
  assert.equal(member.pickers, 0);
  assert.match(member.text, /Just for you\n\*Web pages\*\n:x: Not signed in on any browser/);
  assert.match(member.text, /\*AI agent\*\n:x: No key yet/);
  assert.doesNotMatch(member.text, /Projects|Project settings/);
  // The picture follows what the person has done, without opening anything.
  const set = await settings("UME", env, async () => {
    await DB.prepare(
      "INSERT INTO web_tokens (token_hash, user_id, kind, expires_at) VALUES ('h1', 'UME', 'session', datetime('now', '+1 day')), ('h2', 'UME', 'session', datetime('now', '+1 day')), ('h3', 'UME', 'session', datetime('now', '-1 day'))",
    ).run();
    await DB.prepare("INSERT INTO mcp_tokens (user_id, token_hash) VALUES ('UME', 'k1')").run();
  });
  assert.match(set.text, /:white_check_mark: Signed in on 2 browsers/);
  assert.match(set.text, /:white_check_mark: Configured · key made \d{4}-\d{2}-\d{2} · \d+ tools/);
  // An admin also has Projects: the picker, then the picked project's people and switches, with Edit for the form.
  const asAdmin = await settings("UME", admin);
  assert.deepEqual(asAdmin.names, ["Home", "Settings", "Refresh", "Manage", "Manage", "Turn off", "Edit"]);
  assert.equal(asAdmin.pickers, 1);
  assert.equal(asAdmin.settings.value, "CDEV");
  assert.match(
    asAdmin.text,
    /Projects\n[\s\S]*\*Project settings\*\n\*acme\* in <#CDEV>\nTask change detection: on  ·  New task detection: on/,
  );
  // MCP off: it says so, with no button.
  const off = await settings("UME", { ...env, MCP: "off" });
  assert.deepEqual(off.names, ["Home", "Settings", "Refresh", "Manage", "Turn off"]);
  assert.match(off.text, /\*AI agent\*\n:x: Turned off by an admin/);
  // Suggestions name every project where an admin turned them off, whichever project is picked.
  const projectsOff = (env.PROJECTS as Project[]).map((pair) =>
    pair.channel === "CDEV" ? pair : { ...pair, taskChangeDetection: false },
  );
  const named = await settings("UME", { ...env, PROJECTS: projectsOff });
  const others = projectsOff
    .filter((pair) => pair.channel !== "CDEV")
    .map((pair) => `\\*${pair.name}\\*`)
    .join(", ");
  assert.match(named.text, new RegExp(`Turned off for everyone by an admin in ${others}\\.`));

  // Home: the same top row, then the project picker with Add project (for an admin), then the task tabs.
  const home = await open("home:section:home", "UME", admin);
  assert.equal(home.view.private_metadata, "mine");
  assert.deepEqual(
    home.view.blocks[0].elements.map((element) => element.text.text),
    ["Home", "Settings", "Refresh"],
  );
  assert.equal(home.view.blocks[0].elements[0].style, "primary");
  // A line between the top row and the rest, on Home as on Settings.
  assert.equal(home.view.blocks[1].type, "divider");
  assert.equal(member.view.blocks[1].type, "divider");
  assert.deepEqual(
    home.view.blocks[2].elements.map((element) => element.action_id),
    ["home:project", "home:project:add"],
  );
  assert.deepEqual(
    home.view.blocks[3].elements.map((element) => element.text.text),
    ["My Tasks", "By person", "Unassigned", "All Tasks"],
  );
  const memberHome = await open("home:section:home", "UME");
  assert.deepEqual(
    memberHome.view.blocks[2].elements.map((element) => element.action_id),
    ["home:project"],
  );
});

test("with no projects yet, Home offers an admin Add project, and Settings still has the person's own setup", async (t) => {
  const draw = async (action: string, environment: AppEnv) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
    await send(
      "/slack/interactions",
      interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: action }] }),
      {},
      environment,
    );
    return calls.find((call) => call.method === "views.publish").args.view.blocks;
  };
  const none = { ...env, PROJECTS: "[]" };
  const admin = { ...none, ADMINS: JSON.stringify(["UME"]) };
  const adminHome = await draw("home:section:home", admin);
  assert.equal(adminHome[2].text.text, "There are no projects yet.");
  assert.equal(adminHome[2].accessory.action_id, "home:project:add");
  const memberHome = await draw("home:section:home", none);
  assert.match(blockText(memberHome[2]), /There are no projects yet\. An admin adds one on this tab\./);
  const adminSettings = (await draw("home:section:configure", admin)).map((block) => blockText(block) ?? "").join("\n");
  assert.match(adminSettings, /\*Suggestions\*/);
  assert.match(adminSettings, /Projects\n_There are no projects yet\. Add one with Add project on Home\._/);
});

test("the Home tab's Refresh button draws it again", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [storedTask({ owners: ["UME"] })],
  });
  const body = interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:refresh" }] });
  assert.equal((await send("/slack/interactions", body)).status, 200);
  const [publish] = calls.filter((call) => call.method === "views.publish");
  assert.equal(publish.args.user_id, "UME");
  assert.match(publish.args.view.blocks.map((block) => blockText(block) ?? "").join("\n"), /Fix login/);

  // npm run setup reads the Worker's URL from the deploy, and .
  const { workerUrlIn } = await import("../scripts/setup.ts");
  assert.equal(workerUrlIn("Deployed cade (1s)\n  https://cade.acme.workers.dev\n"), "https://cade.acme.workers.dev");

  // …and offers the Cloudflare accounts by name, from wrangler whoami's table.
  const { accountsIn } = await import("../scripts/setup.ts");
  const a = "0123456789abcdef0123456789abcdef";
  const b = "fedcba9876543210fedcba9876543210";
  const whoami = [
    "┌────────────────┬──────────────────────────────────┐",
    "│ Account Name   │ Account ID                       │",
    "├────────────────┼──────────────────────────────────┤",
    `│ Acme's Account │ ${a} │`,
    `│ XTECHLK        │ ${b} │`,
    "└────────────────┴──────────────────────────────────┘",
  ].join("\n");
  assert.deepEqual(accountsIn(whoami), [
    { id: a, name: "Acme's Account" },
    { id: b, name: "XTECHLK" },
  ]);
  assert.deepEqual(accountsIn(`Account ID: ${a}`), [{ id: a, name: a }]);
});

test("the Home tab never has more than Slack's 100 blocks, however many subtasks there are", async (t) => {
  const stored: Stored[] = [];
  for (let i = 1; i <= 12; i++) {
    const ts = `${100 + i}.1`;
    stored.push(historyTask(ts, { title: `Task ${i}`, owners: ["UME"] }));
    for (let j = 1; j <= 8; j++)
      stored.push(subtaskOf(`${100 + i}.${j + 1}`, { title: `Part ${i}.${j}`, parent: { ts, title: `Task ${i}` } }));
  }
  for (const action_id of ["home:tab:mine", "home:tab:all"]) {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    await send(
      "/slack/interactions",
      interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id }] }),
    );
    const { blocks } = calls.find((call) => call.method === "views.publish").args.view;
    assert.ok(blocks.length <= 100, `${action_id}: ${blocks.length} blocks`);
    // What doesn't fit is counted rather than left out without a word.
    assert.match(blocks.map((block) => blockText(block) ?? "").join("\n"), /more/, action_id);
  }
});
