import { findProject, groupEnabled } from "../channels.js";
import { postedTasks } from "../db.js";
import { sheetEnabled } from "../sheet.js";
import { escapeSlack, linkedThread, respondLater } from "../slack.js";
import { syncExport } from "../export.js";
import { syncNotes } from "../notes.js";
import { writeSummary } from "../summary.js";
import { loadTask, saveTask, syncTask } from "../tasks.js";

const NO_LINK =
  "Paste the link to the task: `/cade resync <link>`, with the link from Copy link on its message. Several links work too. Or `/cade resync summary` or `/cade resync sheet` in a dev channel.";

// Slack sends links as <https://…> or <https://…|label>.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

// `/cade resync <link> [<link> …]` redraws a task's card from what Cade has
// stored, and sends it to the Sheet and summary again, for a card that's
// out of date: one posted before a change to how cards look, such as the ⋯
// menu, or one a failed update left behind. A task in a project with a Doc
// gets its notes page made, if it has none, as tasks made before pages had
// none (see notes.js), and its thread's page, if it has none or isn't known
// to be up to date: the thread is written to it from Slack, and from then on
// each reply is added by itself (see export.js). Nothing changes but the message, so no one is notified, and
// only whoever sent it sees the reply.
//
// `/cade resync summary` in a dev channel rewrites its summary canvas in
// full, with its title, and makes it read-only again (see summary.js), as
// for one someone edited, or one a failed update left behind; and, if the
// group has a Sheet, sends every one of its tasks to it: the first fill after
// the Sheet is added later, or a catch-up after it was cleared. From then on
// each change reaches the Sheet by itself, and rows are matched by Task ID, so
// it is safe to run again.
//
// `/cade resync sheet` does only the Sheet.
export default {
  name: "resync",
  description: "Redraw a task's card from what Cade has stored, quietly",
  slashUsage: ["/cade resync <link>", "/cade resync summary", "/cade resync sheet"],
  admin: true,
  section: "task",
  slashChannel: [],
  async slash(command, context) {
    if (/^summary$/i.test(command.text.trim())) return resyncSummary(command, context);
    if (/^sheet$/i.test(command.text.trim())) return resyncSheet(command, context);
    const links = [...command.text.matchAll(LINK)].map((match) => linkedThread(match[1] ?? match[2])).filter(Boolean);
    if (!links.length) return NO_LINK;
    // Redrawing can take longer than Slack waits for a slash command's
    // answer, so the reply follows.
    context.waitUntil(
      (async () => {
        const lines = [];
        for (const link of links) lines.push(await resync(context.env, link));
        await respondLater(command.responseUrl, { text: lines.join("\n") });
      })(),
    );
  },
};

// Rewrites the summary of the dev channel the command was sent in, and sends
// all its tasks to its Sheet, each if the group has one.
function resyncSummary(command, context) {
  const group = findProject(context.env, command.channel);
  if (!group) return "Send `/cade resync summary` in a group's dev channel, for its summary.";
  const canvas = groupEnabled(context.env, group.channel, "summaryCanvas", "SUMMARY_CANVAS");
  const sheet = sheetEnabled(context.env, group);
  if (!canvas && !sheet) return "The summary canvas is off for this group; turn it on with `summaryCanvas` in cade.config.json.";
  // Writing the canvas and the Sheet can take longer than Slack waits for a
  // slash command's answer, so the answer follows.
  context.waitUntil(
    (async () => {
      const lines = [];
      if (canvas) {
        try {
          lines.push(await writeSummary(context.env, group.channel, { full: true, user: command.user }));
        } catch (error) {
          console.error("Could not resync the summary", { channel: group.channel, error: error.message });
          lines.push("Sorry, I couldn't update the summary just now. Could you try again?");
        }
      }
      if (sheet) lines.push(await sendToSheet(context.env, group.channel));
      await respondLater(command.responseUrl, { text: lines.join(" ") });
    })(),
  );
}

// Sends every one of the channel's tasks to its Sheet, and says how it went.
async function sendToSheet(env, channel) {
  try {
    const tasks = await postedTasks(env, channel);
    for (const { ts, task, archived } of tasks) await syncTask(env, channel, ts, task, { archived });
    return `Sent ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} to the Sheet. From now on changes reach it by themselves.`;
  } catch (error) {
    console.error("Could not resync the sheet", { channel, error: error.message });
    return "Sorry, I couldn't send the tasks to the Sheet just now. Could you try again?";
  }
}

// Sends every task of the dev channel the command was sent in to its Sheet.
function resyncSheet(command, context) {
  const group = findProject(context.env, command.channel);
  if (!group) return "Send `/cade resync sheet` in a group's dev channel, for its tasks.";
  if (!sheetEnabled(context.env, group)) {
    return `This group has no Google Sheet. Add one with \`npm run group -- --name ${group.name} --sheet new\`, then send this again.`;
  }
  // A channel's worth of rows takes longer than Slack waits for a slash
  // command's answer, so the answer follows.
  context.waitUntil(
    (async () => {
      await respondLater(command.responseUrl, { text: await sendToSheet(context.env, group.channel) });
    })(),
  );
}

// Redraws what the link points at and says how it went.
async function resync(env, { channel, ts }) {
  const task = await loadTask(env, channel, ts);
  if (!task) return "That link isn't to a task I'm tracking.";
  await syncNotes(env, channel, ts, task);
  await syncExport(env, channel, ts, task);
  await saveTask(env, channel, ts, task);
  const title = escapeSlack(task.title);
  return `Resynced the task ${task.link ? `<${task.link}|${title}>` : `*${title}*`}.`;
}
