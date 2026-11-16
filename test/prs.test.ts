import assert from "node:assert/strict";
import test from "node:test";
import {
  MR,
  PR,
  PR3,
  PR4,
  allBlocks,
  blockText,
  drafts,
  env,
  footerLines,
  interaction,
  mockGitHub,
  mockSlack,
  ownTask,
  prsLineOf,
  savedTask,
  seeded,
  send,
  storedTask,
  threadEvent,
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

test("@Cade pr add is a command, not a suggestion", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
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
