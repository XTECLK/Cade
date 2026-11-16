import assert from "node:assert/strict";
import test from "node:test";
import {
  MR,
  PR,
  PR3,
  PR4,
  RESPONSE_URL,
  allBlocks,
  blockText,
  drafts,
  env,
  footerLines,
  interaction,
  linkedNote,
  messageLink,
  mockGitHub,
  mockSlack,
  noteValue,
  ownTask,
  prsLineOf,
  recordResponses,
  runTasksCommand,
  savedTask,
  seeded,
  send,
  storedTask,
  suggestionButtons,
  threadEvent,
  threadReply,
  withStatus,
  workLines,
} from "./app.ts";

// The card's Pull requests button, clicked on the task at CDEV/100.1.
const prsClick = () =>
  interaction({
    type: "block_actions",
    trigger_id: "T1",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    message: { ts: "100.1" },
    actions: [{ action_id: "task:prs" }],
  });

// The Pull requests form saved with `box` in its box.
const prsSubmission = (box) =>
  interaction({
    type: "view_submission",
    user: { id: "UACTOR" },
    view: {
      callback_id: "task:prs",
      private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1" }),
      state: { values: { prs: { value: { value: box } } } },
    },
  });

test("the card's Pull requests button lists them in Open, Merged and Closed, as full links, with Edit on Open only, which opens the form for the open ones", async (t) => {
  const record = ownTask();
  record.task.prs = [PR, MR, PR3, PR4];
  record.task.prStates = { [PR3]: "MERGED", [PR4]: "CLOSED" };
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/interactions", prsClick());
  const { view, trigger_id } = calls.find((call) => call.method === "views.open").args;
  assert.equal(trigger_id, "T1");
  // Only to see: no submit, and nothing to type in.
  assert.equal(view.submit, undefined);
  const sections = view.blocks.filter((block) => block.type === "section");
  // The GitLab one can't be read from GitHub, so it's open.
  assert.deepEqual(
    sections.map((block) => block.text.text),
    [`*Open*\n<${PR}>\n<${MR}>`, `*Merged*\n<${PR3}>`, `*Closed*\n<${PR4}>`],
  );
  assert.deepEqual(
    sections.map((block) => block.accessory?.action_id),
    ["prs:edit", undefined, undefined],
  );

  // Edit opens the form on top of the list, with the open ones in its box.
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "T2",
      user: { id: "UACTOR" },
      actions: [{ action_id: "prs:edit", value: sections[0].accessory.value }],
    }),
  );
  const pushed = calls.find((call) => call.method === "views.push").args;
  assert.equal(pushed.trigger_id, "T2");
  assert.equal(pushed.view.callback_id, "task:prs");
  assert.deepEqual(
    pushed.view.blocks.map((block) => block.block_id),
    ["prs"],
  );
  assert.equal(pushed.view.blocks[0].element.initial_value, `${PR}\n${MR}`);

  // With none, every section says so, and Open still has Edit, to add one.
  const none = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", prsClick());
  const empty = none
    .find((call) => call.method === "views.open")
    .args.view.blocks.filter((block) => block.type === "section");
  assert.deepEqual(
    empty.map((block) => block.text.text),
    ["*Open*\n_None_", "*Merged*\n_None_", "*Closed*\n_None_"],
  );
  assert.equal(empty[0].accessory.action_id, "prs:edit");
});

test("saving the Pull requests form links new links and unlinks open ones taken out, keeping merged and closed ones", async (t) => {
  const record = ownTask();
  record.task.prs = [PR, MR, PR3];
  record.task.prStates = { [PR3]: "MERGED" };
  const calls = mockSlack(t, { stored: [record] });
  // PR taken out, PR4 added; the merged one written in again changes nothing.
  const sent = await send("/slack/interactions", prsSubmission(`${MR}\n<${PR4}|web/9>\n${PR3}`));
  assert.deepEqual(await sent.json(), { response_action: "clear" });
  assert.deepEqual((await savedTask()).prs, [MR, PR3, PR4]);
  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").args;
  assert.equal(post.text, `<@UACTOR> linked <${PR4}|web/9>.\n<@UACTOR> unlinked <${PR}|cade/42>.`);

  // An empty box unlinks the open ones only.
  mockSlack(t, { stored: [record] });
  await send("/slack/interactions", prsSubmission(""));
  assert.deepEqual((await savedTask()).prs, [PR3]);

  // A link that isn't a pull request is refused in the form, and nothing changes.
  mockSlack(t, { stored: [record] });
  const refused = await send("/slack/interactions", prsSubmission(`${PR}\nnot a link`));
  assert.deepEqual(await refused.json(), {
    response_action: "errors",
    errors: { prs: "That doesn't look like a pull request link: not a link" },
  });
  assert.deepEqual((await savedTask()).prs, [PR, MR, PR3]);
});

test("the sync reads where open tasks' GitHub pull requests stand, saves it, and redraws the cards that changed", async (t) => {
  const { syncPullRequests } = await import("../src/github.ts");
  const open = storedTask();
  open.task.prs = [PR, PR3, MR];
  const done = withStatus("DONE");
  done.ts = "100.2";
  done.task.prs = [PR4];
  const calls = mockSlack(t, { stored: [open, done] });
  const asked = mockGitHub({ 42: "MERGED", 43: null });
  const withToken = { ...env, GITHUB_TOKEN: "ghp_test" };
  await seeded;
  await syncPullRequests(withToken);

  // One query, with the token, for the open task's GitHub pull requests: not GitLab's, nor a Done task's.
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.authorization, "bearer ghp_test");
  assert.match(
    asked[0]!.query,
    /repository\(owner: "acme", name: "cade"\) \{ pullRequest\(number: 42\) \{ state \} \}/,
  );
  assert.match(asked[0]!.query, /pullRequest\(number: 43\)/);
  assert.doesNotMatch(asked[0]!.query, /web-app|number: 9\)/);
  // The one it couldn't read stays open; the card is redrawn with the merged one.
  assert.deepEqual((await savedTask()).prStates, { [PR]: "MERGED" });
  const cards = calls.filter((call) => call.method === "chat.update");
  assert.deepEqual(
    cards.map((call) => call.args.ts),
    ["100.1"],
  );
  assert.equal(prsLineOf(cards[0]!.args), "Pull requests: 2 open  ·  1 merged");

  // A merged one isn't asked again; one that hasn't changed redraws nothing.
  calls.length = 0;
  const again = mockGitHub({ 43: null });
  await syncPullRequests(withToken);
  assert.equal(again.length, 1);
  assert.doesNotMatch(again[0]!.query, /number: 42\)/);
  assert.ok(!calls.some((call) => call.method === "chat.update"));
});

test("open pull requests merged or closed on GitHub are told in each task's thread, one message a task", async (t) => {
  const { syncPullRequests } = await import("../src/github.ts");
  const PR5 = "https://github.com/acme/cade/pull/44";
  const PR6 = "https://github.com/acme/cade/pull/45";
  const open = storedTask({ status: "IN_REVIEW" });
  open.task.prs = [PR, PR3, PR5, PR6];
  open.task.prStates = { [PR]: "OPEN", [PR3]: "OPEN", [PR5]: "OPEN" };
  const other = storedTask();
  other.ts = "100.2";
  other.task.prs = [PR3];
  other.task.prStates = { [PR3]: "OPEN" };
  const calls = mockSlack(t, { stored: [open, other] });
  // 42 merged and 43 closed, 44 still open, 45 read for the first time already merged.
  mockGitHub({ 42: "MERGED", 43: "CLOSED", 44: "OPEN", 45: "MERGED" });
  await seeded;
  await syncPullRequests({ ...env, GITHUB_TOKEN: "ghp_test" });

  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(posts.map((call) => [call.args.thread_ts, call.args.text]).sort(), [
    ["100.1", `<${PR}|cade/42> was merged on GitHub.\n<${PR3}|cade/43> was closed on GitHub without merging.`],
    ["100.2", `<${PR3}|cade/43> was closed on GitHub without merging.`],
  ]);

  // Read again with nothing new, nothing is told again.
  calls.length = 0;
  mockGitHub({ 44: "OPEN" });
  await syncPullRequests({ ...env, GITHUB_TOKEN: "ghp_test" });
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("several pull requests of a task merged in one read are named together", async (t) => {
  const { syncPullRequests } = await import("../src/github.ts");
  const record = storedTask();
  record.task.prs = [PR, PR3];
  record.task.prStates = { [PR]: "OPEN", [PR3]: "OPEN" };
  const calls = mockSlack(t, { stored: [record] });
  mockGitHub({ 42: "MERGED", 43: "MERGED" });
  await seeded;
  await syncPullRequests({ ...env, GITHUB_TOKEN: "ghp_test" });
  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(
    posts.map((call) => call.args.text),
    [`<${PR}|cade/42>, <${PR3}|cade/43> were merged on GitHub.`],
  );
});

test("without GITHUB_TOKEN nothing is read from GitHub, and every pull request counts as open", async (t) => {
  const { syncPullRequests } = await import("../src/github.ts");
  const record = storedTask();
  record.task.prs = [PR];
  const calls = mockSlack(t, { stored: [record] });
  const asked = mockGitHub({ 42: "MERGED" });
  await seeded;
  await syncPullRequests(env);
  assert.equal(asked.length, 0);
  assert.equal(calls.length, 0);
});

test("@Cade pr add links pull requests, counted on one line of the card, and reacts ✅", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}/files> <${MR}|the MR> ${PR}`));

  // No reviewer yet, but it's To do, so nothing is asked: just the ✅.
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add"],
  );
  const blocks = allBlocks(calls[0].args);
  // Stored without the /files tab, and only once.
  assert.deepEqual((await savedTask()).prs, [PR, MR]);
  // No GITHUB_TOKEN, so the GitHub one is saved as open, and the other host's counts as open.
  assert.deepEqual((await savedTask()).prStates, { [PR]: "OPEN", [MR]: "OPEN" });
  // Counted in the work block, after the status, before the people.
  assert.equal(blocks.at(-2).type, "context");
  // Its count is in the first block; the work block is the status and people.
  assert.equal(blockText(allBlocks(calls[0].args).at(-3)), "Pull requests: 2 open  ·  0 merged");
  assert.deepEqual(workLines(calls[0].args), [":memo: To do  ·  Due 31/10/2026", "_Unassigned_"]);
  assert.match(footerLines(calls[0].args)[1], /^Tracked by/);
  assert.equal(calls[1].args.name, "white_check_mark");
});

test("tasks without pull requests show no PRs line", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));
  // The title, the work block (status and people) and who tracked it.
  assert.equal(allBlocks(calls[0].args).length, 3);
  assert.deepEqual(workLines(calls[0].args), [":arrow_forward: In progress  ·  Due 31/10/2026", "_Unassigned_"]);
  // Made in Slack, not through an AI agent.
  assert.match(footerLines(calls[0].args)[1], /^Tracked by <@\w+>$/);
});

test("@Cade pr add skips pull requests already linked", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  let calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}> <${MR}>`));
  assert.deepEqual((await savedTask()).prs, [PR, MR]);
  assert.equal(calls[1].args.name, "white_check_mark");

  calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage"],
  );
  assert.equal(calls[0].args.text, "Those pull requests are already linked to this task, so we're all set.");
});

test("@Cade pr remove unlinks pull requests", async (t) => {
  const root = storedTask();
  root.task.prs = [PR, MR];
  let calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).prs, [MR]);
  assert.equal(prsLineOf(calls[0].args), "Pull requests: 1 open  ·  0 merged");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add"],
  );
  assert.equal(calls[1].args.name, "white_check_mark");

  // Removing the last one removes the PRs line.
  root.task.prs = [PR];
  calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).prs, []);
  assert.equal(allBlocks(calls[0].args).length, 3);

  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.equal(calls.at(-1).args.text, "Hmm, those pull requests aren't linked to this task.");
});

test("@Cade pr needs add or remove and a pull request link", async (t) => {
  for (const [text, reply] of [
    [`<@UBOT> pr <${PR}>`, "Try `@Cade pr add <link>` or `@Cade pr remove <link>`."],
    ["<@UBOT> pr", "Try `@Cade pr add <link>` or `@Cade pr remove <link>`."],
    ["<@UBOT> pr add", "Which pull request? Paste its link. Try `@Cade pr add <link>` or `@Cade pr remove <link>`."],
    [
      "<@UBOT> pr add <https://github.com/acme/cade/issues/3>",
      "Hmm, that doesn't look like a pull request link: https://github.com/acme/cade/issues/3",
    ],
  ] as const) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["chat.postMessage"],
      text,
    );
    assert.equal(calls[0].args.text, reply, text);
  }
});

test("pull requests on GitHub, GitLab and Bitbucket are read as reponame/number", async () => {
  const { parsePullRequest } = await import("../src/tasks.ts");
  assert.deepEqual(parsePullRequest(`${PR}/files`), { url: PR, repo: "cade", number: "42" });
  assert.equal(parsePullRequest(MR).repo, "web-app");
  assert.deepEqual(parsePullRequest("https://bitbucket.org/acme/api/pull-requests/7"), {
    url: "https://bitbucket.org/acme/api/pull-requests/7",
    repo: "api",
    number: "7",
  });
  assert.equal(parsePullRequest("https://github.com/acme/cade/issues/3"), null);
});

test("linking a PR asks the task's reviewers to review it", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA", "UREX"], status: "IN_REVIEW" })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(drafts(calls), [`<@URIA>, <@UREX>, could you review this?`]);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"), "nothing posted, and no picker");
});

test("linking a PR reads where it stands on GitHub first: one merged already isn't put up for review", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" })] });
  const asked = mockGitHub({ 42: "MERGED" });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`), {}, { ...env, GITHUB_TOKEN: "ghp_test" });
  assert.equal(asked.length, 1);
  assert.deepEqual((await savedTask()).prStates, { [PR]: "MERGED" });
  assert.equal(blockText(allBlocks(calls[0]!.args).at(-3)), "Pull requests: 0 open  ·  1 merged");
  // No one asked to review it, and the thread isn't told it was merged: it was linked so.
  assert.deepEqual(drafts(calls), []);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));

  // Found merged by a later read, it isn't told either: it didn't change.
  calls.length = 0;
  mockGitHub({});
  const { syncPullRequests } = await import("../src/github.ts");
  await syncPullRequests({ ...env, GITHUB_TOKEN: "ghp_test" });
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("linking a PR when GitHub can't be reached saves it as open, read next by the sync, and its merge is told", async (t) => {
  const record = storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" });
  // Another task's, read just now: the one linked goes before it.
  const other = storedTask();
  other.ts = "100.2";
  other.task.prs = [PR3];
  other.task.prStates = { [PR3]: "OPEN" };
  const calls = mockSlack(t, { stored: [record, other] });
  const slack = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url) === "https://api.github.com/graphql" ? Promise.reject(new Error("timed out")) : slack(url, init);
  const withToken = { ...env, GITHUB_TOKEN: "ghp_test" };
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`), {}, withToken);
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.deepEqual((await savedTask()).prStates, { [PR]: "OPEN" });
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
  const { prsToSync } = await import("../src/db.ts");
  assert.deepEqual(await prsToSync(env, 1), [PR]);

  // Merged before the sync reads it: a change from open, so the thread is told.
  calls.length = 0;
  globalThis.fetch = slack;
  mockGitHub({ 42: "MERGED", 43: "OPEN" });
  const { syncPullRequests } = await import("../src/github.ts");
  await syncPullRequests(withToken);
  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(
    posts.map((call) => call.args.text),
    [`<${PR}|cade/42> was merged on GitHub.`],
  );
});

test("linking a PR before In review asks no reviewer yet, and moving to In review asks them", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA", "UREX"], status: "IN_PROGRESS" })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(drafts(calls), [], "nobody is asked while it is In progress");

  // Reaching In review asks the reviewers assigned earlier, about what is pending.
  const moved = mockSlack(t, {
    stored: [
      {
        ...storedTask({ reviewers: ["URIA", "UREX"], status: "IN_PROGRESS" }),
        task: { ...storedTask({ reviewers: ["URIA", "UREX"], status: "IN_PROGRESS" }).task, prs: [PR] },
      },
    ],
  });
  await send("/slack/events", threadEvent("<@UBOT> status in review"));
  assert.deepEqual(drafts(moved), ["<@URIA>, <@UREX>, could you review this?"]);
});

test("@Cade pr add with no reviewer asks whoever sent it, privately, to assign one, only while In review: no picker", async (t) => {
  for (const [status, asked] of [
    ["IN_REVIEW", true],
    ["IN_PROGRESS", false],
  ] as const) {
    const calls = mockSlack(t, { stored: [withStatus(status)] });
    await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
    assert.ok(
      calls.some((call) => call.method === "reactions.add" && call.args.name === "white_check_mark"),
      status,
    );
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"), status);
    assert.deepEqual(
      calls.filter((call) => call.method === "chat.postEphemeral").map((call) => [call.args.user, call.args.text]),
      asked ? [["UACTOR", "No one is reviewing this yet. Add a reviewer with Edit…, so they're asked."]] : [],
      status,
    );
  }
});

test("choosing reviewers assigns them in a new reply, and offers to ask them to review", async (t) => {
  const root = storedTask({ status: "IN_REVIEW" });
  root.task.prs = [PR];
  const calls = mockSlack(t, {
    stored: [root],
    "users.info": (args) => ({ user: { real_name: { UCLICKER: "Cleo", URIA: "Ria" }[args.user] } }),
  });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: {
        ts: "100.8",
        thread_ts: "100.1",
        text: `<@UACTOR> linked <${PR}|cade/42>.\nThere's no reviewer yet. Who should review it?`,
      },
      actions: [{ action_id: "pr:reviewers", block_id: JSON.stringify([PR]), selected_users: ["URIA"] }],
    }),
  );
  const slack = calls.filter((call) => call.method !== "users.info");
  assert.deepEqual(
    slack.map((call) => [call.method, call.args.ts]),
    [
      ["chat.update", "100.1"],
      ["chat.update", "100.8"],
      ["chat.postMessage", undefined],
      ["chat.postEphemeral", undefined],
    ],
  );
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
  // The picker keeps what came before its question.
  assert.equal(slack[1].args.text, `<@UACTOR> linked <${PR}|cade/42>.`);
  assert.equal(slack[1].args.blocks.length, 1, "the picker is gone");
  // A new reply, the change log, naming people without notifying them: the draft offered is what asks them.
  assert.deepEqual(slack[2].args, {
    channel: "CDEV",
    thread_ts: "100.1",
    text: `@Cleo assigned @Ria as reviewer.`,
  });
  assert.equal(slack[3].args.user, "UCLICKER");
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
});

test("choosing reviewers on a picker with nothing before its question removes it", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: { ts: "100.8", thread_ts: "100.1", text: "There's no reviewer yet. Who should review it?" },
      actions: [{ action_id: "pr:reviewers", block_id: JSON.stringify([PR]), selected_users: ["URIA"] }],
    }),
  );
  assert.deepEqual(
    calls
      .slice(1)
      .filter((call) => call.method !== "users.info")
      .map((call) => [call.method, call.args.ts]),
    [
      ["chat.delete", "100.8"],
      ["chat.postMessage", undefined],
    ],
  );
});

test("assigning a reviewer once a PR is linked asks them to review it", async (t) => {
  const root = storedTask({ status: "IN_REVIEW" });
  root.task.prs = [PR, MR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA>"));
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
});

test("reviewers added before a PR are recorded, and asked nothing yet", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA> <@UREX>"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add"],
  );
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

// Clicks a button on Cade's private "link these PRs?" question.
const suggestionClick = (actionId, urls) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.1", urls }) }],
  });

test("pull requests pasted into a task's thread are auto-linked, with no one asked yet, and whoever pasted them is told privately, with OK and Unlink", async (t) => {
  const root = storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" });
  root.task.prs = [MR];
  const calls = mockSlack(t, { stored: [root], "chat.postMessage": { channel: "CDEV", ts: "300.1" } });
  await send("/slack/events", threadReply(`Fixed in <${PR}> and <${MR}>, see <https://example.com/doc>`));

  // Only the PR that isn't linked yet. The thread hears only that it was auto-linked: the reviewers
  // aren't asked here, even In review.
  assert.deepEqual((await savedTask()).prs, [MR, PR]);
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args);
  assert.deepEqual(
    posts.map((post) => [post.thread_ts, post.text]),
    [["100.1", `Auto-linked <${PR}|cade/42>.`]],
  );
  // The note is the only private message; with nothing else to suggest, it carries no changes.
  const notes = calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].user, notes[0].thread_ts], ["UACTOR", "100.1"]);
  assert.equal(notes[0].text, `I linked <${PR}|cade/42> to this task from your message.`);
  const [ok, unlink] = notes[0].blocks[1].elements;
  assert.deepEqual([ok.text.text, unlink.text.text], ["OK", "Unlink"]);
  // The Auto-linked message rides along, for Unlink to take back.
  assert.deepEqual(JSON.parse(unlink.value), { channel: "CDEV", ts: "100.1", urls: [PR], posted: "300.1", told: [] });
});

test("OK on a note with nothing to suggest asks for review as linking would: the reviewers while In review, not those mentioned; with none, whoever pasted it privately", async (t) => {
  const ok = (value) =>
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      container: { is_ephemeral: true },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "pr:linked-ok", value: JSON.stringify(value) }],
    });
  const linked = (record) => {
    record.task.prs = [PR];
    return record;
  };
  // `asked`: the draft offered to whoever pasted it (see drafts); `privately`: the other private messages.
  for (const [label, record, told, asked, privately] of [
    [
      "reviewers, In review",
      linked(storedTask({ reviewers: ["URIA", "UREX"], status: "IN_REVIEW" })),
      ["UREX"],
      ["<@URIA>, could you review this?"],
      [],
    ],
    ["all mentioned", linked(storedTask({ reviewers: ["UREX"], status: "IN_REVIEW" })), ["UREX"], [], []],
    [
      "no reviewer, In review",
      linked(storedTask({ status: "IN_REVIEW" })),
      [],
      [],
      ["No one is reviewing this yet. Add a reviewer with Edit…, so they're asked."],
    ],
    ["reviewers, In progress", linked(storedTask({ reviewers: ["URIA"], status: "IN_PROGRESS" })), [], [], []],
  ] as const) {
    const calls = mockSlack(t, { stored: [record] });
    const sent = recordResponses(t);
    await send("/slack/interactions", ok({ channel: "CDEV", ts: "100.1", urls: [PR], told }));
    assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }], label);
    assert.deepEqual(
      calls.filter((call) => call.method === "chat.postMessage"),
      [],
      label,
    );
    assert.deepEqual(drafts(calls), asked, label);
    assert.deepEqual(
      calls
        .filter((call) => call.method === "chat.postEphemeral" && !drafts([call]).length)
        .map((call) => call.args.text),
      privately,
      label,
    );
  }
  // Unlink asks no one, and takes the Auto-linked message back rather than posting another.
  const calls = mockSlack(t, { stored: [linked(storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" }))] });
  recordResponses(t);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      container: { is_ephemeral: true },
      response_url: RESPONSE_URL,
      actions: [
        {
          action_id: "pr:linked-unlink",
          value: JSON.stringify({ channel: "CDEV", ts: "100.1", urls: [PR], posted: "300.1", told: [] }),
        },
      ],
    }),
  );
  assert.deepEqual((await savedTask()).prs, []);
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.postMessage"),
    [],
  );
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.delete").map((call) => call.args),
    [{ channel: "CDEV", ts: "300.1" }],
  );
  assert.deepEqual(drafts(calls), []);
});

test("Unlink on a note from before the Auto-linked message was kept tells the thread who unlinked it", async (t) => {
  const record = storedTask();
  record.task.prs = [PR];
  const calls = mockSlack(t, { stored: [record] });
  recordResponses(t);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      container: { is_ephemeral: true },
      response_url: RESPONSE_URL,
      actions: [
        {
          action_id: "pr:linked-unlink",
          value: JSON.stringify({ channel: "CDEV", ts: "100.1", urls: [PR], told: [] }),
        },
      ],
    }),
  );
  assert.deepEqual((await savedTask()).prs, []);
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.text),
    [`<@UACTOR> unlinked <${PR}|cade/42>.`],
  );
  assert.ok(!calls.some((call) => call.method === "chat.delete"));
});

test("an auto-linked PR asks no one, whatever the status and people: what the message means is suggested once the note is clicked", async (t) => {
  for (const record of [
    storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" }),
    storedTask({ status: "IN_REVIEW" }),
    storedTask({ reviewers: ["URIA"], status: "IN_PROGRESS" }),
  ]) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadReply(`PR: <${PR}>`));
    assert.deepEqual(
      calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.text),
      [`Auto-linked <${PR}|cade/42>.`],
      record.task.status,
    );
    assert.deepEqual(
      calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args.text),
      [`I linked <${PR}|cade/42> to this task from your message.`],
      record.task.status,
    );
  }
});

test("OK or Unlink on the note turns it into the suggestion, or removes it with none; Unlink also takes the open ones off, and the Auto-linked message names only those left", async (t) => {
  const changes = { people: { reviewer: { add: ["UREX"], remove: [] } } };
  const click = (action_id, value) =>
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      container: { is_ephemeral: true },
      response_url: RESPONSE_URL,
      actions: [{ action_id, value }],
    });
  const stored = () => {
    const root = storedTask();
    root.task.prs = [MR, PR, PR3];
    // One merged since stays, as in the Pull requests form.
    root.task.prStates = { [PR3]: "MERGED" };
    return root;
  };

  // Unlink, with a suggestion: the note becomes it, and the open one is unlinked.
  let calls = mockSlack(t, { stored: [stored()] });
  let sent = recordResponses(t);
  await send(
    "/slack/interactions",
    click(
      "pr:linked-unlink",
      JSON.stringify({
        channel: "CDEV",
        ts: "100.1",
        urls: [PR, PR3],
        posted: "300.1",
        changes,
        from: "TODO",
        told: ["UREX"],
      }),
    ),
  );
  assert.deepEqual((await savedTask()).prs, [MR, PR3]);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage" || call.method === "chat.delete"));
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.update" && call.args.ts === "300.1").map((call) => call.args.text),
    [`Auto-linked <${PR3}|cade/43>.`],
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replace_original, true);
  assert.equal(sent[0].text, "Should I update the task? From your message:");
  assert.deepEqual(JSON.parse(suggestionButtons(sent[0])[0].value), {
    channel: "CDEV",
    ts: "100.1",
    changes,
    from: "TODO",
    told: ["UREX"],
  });

  // OK, with a suggestion: the same, and nothing is unlinked.
  calls = mockSlack(t, { stored: [stored()] });
  sent = recordResponses(t);
  await send(
    "/slack/interactions",
    click(
      "pr:linked-ok",
      JSON.stringify({ channel: "CDEV", ts: "100.1", urls: [PR], changes, from: "TODO", told: [] }),
    ),
  );
  assert.deepEqual((await savedTask()).prs, [MR, PR, PR3]);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.equal(sent[0].text, "Should I update the task? From your message:");

  // OK with nothing to suggest: the note goes.
  mockSlack(t, { stored: [stored()] });
  sent = recordResponses(t);
  await send(
    "/slack/interactions",
    click("pr:linked-ok", JSON.stringify({ channel: "CDEV", ts: "100.1", urls: [PR] })),
  );
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("a PR pasted with a mention is linked, and the person is suggested as reviewer once the note is clicked", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply(`<@UREX> <@UBOT> can you look at <${PR}>?`));
  assert.deepEqual((await savedTask()).prs, [PR]);
  // Only the note now; the suggestion waits in its buttons. Cade isn't someone to add, and the PR is linked already.
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args.text),
    [`I linked <${PR}|cade/42> to this task from your message.`],
  );
  assert.deepEqual(noteValue(calls), {
    channel: "CDEV",
    ts: "100.1",
    urls: [PR],
    changes: { people: { reviewer: { add: ["UREX"], remove: [] } } },
    from: "TODO",
    told: ["UREX"],
  });
});

test("a pasted pull request isn't linked with pr-links off, on a task that's Done, or for someone who turned suggestions off", async (t) => {
  const { setSuggestions } = await import("../src/db.ts");
  for (const [record, overrides, environment] of [
    [storedTask(), {}, { ...env, TASK_CHANGE_DETECTION: JSON.stringify(["hand-offs"]) }],
    [withStatus("DONE"), {}, env],
    [storedTask(), { user: "UQUIET" }, env],
  ] as const) {
    const calls = mockSlack(t, { stored: [record] });
    await setSuggestions(env, "UQUIET", false);
    await send("/slack/events", threadReply(`PR is up: <${PR}>`, overrides), {}, environment);
    assert.deepEqual((await savedTask()).prs, [], JSON.stringify(overrides));
    assert.deepEqual(calls, [], JSON.stringify(overrides));
  }
});

test("a question posted with the old reviewer picker is still answered", async (t) => {
  const linking = mockSlack(t, { stored: [storedTask({ status: "IN_REVIEW" })] });
  const sent = recordResponses(t);
  const click = JSON.parse(new URLSearchParams(suggestionClick("pr:suggest-link", [PR])).get("payload"));
  click.actions[0].value = JSON.stringify({
    channel: "CDEV",
    ts: "100.1",
    mentioned: ["UREX"],
    urls: [PR],
    reviewers: ["UREX"],
  });
  click.state = {
    values: { "pr:suggest-reviewers": { "pr:suggest-reviewers": { selected_users: ["UREX", "UMIA"] } } },
  };
  await send("/slack/interactions", interaction(click));
  const saved = await savedTask();
  assert.deepEqual(saved.prs, [PR]);
  assert.deepEqual(saved.people.reviewer, ["UREX", "UMIA"]);
  // UREX was mentioned in the message, so only UMIA is asked.
  assert.deepEqual(drafts(linking), [`<@UMIA>, could you review this?`]);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("/cade retry asks again about a message in a task's thread, from its link", async (t) => {
  const ts = "1700000001.000500";
  const reply = { ts, thread_ts: "100.1", user: "UREX", text: `<@UMIA> please look at <${PR}>` };
  const calls = mockSlack(t, {
    stored: [storedTask({ reviewers: ["UMIA"] })],
    "conversations.replies": { messages: [reply] },
    "auth.test": { user_id: "UBOT" },
  });
  const { later } = await runTasksCommand(`retry ${messageLink("CDEV", ts, "?thread_ts=100.1&cid=CDEV")}`, "CDEV");

  assert.deepEqual(
    calls.slice(0, 2).map((call) => call.method),
    ["conversations.replies", "auth.test"],
  );
  assert.equal(calls[0].args.ts, ts);
  // The link is linked, from whoever wrote the message, who gets the note, as they would have.
  assert.deepEqual((await savedTask()).prs, [PR]);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.1");
  assert.equal(post.text, `Auto-linked <${PR}|cade/42>.`);
  assert.equal(linkedNote(calls).user, "UREX");
  assert.match(later.text, /<@UREX> will see a private question/);
});

test("/cade retry says when the link is missing, not in a thread, or not found", async (t) => {
  mockSlack(t);
  assert.match((await runTasksCommand("retry", "CDEV")).now, /Paste the link to the message/);

  mockSlack(t, {
    "conversations.replies": { messages: [{ ts: "1700000000.000100", user: "UREX", text: "a task" }] },
    "auth.test": { user_id: "UBOT" },
  });
  assert.match(
    (await runTasksCommand(`retry ${messageLink("CDEV", "1700000000.000100")}`, "CDEV")).later.text,
    /not in a thread/,
  );

  mockSlack(t, { "conversations.replies": { messages: [] } });
  assert.match(
    (await runTasksCommand(`retry ${messageLink("CDEV", "1700000009.000900")}`, "CDEV")).later.text,
    /couldn't find that message/,
  );
});

test("a PR in a reply also sent to the channel is linked like any reply", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["UMIA"] })] });
  await send("/slack/events", threadReply(`<@UMIA> can you review <${PR}>?`, { subtype: "thread_broadcast" }));
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.equal(calls.find((call) => call.method === "chat.postMessage").args.text, `Auto-linked <${PR}|cade/42>.`);
});

test("Edit saves the status chosen over the one a PR suggestion moved the task to", async (t) => {
  const task = storedTask({ reviewers: ["UMIA"] });
  task.task.status = "IN_PROGRESS";
  mockSlack(t, { stored: [task] });
  // The form began on In review, as linking the PR moves the task there; the
  // person put In progress back.
  const saveWith = (status) =>
    send(
      "/slack/interactions",
      interaction({
        type: "view_submission",
        user: { id: "UACTOR" },
        view: {
          callback_id: "task:edit",
          private_metadata: JSON.stringify({
            channel: "CDEV",
            ts: "100.1",
            details: false,
            opened: "IN_PROGRESS",
            shown: "IN_REVIEW",
          }),
          state: {
            values: {
              owner: { value: { selected_users: [] } },
              reviewer: { value: { selected_users: ["UMIA"] } },
              tester: { value: { selected_users: [] } },
              status: { value: { selected_option: { value: status } } },
              prs: { value: { value: PR } },
            },
          },
        },
      }),
    );
  await saveWith("IN_PROGRESS");
  const saved = await savedTask();
  assert.deepEqual([saved.status, saved.prs], ["IN_PROGRESS", []]);
});

test("messages without unlinked pull requests are left alone", async (t) => {
  const linked = storedTask();
  linked.task.prs = [PR];
  for (const [text, overrides, root] of [
    ["Looks good, no links here", {}, storedTask()],
    [`Already linked <${PR}>`, {}, linked],
    // Not in a team channel, or not a task's thread. (Messages not in a
    // thread are asked whether to track them instead.)
    [`See <${PR}>`, { channel: "COTHER" }, storedTask()],
    [`See <${PR}>`, {}, null],
    // Cade's own messages and edits.
    [`See <${PR}>`, { bot_id: "BCADE" }, storedTask()],
    [`See <${PR}>`, { subtype: "message_changed" }, storedTask()],
  ] as const) {
    const calls = mockSlack(t, { stored: root ? [root] : [] });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${JSON.stringify(overrides)}`);
  }
});

test("@Cade pr add is a command, not a suggestion", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("Link PRs links them, offers only what is new and removes the question", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" })] });
  const sent = recordResponses(t);
  const response = await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.equal(response.status, 200);

  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "chat.postEphemeral"],
  );
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.equal(calls[1].args.thread_ts, "100.1");
  // No "linked" line: whoever clicked posted the link. They're offered only to ask the reviewer the
  // message didn't mention.
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Link on an older PR question, on a task with no reviewer, asks no one before In review", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("Link PRs after someone else linked them just removes the question", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  const sent = recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.deepEqual(
    calls.map((call) => call.method),
    [],
  );
  assert.equal(sent.length, 1);
});

test("Not now just removes the question", async (t) => {
  const calls = mockSlack(t);
  const sent = recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-skip", [PR]));
  assert.equal(calls.length, 0);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

// `mentioned` is who the pasted message mentioned.
const suggestionValue = (fields) =>
  JSON.stringify({ channel: "CDEV", ts: "100.1", mentioned: [], urls: [], reviewers: [], ...fields });

const clickSuggestion = (value) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: "pr:suggest-link", value }],
  });

test("a pasted PR that mentions people proposes them as reviewers too", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  // URIA is already a reviewer and Cade is not a person to add.
  await send("/slack/events", threadReply(`<@UREX> <@URIA> <@UBOT> can you look at <${PR}>?`));
  assert.deepEqual(noteValue(calls).changes, { people: { reviewer: { add: ["UREX"], remove: [] } } });
});

test("an already linked PR is left alone, even when it mentions new people", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadReply(`<@UREX> <@URIA> please look at <${PR}>`));
  assert.deepEqual(calls, []);
});

test("mentions without a PR link are not offered as reviewers", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("<@UREX> can you help with this?"));
  assert.equal(calls.length, 0);
});

test("Link and add reviewer asks only the reviewers the message did not mention", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" })] });
  const sent = recordResponses(t);
  await send(
    "/slack/interactions",
    clickSuggestion(suggestionValue({ mentioned: ["UREX"], urls: [PR], reviewers: ["UREX"] })),
  );

  assert.deepEqual((await savedTask()).people.reviewer, ["URIA", "UREX"]);
  assert.deepEqual((await savedTask()).prs, [PR]);
  // UREX was mentioned in the message, so only URIA is asked.
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
  assert.equal(sent.length, 1);
});

test("Add reviewers on an already linked PR adds them and posts nothing", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  const sent = recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ mentioned: ["UREX"], reviewers: ["UREX"] })));

  assert.deepEqual((await savedTask()).people.reviewer, ["UREX"]);
  // The message already asked UREX; the card shows them as reviewer.
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.equal(sent.length, 1);
});

test("Just link leaves the mentioned people out", async (t) => {
  mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ urls: [PR] })));
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
});

test("linking a PR leaves the status to the suggestions", async (t) => {
  for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "IN_TESTING", "CLIENT_REVIEW", "DONE"]) {
    const calls = mockSlack(t, { stored: [withStatus(status)] });
    await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
    assert.deepEqual((await savedTask()).status, status, status);
    assert.ok(!calls.some((call) => call.args.text?.includes("moved the task")), status);
  }
});

test("removing a PR leaves the status alone", async (t) => {
  const root = withStatus("IN_REVIEW");
  root.task.prs = [PR];
  mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).status, "IN_REVIEW");
});

test("a message with a PR link and a hand-off links the PR, and the note carries the hand-off to suggest", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply(`<@UREX> please review <${PR}>`));
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args.text),
    [`I linked <${PR}|cade/42> to this task from your message.`],
  );
  assert.deepEqual(noteValue(calls).changes, { people: { reviewer: { add: ["UREX"], remove: [] } } });
});

test("a message an app posted for the person, such as an AI agent's Slack tool, gets no suggestion", async (t) => {
  // As Slack sends one posted with Claude's Slack connector: the person's, with the app's ID and a
  // "Sent using" footer. A plain message from the same person still gets its question.
  const footer = {
    type: "context",
    block_id: "mcp_attribution_footer",
    elements: [{ type: "mrkdwn", text: "*Sent using* Claude" }],
  };
  for (const [marks, asked] of [
    [{ app_id: "A08SF47R6P4", blocks: [{ type: "rich_text" }, footer] }, false],
    [{ app_id: "A08SF47R6P4" }, false],
    [{ blocks: [{ type: "rich_text" }, footer] }, false],
    [{ client_msg_id: "c42b0a0a", blocks: [{ type: "rich_text" }] }, true],
  ] as const) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadReply(`<@UREX> please review <${PR}>`, marks));
    assert.equal(
      calls.some((call) => call.method === "chat.postEphemeral"),
      asked,
      JSON.stringify(marks),
    );
  }

  // Commands sent that way still work.
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("<@UBOT> priority high", { app_id: "A08SF47R6P4" }));
  assert.ok(calls.some((call) => call.method === "reactions.add"));
});

test("Just link works like the other link button", async (t) => {
  mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  recordResponses(t);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      container: { is_ephemeral: true },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "pr:suggest-link-only", value: suggestionValue({ urls: [PR] }) }],
    }),
  );
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
});

test("Link on an older PR question, on a task In review with no reviewer, asks whoever clicked privately to assign one", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args.text),
    ["No one is reviewing this yet. Add a reviewer with Edit…, so they're asked."],
  );
});

test("choosing reviewers whose PR list didn't fit asks about all the task's PRs", async (t) => {
  const root = storedTask({ status: "IN_REVIEW" });
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: { ts: "100.8", thread_ts: "100.1" },
      actions: [{ action_id: "pr:reviewers", block_id: "not json", selected_users: ["URIA"] }],
    }),
  );
  assert.equal(
    calls.findLast((call) => call.method === "chat.postMessage").args.text,
    `<@UCLICKER> assigned <@URIA> as reviewer.`,
  );
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
});
