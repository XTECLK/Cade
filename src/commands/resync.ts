import { findProject, groupEnabled } from "../channels.ts";
import { callSlack, escapeSlack, linkedThread, respondLater } from "../slack.ts";
import { syncExport } from "../export.ts";
import { syncNotes } from "../notes.ts";
import { writeSummary } from "../summary.ts";
import { STATUSES, loadTask, saveTask, taskMessage } from "../tasks.ts";
import { tasksWithStatus } from "../db.ts";
import { readPrStates } from "../github.ts";
import type { Handler, Status } from "../types.ts";
import type { AppEnv } from "../env.ts";
import type { Context, SlashCommand } from "../types.ts";

const NO_LINK =
  "Paste the link to the task: `/cade resync <link>`, with the link from Copy link on its message. Several links work too. Or `/cade resync summary` in a dev channel.";

// Slack sends links as <https://…> or <https://…|label>.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

// `/cade resync <link> [<link> …]` redraws a task's card from what Cade has
// stored, for a card that's out of date: one posted before a change to how
// cards look, such as the ⋯ menu, or one a failed update left behind. A task
// gets the links to its notes page and its thread's page, if it has none, and
// its thread is read from Slack again, to store what is missing (see
// export.ts). Where its GitHub pull requests stand is read again too, all the links' in one request
// (see readPrStates in github.ts). Nothing changes but the message, so no one is notified, and only
// whoever sent it sees the reply; but a pull request found merged or closed is told in its task's thread,
// as the sync would have.
//
// `/cade resync all` in a dev channel redraws its tasks' cards, Done ones and subtasks too, quietly, as
// for one, a run at a time (see resyncAll), having read all their GitHub pull requests in one request.
// Archived tasks' cards are left as they are.
//
// `/cade resync summary` in a dev channel rewrites its summary canvas in
// full, with its title, and makes it read-only again (see summary.ts), as
// for one someone edited, or one a failed update left behind.
export default {
  name: "resync",
  description: "Redraw a task's card from what Cade has stored, quietly",
  slashUsage: ["/cade resync <link>", "/cade resync all", "/cade resync summary"],
  admin: true,
  slashChannel: [],
  async slash(command, context) {
    if (/^summary$/i.test(command.text.trim())) return resyncSummary(command, context);
    const all = /^all(?:\s+(\d+))?$/i.exec(command.text.trim());
    if (all) return resyncAll(command, context, Number(all[1] ?? 0));
    const links = [...command.text.matchAll(LINK)].map((match) => linkedThread((match[1] ?? match[2])!)).filter(Boolean) as { channel: string; ts: string }[];
    if (!links.length) return NO_LINK;
    // Redrawing can take longer than Slack waits for a slash command's
    // answer, so the reply follows.
    context.waitUntil(
      (async () => {
        const lines: string[] = [];
        const tasks = await Promise.all(links.map(({ channel, ts }) => loadTask(context.env, channel, ts)));
        await readPrStates(context.env, tasks.flatMap((task) => task?.prs ?? []));
        for (const link of links) lines.push(await resync(context.env, link));
        await respondLater(command.responseUrl, { text: lines.join("\n") });
      })(),
    );
  },
} satisfies Handler;

// One-off, for redrawing the cards made before subtasks and the three-part card: remove it once every
// project's cards are redrawn.
//
// Redraws the next ALL_BATCH cards of the dev channel the command was sent in, from the `from`-th, in
// the order the tasks were made, and says what to send for the next ones. Nothing is kept between
// runs: the number sent says where to go on. A run stays under Slack's limit on message updates
// (about 50 a minute) and a Worker's on calls in one request, so runs a minute apart are safe; if
// Slack asks to slow down sooner, the reply says where to start again.
const ALL_BATCH = 40;

function resyncAll(command: SlashCommand, context: Context, from: number) {
  const group = findProject(context.env, command.channel);
  if (!group) return "Send `/cade resync all` in a project's dev channel, for its task cards.";
  context.waitUntil(
    (async () => {
      const statuses = Object.keys(STATUSES) as Status[];
      // Read first, so the cards are drawn with them.
      await readPrStates(context.env, (await tasksWithStatus(context.env, group.channel, statuses)).flatMap(({ task }) => task.prs));
      const tasks = await tasksWithStatus(context.env, group.channel, statuses);
      const batch = tasks.slice(from, from + ALL_BATCH);
      let next = from;
      let slowed = false;
      for (const { ts, task } of batch) {
        try {
          await callSlack(context.env, "chat.update", { channel: group.channel, ts, ...taskMessage(task) });
        } catch (error) {
          if (/ratelimited/.test(error.message)) {
            slowed = true;
            break;
          }
          // A card Slack can't update, such as one deleted by hand, is passed over.
          console.warn("Could not redraw the card", { ts, error: error.message });
        }
        next++;
      }
      const again = (at: number) => `send \`/cade resync all ${at}\` for the next ones`;
      const drew = next === from ? "no cards" : next === from + 1 ? `card ${next}` : `cards ${from + 1}–${next}`;
      const text = !tasks.length
        ? "There are no task cards in this channel to redraw."
        : from >= tasks.length
          ? `There are only ${tasks.length} task cards in this channel, all redrawn.`
          : slowed
            ? `Redrew ${drew} of ${tasks.length} before Slack asked me to slow down. In a minute, ${again(next)}.`
            : next < tasks.length
              ? `Redrew ${drew} of ${tasks.length}. In a minute, ${again(next)}.`
              : `Redrew ${drew} of ${tasks.length}: every card in this channel is up to date.`;
      await respondLater(command.responseUrl, { text });
    })(),
  );
}

// Rewrites the summary of the dev channel the command was sent in.
function resyncSummary(command: SlashCommand, context: Context) {
  const group = findProject(context.env, command.channel);
  if (!group) return "Send `/cade resync summary` in a group's dev channel, for its summary.";
  const canvas = groupEnabled(context.env, group.channel, "summaryCanvas", "SUMMARY_CANVAS");
  if (!canvas) return "The summary canvas is off for this group; turn it on with `summaryCanvas` in cade.config.json.";
  // Writing the canvas can take longer than Slack waits for a
  // slash command's answer, so the answer follows.
  context.waitUntil(
    (async () => {
      const lines: string[] = [];
      try {
        lines.push(await writeSummary(context.env, group.channel, { full: true, user: command.user }));
      } catch (error) {
        console.error("Could not resync the summary", { channel: group.channel, error: error.message });
        lines.push("Sorry, I couldn't update the summary just now. Could you try again?");
      }
      await respondLater(command.responseUrl, { text: lines.join(" ") });
    })(),
  );
}

// Redraws what the link points at and says how it went.
async function resync(env: AppEnv, { channel, ts }: { channel: string; ts: string }) {
  const task = await loadTask(env, channel, ts);
  if (!task) return "That link isn't to a task I'm tracking.";
  syncNotes(env, channel, ts, task);
  await syncExport(env, channel, ts, task);
  await saveTask(env, channel, ts, task);
  const title = escapeSlack(task.title);
  return `Resynced the task ${task.link ? `<${task.link}|${title}>` : `*${title}*`}.`;
}
