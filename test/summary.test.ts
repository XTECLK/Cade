import assert from "node:assert/strict";
import test from "node:test";
import { putTask } from "../src/db.ts";
import { writeSummary } from "../src/summary.ts";
import {
  answerPrivately,
  canvasMarkdown,
  canvasResponses,
  createdTask,
  env,
  historyTask,
  incidentHistoryTask,
  interaction,
  messageLink,
  mockSlack,
  ownTask,
  runTasksCommand,
  send,
  storedTask,
  submission,
  summaryRows,
  threadEvent,
} from "./app.ts";

test("the summary lists archived tasks in their own section, until they're deleted", async (t) => {
  const ts = "1700000000.000100";
  const calls = mockSlack(t, {
    ...canvasResponses,
    stored: [{ ...ownTask(), ts }, historyTask("100.2", { title: "Still open" })],
    "conversations.replies": { messages: [] },
  });
  await runTasksCommand("resync summary", "CDEV");
  await send("/slack/events", threadEvent("<@UBOT> archive", { thread_ts: ts }));
  const archived = canvasMarkdown(calls.filter((call) => call.method === "canvases.edit").at(-1));
  assert.deepEqual(
    summaryRows(archived).map((row) => row.match(/\[([^\]]+)\]/)[1]),
    ["Still open"],
  );
  assert.match(archived, /\n## Archived\n\nThe last 1 archived, most recently first\.\n\n/);
  assert.match(summaryRows(archived, "Archived")[0], /^\| \[Fix login\]/);

  // Deleted with /cade remove, it leaves the summary altogether.
  const { later } = await runTasksCommand(`remove <${messageLink("CDEV", ts)}>`, "CDEV");
  await answerPrivately(t, later, "delete:confirm");
  const deleted = canvasMarkdown(calls.filter((call) => call.method === "canvases.edit").at(-1));
  assert.match(deleted, /\n## Archived\n\nNo archived tasks\.$/);
});

test("the summary canvas can be turned off, for every group or one", async (t) => {
  const { refreshSummary } = await import("../src/tasks.ts");
  const pairs = [
    { name: "acme", channel: "CDEV" },
    { name: "test", channel: "CTESTDEV", summaryCanvas: false },
  ];
  for (const [environment, channel, canvases] of [
    [{ ...env }, "CDEV", true],
    [{ ...env, SUMMARY_CANVAS: "off" }, "CDEV", false],
    [{ ...env, SUMMARY_CANVAS: undefined }, "CDEV", false],
    [{ ...env, PROJECTS: pairs }, "CDEV", true],
    [{ ...env, PROJECTS: pairs }, "CTESTDEV", false],
  ] as const) {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
    await refreshSummary(environment, channel, { create: true });
    assert.equal(
      calls.some((call) => /canvas/.test(call.method)),
      canvases,
      JSON.stringify([channel, environment.SUMMARY_CANVAS]),
    );
  }
});
test("/cade resync summary puts the group's open tasks in the dev channel's canvas, most urgent first", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (const [channel, record] of [
    ["CDEV", historyTask("100.1", { title: "Low task", priority: "Low", owners: ["UALICE"] })],
    [
      "CDEV",
      historyTask("100.2", { title: "High | [later]", priority: "High", dueDate: "05/11/2026", reviewers: ["UBOB"] }),
    ],
    [
      "CDEV",
      historyTask("100.3", { title: "High, sooner", priority: "High", dueDate: "01/11/2026", status: "IN_PROGRESS" }),
    ],
    ["CDEV", historyTask("100.4", { title: "Done task", status: "DONE", completedAt: "2026-10-10T09:00:00.000Z" })],
    [
      "CDEV",
      historyTask("100.5", {
        title: "Done later",
        status: "DONE",
        completedAt: "2026-10-20T09:00:00.000Z",
        owners: ["UBOB"],
      }),
    ],
    ["CDEV", incidentHistoryTask("100.8", { title: "Checkout is down", testers: ["UALICE", "UBOB"] })],
  ] as const)
    await putTask(env, channel, record.ts, record.task);
  const { now, later } = await runTasksCommand("resync summary", "CDEV", env);

  assert.equal(now, "");
  assert.equal(later.text, "Added the summary to this channel's canvas. I'll keep it up to date. Only I can edit it.");
  // Read-only for the channel: Cade rewrites it on every change anyway.
  const lock = calls.find((call) => call.method === "canvases.access.set").args;
  assert.deepEqual(lock, { canvas_id: "F0CANVAS", access_level: "read", channel_ids: '["CDEV"]' });
  const create = calls.find((call) => call.method === "conversations.canvases.create");
  assert.equal(create.args.channel_id, "CDEV");
  assert.equal(create.args.title, "acme tasks");
  const markdown = canvasMarkdown(create);
  assert.match(
    markdown,
    /^_Updated \d\d\/\d\d\/\d{4} \d\d:\d\d\. Cade keeps this up to date\._\n\n## Open\n\n4 open, most urgent first\.\n\n/,
  );
  assert.match(markdown, /\n\n---\n\n## Closed\n\nThe last 2 done, most recently first\.\n\n/);
  assert.ok(markdown.includes("| Title | Status | Priority | Due date | Owner | Reviewer | Tester |"));
  const thread = (channel, ts) =>
    `(https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel})`;
  assert.deepEqual(summaryRows(markdown), [
    `| \\[Incident\\] [Checkout is down]${thread("CDEV", "100.8")} | :memo:~To~do | :red_circle:~Urgent | Immediate | — | — | @Alice, @Bob |`,
    `| [High, sooner]${thread("CDEV", "100.3")} | :arrow_forward:~In~progress | :large_orange_circle:~High | 01/11/2026 | — | — | — |`,
    `| [High \\| \\[later\\]]${thread("CDEV", "100.2")} | :memo:~To~do | :large_orange_circle:~High | 05/11/2026 | — | @Bob | — |`,
    `| [Low task]${thread("CDEV", "100.1")} | :memo:~To~do | :large_green_circle:~Low | 31/10/2026 | @Alice | — | — |`,
  ]);
  // Done tasks follow, most recently done first.
  assert.deepEqual(summaryRows(markdown, "Closed"), [
    `| [Done later]${thread("CDEV", "100.5")} | :white_check_mark:~Done | :large_orange_circle:~High | 31/10/2026 | @Bob | — | — |`,
    `| [Done task]${thread("CDEV", "100.4")} | :white_check_mark:~Done | :large_orange_circle:~High | 31/10/2026 | — | — | — |`,
  ]);

  // Sent again, the same canvas is rewritten, with its title.
  calls.length = 0;
  const again = await runTasksCommand("resync summary", "CDEV", env);
  assert.equal(again.later.text, "Resynced the summary in this channel's canvas. Only I can edit it.");
  const edits = calls.filter((call) => call.method === "canvases.edit");
  assert.deepEqual(
    edits.map((call) => call.args.canvas_id),
    ["F0CANVAS", "F0CANVAS"],
  );
  assert.deepEqual(
    edits.map((call) => JSON.parse(call.args.changes)[0].operation),
    ["replace", "rename"],
  );
  assert.equal(JSON.parse(edits[1].args.changes)[0].title_content.markdown, "acme tasks");
  assert.ok(!calls.some((call) => call.method === "conversations.canvases.create"));
});

test("a summary write is skipped when the canvas would not change, but a full resync still writes", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  const record = historyTask("100.1", { title: "Low task", priority: "Low", owners: ["UALICE"] });
  await putTask(env, "CDEV", record.ts, record.task);
  await runTasksCommand("resync summary", "CDEV", env);

  calls.length = 0;
  const same = await writeSummary(env, "CDEV");
  assert.equal(same, "The summary in this channel's canvas is already up to date.");
  assert.ok(!calls.some((call) => call.method === "canvases.edit"));

  const changed = historyTask("100.2", { title: "New task", priority: "High" });
  await putTask(env, "CDEV", changed.ts, changed.task);
  await writeSummary(env, "CDEV");
  assert.equal(calls.filter((call) => call.method === "canvases.edit").length, 1);

  calls.length = 0;
  await writeSummary(env, "CDEV", { full: true });
  assert.equal(calls.filter((call) => call.method === "canvases.edit").length, 2);
});

test("the summary names people rather than mentioning them, with names kept from the first look-up", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  const record = historyTask("100.1", { title: "Low task", owners: ["UALICE"], reviewers: ["UBOB"] });
  await putTask(env, "CDEV", record.ts, record.task);
  await runTasksCommand("resync summary", "CDEV", env);
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  // A canvas mention notifies the person again on every write.
  assert.ok(!markdown.includes("![](@"));
  assert.match(summaryRows(markdown)[0], /\| @Alice \| @Bob \| — \|$/);
  assert.deepEqual(
    calls
      .filter((call) => call.method === "users.info")
      .map((call) => call.args.user)
      .sort(),
    ["UALICE", "UBOB"],
  );

  // Rewritten, the names come from the database, not Slack.
  calls.length = 0;
  await writeSummary(env, "CDEV", { full: true });
  assert.ok(calls.some((call) => call.method === "canvases.edit"));
  assert.ok(!calls.some((call) => call.method === "users.info"));
});

test("the summary uses the canvas the channel already has", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "conversations.info": { channel: { id: "CDEV", properties: { canvas: { file_id: "F0THEIRS" } } } },
  });
  const fakeFetch = globalThis.fetch;
  // Slack won't let Cade change who can edit a canvas someone else made;
  // the summary goes in it all the same.
  globalThis.fetch = async (url, init) =>
    url.endsWith("/conversations.canvases.create")
      ? (await fakeFetch(url, init), Response.json({ ok: false, error: "channel_canvas_already_exists" }))
      : url.endsWith("/canvases.access.set")
        ? (await fakeFetch(url, init), Response.json({ ok: false, error: "no_permission" }))
        : fakeFetch(url, init);

  const { later } = await runTasksCommand("resync summary", "CDEV");
  assert.equal(later.text, "Added the summary to this channel's canvas. I'll keep it up to date.");
  const [edit, rename] = calls.filter((call) => call.method === "canvases.edit");
  assert.equal(edit.args.canvas_id, "F0THEIRS");
  assert.match(canvasMarkdown(edit), /No open tasks\.[\s\S]*No closed tasks yet\./);
  // It takes the summary's title.
  assert.equal(rename.args.canvas_id, "F0THEIRS");
  assert.equal(JSON.parse(rename.args.changes)[0].title_content.markdown, "acme tasks");

  // Saved, so it is used from now on.
  calls.length = 0;
  await runTasksCommand("resync summary", "CDEV");
  assert.equal(calls.find((call) => call.method === "canvases.edit").args.canvas_id, "F0THEIRS");
  assert.ok(!calls.some((call) => call.method === "conversations.canvases.create"));
});

test("/cade resync summary only works in a group's dev channel", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  const { now } = await runTasksCommand("resync summary", "CRANDOM");
  assert.equal(JSON.parse(now).text, "Send `/cade resync summary` in a group's dev channel, for its summary.");
  assert.ok(!calls.some((call) => /canvas/.test(call.method)));
});

test("a task change rewrites the summaries of its group that have one", async (t) => {
  const calls = mockSlack(t, { ...canvasResponses, stored: [storedTask()] });
  await runTasksCommand("resync summary", "CDEV");
  calls.length = 0;

  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  const edit = calls.find((call) => call.method === "canvases.edit");
  assert.equal(edit.args.canvas_id, "F0CANVAS");
  assert.match(
    summaryRows(canvasMarkdown(edit))[0],
    /^\| \[Fix login\]\(https:[^)]+\) \| :memo:~To~do \| :large_orange_circle:~High \| 31\/10\/2026 \| @Bob \|/,
  );
});

test("a new task makes its group's summary canvas; other changes only rewrite one there is", async (t) => {
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.ok(!calls.some((call) => /canvas|auth\.test/.test(call.method)));

  calls = mockSlack(t, { ...createdTask, ...canvasResponses });
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "High" })));
  const create = calls.find((call) => call.method === "conversations.canvases.create").args;
  assert.equal(create.channel_id, "CDEV");
  assert.match(canvasMarkdown({ args: create }), /\[Fix login\]/);
  assert.deepEqual(calls.find((call) => call.method === "canvases.access.set").args, {
    canvas_id: "F0CANVAS",
    access_level: "read",
    channel_ids: '["CDEV"]',
  });
});

test("a long summary continues in another table, as a canvas table holds 300 cells", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (let i = 0; i < 45; i++) {
    const record = historyTask(`100.${String(i).padStart(2, "0")}`, { title: `Task ${i}` });
    await putTask(env, "CDEV", record.ts, record.task);
  }
  await runTasksCommand("resync summary", "CDEV");
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  const tables = markdown.split("\n\n").filter((part) => part.startsWith("| Title"));
  assert.deepEqual(
    tables.map((part) => part.split("\n").length - 2),
    [41, 4],
  );
});

test("a summary's Closed section keeps the last 50 done", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (let i = 0; i < 55; i++) {
    const record = historyTask(`100.${String(i).padStart(2, "0")}`, {
      title: `Done ${i}`,
      status: "DONE",
      completedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    });
    await putTask(env, "CDEV", record.ts, record.task);
  }
  await runTasksCommand("resync summary", "CDEV");
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  const closed = summaryRows(markdown, "Closed");
  assert.equal(closed.length, 50);
  assert.match(closed[0], /^\| \[Done 54\]/);
  assert.match(closed.at(-1), /^\| \[Done 5\]/);
  assert.match(markdown, /The last 50 done, most recently first\./);
});
