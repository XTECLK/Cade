import { setTaskParent } from "../db.ts";
import { callSlack, escapeSlack, linkedThread, respondLater } from "../slack.ts";
import { AFTER_SUBTASKS, INCIDENT, loadTask, redrawParent, saveTask, setPinned, statusName, subtaskAdded } from "../tasks.ts";
import type { AppEnv } from "../env.ts";
import type { Context, SlashCommand, StoredTask } from "../types.ts";

// `/cade subtask link <task> <main task>` makes a task made before subtasks existed a subtask of
// another, and `/cade subtask unlink <task>` makes a subtask a task of its own again: for tidying up
// tasks once, so only for the admins in cade.config.json, and not listed in help. Each takes the
// links from Copy link on the cards.
//
// A link keeps the task's own due date and people, and takes the main task's priority, following the
// rules a new subtask does: in the same channel, one level deep, and an incident's subtask is an
// incident too (it becomes Urgent and due Immediate). A main task in Client review or Done takes only a done subtask, as it
// waits for its subtasks. Both cards are redrawn, the subtask is unpinned (pinned again once
// unlinked, if open), and the main task's thread hears it, as it does a new subtask.

type Ref = { channel: string; ts: string };

const USAGE = "Send `/cade subtask link <task link> <main task link>`, or `/cade subtask unlink <task link>`, with the links from Copy link on the cards.";

// Slack sends links as <https://…> or <https://…|label>.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

// Only admins get here (see dispatchSlash).
export function linkCommand(command: SlashCommand, context: Context) {
  const [verb = "", ...rest] = command.text.trim().split(/\s+/);
  const links = [...rest.join(" ").matchAll(LINK)].map((match) => linkedThread((match[1] ?? match[2])!)).filter(Boolean) as Ref[];
  const run =
    verb.toLowerCase() === "link" && links.length === 2
      ? () => link(context.env, links[0]!, links[1]!, command.user)
      : verb.toLowerCase() === "unlink" && links.length === 1
        ? () => unlink(context.env, links[0]!, command.user)
        : null;
  if (!run) return USAGE;
  // Redrawing cards can take longer than Slack waits for a slash command's answer, so the reply follows.
  context.waitUntil(
    (async () => {
      let text: string;
      try {
        text = await run();
      } catch (error) {
        console.error("Could not link the subtask", { error: error.message });
        text = "Sorry, something went wrong. Could you try again?";
      }
      await respondLater(command.responseUrl, { text });
    })(),
  );
}

const named = (task: StoredTask) => (task.link ? `<${task.link}|${escapeSlack(task.title)}>` : `*${escapeSlack(task.title)}*`);

// Makes the task at `child` a subtask of the one at `parent`, and says how it went.
async function link(env: AppEnv, child: Ref, parent: Ref, user: string) {
  const [task, main] = await Promise.all([loadTask(env, child.channel, child.ts), loadTask(env, parent.channel, parent.ts)]);
  if (!task || !main) return `The ${!task ? "first" : "second"} link isn't to a task I'm tracking.`;
  if (child.channel !== parent.channel) return "A subtask goes in its main task's channel, and these are in different ones.";
  if (child.ts === parent.ts) return "That's the same task twice.";
  if (main.parent) return `${named(main)} is a subtask itself, and subtasks don't have their own.`;
  const { open = 0, closed = 0 } = task.subtaskCounts ?? {};
  if (open + closed) return `${named(task)} has subtasks of its own, and subtasks go one level deep. Unlink them first.`;
  if (task.parent?.ts === parent.ts) return `${named(task)} is a subtask of ${named(main)} already.`;
  if (task.incident && !main.incident) return `${named(task)} is an incident, and an incident's main task must be one too.`;
  if (AFTER_SUBTASKS.includes(main.status) && task.status !== "DONE") {
    return `${named(main)} is in ${statusName(main.status)}, which waits for all its subtasks to be done, and ${named(task)} isn't. Move one of them first.`;
  }

  const before = task.parent;
  await setTaskParent(env, child.channel, child.ts, parent.ts);
  const linked = (await loadTask(env, child.channel, child.ts))!;
  const made = main.incident && !linked.incident;
  if (made) Object.assign(linked, INCIDENT, { incident: true });
  else if (!linked.incident) linked.priority = main.priority;
  // Saving redraws its card, the main task's, which counts it, and the summary.
  await saveTask(env, child.channel, child.ts, linked);
  if (before) await redrawParent(env, child.channel, { parent: before });
  await setPinned(env, child.channel, child.ts, false);
  await callSlack(env, "chat.postMessage", { channel: parent.channel, thread_ts: parent.ts, text: subtaskAdded(user, linked) });
  console.log("Subtask linked", { channel: child.channel, ts: child.ts, parent: parent.ts, by: user });
  return `Made ${named(linked)} a subtask of ${named(main)}.${made ? " It's an incident now, like its main task: Urgent and due Immediate." : ""}`;
}

// Makes the subtask at `child` a task of its own again, and says how it went.
async function unlink(env: AppEnv, child: Ref, user: string) {
  const task = await loadTask(env, child.channel, child.ts);
  if (!task) return "That link isn't to a task I'm tracking.";
  if (!task.parent) return `${named(task)} isn't a subtask.`;
  const before = task.parent;
  await setTaskParent(env, child.channel, child.ts, null);
  const alone = (await loadTask(env, child.channel, child.ts))!;
  await saveTask(env, child.channel, child.ts, alone);
  await redrawParent(env, child.channel, { parent: before });
  if (alone.status !== "DONE") await setPinned(env, child.channel, child.ts, true);
  await callSlack(env, "chat.postMessage", { channel: child.channel, thread_ts: before.ts, text: `<@${user}> made ${named(alone)} a task of its own.` });
  console.log("Subtask unlinked", { channel: child.channel, ts: child.ts, parent: before.ts, by: user });
  return `Made ${named(alone)} a task of its own again.`;
}
