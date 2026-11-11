import { addMessage, moveTaskThread, subtasksOf, tasksWithStatuses } from "./db.ts";
import { callSlack, escapeSlack, mrkdwn } from "./slack.ts";
import { loadTask, saveTask, STATUSES, taskMessage } from "./tasks.ts";
import type { AppEnv } from "./env.ts";
import type { Status, Task } from "./types.ts";

// Slack's free plan hides messages after 90 days, root messages included. With `threadRotationDays`
// in cade.config.json, an open task whose root message is older than that (a ts is when it was
// posted) gets a new one, and each thread links the other.

// How many one run rotates, to stay within a Worker's subrequests; the rest go in the next runs.
const PER_RUN = 5;
const OPEN = (Object.keys(STATUSES) as Status[]).filter((status) => status !== "DONE");

export async function rotateThreads(env: AppEnv, now = Date.now()) {
  const days = Number(env.THREAD_ROTATION_DAYS);
  if (!(days > 0)) return;
  const before = now / 1000 - days * 86400;
  const old = (await tasksWithStatuses(env, OPEN)).filter(({ ts }) => Number(ts) < before).slice(0, PER_RUN);
  for (const { channel, ts, task } of old) {
    try {
      await rotateThread(env, channel, ts, task);
    } catch (error) {
      console.error("Could not rotate a task's thread", { channel, ts, error: error.message });
    }
  }
}

async function rotateThread(env: AppEnv, channel: string, oldTs: string, listed: Task) {
  const { ts: newTs } = await callSlack(env, "chat.postMessage", { channel, ...taskMessage(listed) });
  const permalink = (ts: string) => callSlack(env, "chat.getPermalink", { channel, message_ts: ts }).then((answer) => answer.permalink);
  const [oldLink, newLink] = await Promise.all([permalink(oldTs), permalink(newTs)]);
  await moveTaskThread(env, channel, oldTs, newTs);
  console.log("Thread rotated", { channel, from: oldTs, to: newTs });

  // Read again, as the list is from before this run's rotations: a subtask's parent may have just moved.
  const task = (await loadTask(env, channel, newTs))!;
  // The card's link and its pages' addresses (which end in the root's ts) follow it.
  const moved = (page?: { url: string }) => page && { url: page.url.endsWith(`/${oldTs}`) ? page.url.slice(0, -oldTs.length) + newTs : page.url };
  const rotated = { ...task, link: newLink, notes: moved(task.notes), export: moved(task.export) };
  await saveTask(env, channel, newTs, rotated);
  await redrawSubtasks(env, channel, newTs);

  const history = rotated.export ? `Complete history <${rotated.export.url}|here>, older` : "Older";
  const moving = `:recycle: This thread is rotated. New messages go <${newLink}|here>.`;
  // The old card becomes its title and where it went, without the buttons, which no longer find it.
  const title = `*${escapeSlack(task.title)}*`;
  await callSlack(env, "chat.update", {
    channel,
    ts: oldTs,
    text: `${title}\n${moving}`,
    blocks: [{ type: "section", text: mrkdwn(title) }, { type: "context", elements: [mrkdwn(moving)] }],
    attachments: [],
  });
  await callSlack(env, "chat.postMessage", { channel, thread_ts: oldTs, text: moving });
  // Kept here as well as by its event, so the task's history always shows where the rotation happened.
  const text = `:recycle: Rotated thread. ${history} thread <${oldLink}|here>.`;
  const { ts } = await callSlack(env, "chat.postMessage", { channel, thread_ts: newTs, text });
  await addMessage(env, { channel, taskTs: newTs, ts, username: "Cade", text });
}

// Each subtask's card links its task's root (see parentLine), so is redrawn with the new one. A
// convenience, so a failure is only logged.
async function redrawSubtasks(env: AppEnv, channel: string, ts: string) {
  try {
    for (const sub of await subtasksOf(env, channel, ts)) await callSlack(env, "chat.update", { channel, ts: sub.ts, ...taskMessage(sub.task) });
  } catch (error) {
    console.warn("Could not redraw the subtasks", { channel, ts, error: error.message });
  }
}
