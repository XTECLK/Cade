import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";
import { insertTask, markTaskPosted, putTask } from "../src/db.ts";
import { todayIn } from "../src/task-list.ts";
import type { Status } from "../src/types.ts";
import { context } from "./helpers.ts";
import {
  DB,
  blockText,
  createdTask,
  deleteClick,
  env,
  footerLines,
  mockSlack,
  ownTask,
  savedTask,
  seeded,
  send,
  storedTask,
  threadEvent,
  withoutSummary,
} from "./app.ts";

// D1 is the source of truth; root messages are rendered from it.

test("each change is stored, and the root message is rendered from the stored task", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UTESS>"));

  // Slack is only written to: nothing is read back from it.
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add", "chat.postEphemeral", "chat.update", "reactions.add"],
  );
  assert.deepEqual((await savedTask()).people, { owner: ["UALICE", "UBOB"], reviewer: [], tester: ["UTESS"] });
  assert.equal(footerLines(calls[3].args)[0], "Owner <@UALICE>, <@UBOB>  ·  Test <@UTESS>");
});

test("a thread with no stored task isn't one", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  // The task is in CDEV; the same ts in another channel is a different message.
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "CTESTDEV" }));
  assert.match(calls.at(-1).args.text, /not tracking a task in this thread/);
});

test("a deleted task is kept in the database and no longer loads", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.equal(await savedTask(), null);
  assert.ok(await DB.prepare("SELECT 1 FROM tasks WHERE deleted_at IS NOT NULL").first());

  calls.length = 0;
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage"],
  );
  assert.match(calls[0].args.text, /not tracking a task in this thread/);
});
// Tasks are stored before they are posted; those Slack refused are posted
// again by the cron.

// Runs the cron, as Cloudflare does, and waits for its work.
async function runCron(environment = env) {
  await seeded;
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    { cron: "* * * * *", scheduledTime: Date.UTC(2026, 0, 1, 0, 0) } as ScheduledController,
    environment,
    context((promise) => {
      pending.push(promise);
    }),
  );
  await Promise.all(pending);
}

// Makes every stored row look `minutes` old, as if posting failed back then.
const age = (minutes = 2) =>
  DB.prepare("UPDATE tasks SET created_at = datetime('now', ?)").bind(`-${minutes} minutes`).run();

// A task tracked with /cade task that Slack refused `attempts` times.
async function waitingTask(attempts = 1) {
  const { task } = storedTask();
  const id = await insertTask(env, "CDEV", task, {});
  await DB.prepare("UPDATE tasks SET post_attempts = ? WHERE id = ?").bind(attempts, id).run();
  return id;
}

test("the cron posts a task Slack refused, and finishes tracking it", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [] });
  await waitingTask();
  await age();
  await runCron();

  // Its thread is read to be kept; with no request, the cron has no address to link its pages by.
  assert.deepEqual(
    withoutSummary(calls).map((call) => call.method),
    ["chat.postMessage", "chat.getPermalink", "conversations.replies"],
  );
  assert.equal(calls[0].args.channel, "CDEV");
  const task = await savedTask();
  assert.equal(task.title, "Fix login");
  assert.equal(task.link, "https://slack.example/p100");
  // Posted once: nothing is left to retry.
  calls.length = 0;
  await runCron();
  // Only the summary canvas, made for the new task, is left to write (see summary.js).
  assert.equal(withoutSummary(calls).length, 0);
});

test("the cron leaves alone posts that may still be under way", async (t) => {
  const calls = mockSlack(t, createdTask);
  await waitingTask();
  await runCron();
  assert.equal(calls.length, 0);
});

// Thread rotation (see rotate.ts): the cron, on the hour, gives an open task older than
// threadRotationDays a new root message.
const OLD_ROOT = "1765000000.000100"; // 6 December 2025, 26 days before runCron's time
const NEW_ROOT = "1767225600.000200";

async function oldThread(status: Status = "TODO") {
  const { task } = storedTask({ status });
  await putTask(env, "CDEV", OLD_ROOT, { ...task, export: { url: `https://worker.example.net/t/CDEV/${OLD_ROOT}` } });
  await DB.prepare("INSERT INTO messages (channel, task_ts, ts, text) VALUES ('CDEV', ?, '1765000001.000100', 'on it')")
    .bind(OLD_ROOT)
    .run();
  await DB.prepare(
    "INSERT INTO task_summaries (channel, task_ts, summary, through_ts, written_by) VALUES ('CDEV', ?, 'The issue', '1765000001.000100', 'UANN')",
  )
    .bind(OLD_ROOT)
    .run();
  await DB.prepare(
    "INSERT INTO task_consumers (channel, task_ts, consumer, through_ts, acked_by) VALUES ('CDEV', ?, 'sync-tasks', '1765000001.000100', 'UANN')",
  )
    .bind(OLD_ROOT)
    .run();
}

const rotating = {
  // Replies are posted just after the new root: the old thread's note, then the new one's.
  "chat.postMessage": (args) => ({
    channel: args.channel,
    ts: args.thread_ts ? `176722560${args.thread_ts === OLD_ROOT ? 1 : 2}.000300` : NEW_ROOT,
  }),
  "chat.getPermalink": (args) => ({ permalink: `https://slack.example/p${args.message_ts}` }),
};

test("the cron rotates an open task's thread older than threadRotationDays, linking old and new", async (t) => {
  const calls = mockSlack(t, rotating);
  await oldThread();
  await runCron({ ...env, SUMMARY_CANVAS: "off", THREAD_ROTATION_DAYS: "20" });

  const posts = calls.filter((call) => call.method === "chat.postMessage");
  // The card again as a new root, then a note in each thread.
  assert.equal(posts.length, 3);
  assert.equal(posts[0].args.thread_ts, undefined);
  assert.equal(posts[1].args.thread_ts, OLD_ROOT);
  assert.match(
    posts[1].args.text,
    new RegExp(`This thread is rotated.*New messages go <https://slack.example/p${NEW_ROOT}\\|here>`),
  );
  assert.equal(posts[2].args.thread_ts, NEW_ROOT);
  assert.match(
    posts[2].args.text,
    new RegExp(
      `Rotated thread. Complete history <https://worker.example.net/t/CDEV/${NEW_ROOT}\\|here>, older thread <https://slack.example/p${OLD_ROOT}\\|here>`,
    ),
  );
  // The old card is its title and where it went, with no buttons or strip.
  const old = calls.find((call) => call.method === "chat.update" && call.args.ts === OLD_ROOT);
  assert.deepEqual(old.args.attachments, []);
  assert.deepEqual(old.args.blocks.map(blockText), [
    "*Fix login*",
    `:recycle: This thread is rotated. New messages go <https://slack.example/p${NEW_ROOT}|here>.`,
  ]);
  // The new card links its history at its new address.
  const update = calls.find((call) => call.method === "chat.update");
  assert.equal(update.args.ts, NEW_ROOT);
  assert.match(JSON.stringify(update.args.attachments), new RegExp(`/t/CDEV/${NEW_ROOT}`));

  // The task, its kept messages, its summary and its consumers' positions are found by the new root now.
  assert.equal(await savedTask("CDEV", OLD_ROOT), null);
  const task = await savedTask("CDEV", NEW_ROOT);
  assert.equal(task.link, `https://slack.example/p${NEW_ROOT}`);
  assert.equal(task.export.url, `https://worker.example.net/t/CDEV/${NEW_ROOT}`);
  // Its history runs on across both threads: the old thread's messages, then the rotation.
  const { results } = await DB.prepare("SELECT text FROM messages WHERE task_ts = ? ORDER BY ts").bind(NEW_ROOT).all();
  assert.deepEqual(
    results.map((row) => String(row.text).split(".")[0]),
    ["on it", ":recycle: Rotated thread"],
  );
  assert.ok(await DB.prepare("SELECT 1 FROM task_summaries WHERE task_ts = ?").bind(NEW_ROOT).first());
  assert.ok(await DB.prepare("SELECT 1 FROM task_consumers WHERE task_ts = ?").bind(NEW_ROOT).first());
});

test("rotating a task's thread redraws its subtasks' cards, which link the new root", async (t) => {
  const calls = mockSlack(t, rotating);
  await oldThread();
  // A subtask posted since, too young to rotate itself, with an owner of its own (so saving its task
  // wouldn't redraw it anyway: see followParent).
  const subtask = {
    ...storedTask({ owners: ["UREX"] }).task,
    title: "Its part",
    parent: { ts: OLD_ROOT, title: "Fix login" },
  };
  await markTaskPosted(env, await insertTask(env, "CDEV", subtask, {}), "1766000000.000100");
  await runCron({ ...env, SUMMARY_CANVAS: "off", THREAD_ROTATION_DAYS: "20" });

  const redrawn = calls.find((call) => call.method === "chat.update" && call.args.ts === "1766000000.000100");
  assert.match(
    JSON.stringify(redrawn.args.attachments),
    new RegExp(`Subtask of <https://slack.example/p${NEW_ROOT}\\|Fix login>`),
  );
});

test("a subtask rotates by its own thread's age, and after its task in the same run, links the task's new root", async (t) => {
  // Each new root gets the next ts, the task's first as it is the older.
  let roots = 0;
  const calls = mockSlack(t, {
    ...rotating,
    "chat.postMessage": (args) => ({
      channel: args.channel,
      ts: args.thread_ts ? "1767225609.000300" : `176722560${++roots}.000100`,
    }),
  });
  await oldThread();
  const subtask = {
    ...storedTask({ owners: ["UREX"] }).task,
    title: "Its part",
    parent: { ts: OLD_ROOT, title: "Fix login" },
  };
  await markTaskPosted(env, await insertTask(env, "CDEV", subtask, {}), "1765000500.000100");
  await runCron({ ...env, SUMMARY_CANVAS: "off", THREAD_ROTATION_DAYS: "20" });

  const [taskRoot, subtaskRoot] = ["1767225601.000100", "1767225602.000100"];
  assert.equal((await savedTask("CDEV", subtaskRoot)).parent.ts, taskRoot);
  const card = calls.filter((call) => call.method === "chat.update" && call.args.ts === subtaskRoot).at(-1);
  assert.match(
    JSON.stringify(card.args.attachments),
    new RegExp(`Subtask of <https://slack.example/p${taskRoot}\\|Fix login>`),
  );
});

test("the cron leaves young threads, Done tasks, and every thread without threadRotationDays", async (t) => {
  for (const [status, days] of [
    ["TODO", "80"],
    ["DONE", "20"],
    ["TODO", ""],
  ] as const) {
    const calls = mockSlack(t, rotating);
    await oldThread(status);
    await runCron({ ...env, SUMMARY_CANVAS: "off", THREAD_ROTATION_DAYS: days });
    assert.deepEqual(calls, [], `${status}, ${days || "off"}`);
    assert.ok(await savedTask("CDEV", OLD_ROOT));
  }
});

test("the cron tells nobody while it keeps trying, and gives up after the last attempt", async (t) => {
  const calls = mockSlack(t, { "chat.postMessage": { ok: false, error: "channel_not_found" } });
  await waitingTask(1);
  await age();
  await runCron();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage"],
  );

  calls.length = 0;
  await DB.prepare("UPDATE tasks SET post_attempts = 4").run();
  await runCron();
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage", "chat.postEphemeral"],
  );
  assert.equal(calls[1].args.user, "UCREATOR");
  assert.equal(calls[1].args.text, 'Sorry, I couldn\'t create the task "Fix login", even after a few tries.');
  // Given up: not tried again.
  calls.length = 0;
  await runCron();
  assert.equal(calls.length, 0);
  assert.ok(await DB.prepare("SELECT 1 FROM tasks WHERE deleted_at IS NOT NULL").first());
});

// /cade tasks options: a person, everyone, status and due date filters.

test("today is in the configured time zone", () => {
  const lateEvening = new Date("2026-10-24T20:00:00Z");
  assert.equal(todayIn({}, lateEvening), "2026-10-24");
  assert.equal(todayIn({ TIMEZONE: "Asia/Colombo" }, lateEvening), "2026-10-25");
});
