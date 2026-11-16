import assert from "node:assert/strict";
import test from "node:test";
import {
  MR,
  PR,
  PR3,
  RESPONSE_URL,
  drafts,
  env,
  interaction,
  linkedNote,
  messageLink,
  mockSlack,
  noteValue,
  recordResponses,
  runTasksCommand,
  savedTask,
  send,
  storedTask,
  suggestionButtons,
  suggestionClick,
  threadReply,
  withStatus,
} from "./app.ts";

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
