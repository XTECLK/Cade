import assert from "node:assert/strict";
import test from "node:test";
import {
  MR,
  PR,
  drafts,
  interaction,
  mockSlack,
  recordResponses,
  savedTask,
  send,
  storedTask,
  suggestionClick,
  threadEvent,
  withStatus,
} from "./app.ts";

test("linking a PR asks the task's reviewers to review it", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA", "UREX"], status: "IN_REVIEW" })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(drafts(calls), [`<@URIA>, <@UREX>, could you review this?`]);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"), "nothing posted, and no picker");
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
