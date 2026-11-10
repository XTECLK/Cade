import { subtasksOf } from "../db.ts";
import { acknowledge, callSlack, dismiss, escapeSlack, mrkdwn, plainText, respondLater } from "../slack.ts";
import { applyChanges } from "./changes.ts";
import { INCIDENT, NOT_A_TASK, PRIORITIES, STATUSES, loadTask, peopleLine, readTaskForm, shownPeople, subtasksLine, taskFormBlocks } from "../tasks.ts";
import { createTask } from "./track.ts";
import { linkCommand } from "./subtask-link.ts";
import type { AppEnv } from "../env.ts";
import type { Context, Handler, SlackBlock, SlackPayload, Status, StoredTask, Task } from "../types.ts";
import { SUBTASKS_CLOSE, TASK_BUTTON, readPayload, type SubtasksClose, type TaskRef } from "../payloads.ts";

// Subtasks: a task split into parts, or the issues testing found in it. Each is a task of its own in
// the same channel, with its own card and thread, that names its parent; the parent's card counts
// them, open and closed (Done). They go one level deep: a subtask has none of its own.
//
// Add subtask, on a task card's ⋯ menu (see menu.ts), opens the form below. The new subtask starts
// with its parent's due date and people, and has its priority for good, which follows the parent's
// (see followParent in tasks.ts); only the due date can be changed (a subtask of an incident is an incident too:
// Urgent and due Immediate for good, so its form asks only for the title), as the same owner usually fixes and the same tester checks it, and the
// parent's thread hears that it was added, with a link to the subtask's own thread.
//
// View subtasks, on the menu of a task that has any, lists them in a modal, open first, each linking
// to its thread.
//
// A task moves to Client review or Done only once all its subtasks are done, as both speak of the
// whole of it. Moving it there with some open, by a command, Edit, a suggestion or anything else,
// leaves its status as it is and warns whoever did it, privately, naming them, with Close all
// subtasks, which moves each to Done and then the task where it was going, and Cancel. An AI agent is
// refused, with the same reason (see updateTask in mcp.ts).

const SUBTASK_USAGE = "Give the subtask a title: `@Cade subtask Payment fails with a saved card`.";

const ADD_VIEW = "subtask:add";
const CLOSE_ALL_ACTION = "subtasks:close";
const CANCEL_ACTION = "subtasks:cancel";

// The most subtasks the modal lists in each of Open and Closed: a modal holds 100 blocks.
const MAX_LISTED = 40;

export const ONE_LEVEL = "This is a subtask already, and subtasks don't have their own. Add it to the main task instead.";

// `@Cade subtask <title>` in a task's thread does what Add subtask does, with the task's due date, and
// reacts ✅; the thread hears it was added as from the form.
export default {
  name: "subtask",
  description: "Add a subtask to the task, with its due date and priority (in its thread)",
  usage: "@Cade subtask <title>",
  section: "task",
  channel: "channel",
  inThread: true,
  async run(command, { env }) {
    const parent = await loadTask(env, command.channel, command.threadTs!);
    if (!parent) return NOT_A_TASK;
    if (parent.parent) return ONE_LEVEL;
    const title = command.text.trim().replace(/\s+/g, " ").slice(0, 150);
    if (!title) return SUBTASK_USAGE;
    await createTask(env, newSubtask(parent, command.threadTs!, title, command.user), { channel: command.channel });
    return acknowledge();
  },
  // `/cade subtask link` and `unlink`, for admins tidying up tasks made before subtasks: not in help,
  // which lists only slash commands with a slashUsage (see subtask-link.ts).
  slashChannel: [],
  slashAdmin: true,
  slash: linkCommand,
  views: { [ADD_VIEW]: submit },
  actions: {
    [CLOSE_ALL_ACTION]: (payload, context) => {
      context.waitUntil(closeAll(payload, context));
    },
    [CANCEL_ACTION]: async (payload) => {
      await dismiss(payload.response_url);
    },
  },
} satisfies Handler;

// Warns `user`, privately in the task's thread, that it can't move to `status` while its subtasks
// are open, naming them, with Close all subtasks and Cancel. `saved`: whether the rest of what they
// changed was saved, such as other fields on the Edit form.
export async function warnOpenSubtasks(env: AppEnv, origin: TaskRef, status: Status, user: string, { saved = false } = {}) {
  const open = (await subtasksOf(env, origin.channel, origin.ts)).filter(({ task }) => task.status !== "DONE");
  if (!open.length) return;
  const names = open.map(({ task }) => (task.link ? `<${task.link}|${escapeSlack(task.title)}>` : `*${escapeSlack(task.title)}*`)).join(", ");
  const count = `${open.length} subtask${open.length === 1 ? " is" : "s are"}`;
  const text = `:warning: ${count} still open: ${names}. A task moves to ${STATUSES[status]} only once all its subtasks are done, so I left its status as it is.${saved ? " Your other changes are saved." : ""}`;
  const value = JSON.stringify({ ...origin, status });
  await callSlack(env, "chat.postEphemeral", {
    channel: origin.channel,
    thread_ts: origin.ts,
    user,
    text,
    blocks: [
      { type: "section", text: mrkdwn(text) },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: CLOSE_ALL_ACTION, style: "primary", text: plainText("Close all subtasks"), value },
          { type: "button", action_id: CANCEL_ACTION, text: plainText("Cancel") },
        ],
      },
    ],
  });
}

// What follows a subtask's status change `{ from, to }` made by `user`: closing it (Done) or reopening it
// is told in its main task's thread, with how its subtasks now stand. Other moves aren't, as only its
// own thread needs them. Not for a task that isn't a subtask, nor while Close all subtasks closes
// them one after another (`quiet`), which tells the thread once.
export async function tellMainTask(env: AppEnv, channel: string, ts: string, { from, to }: { from: Status; to: Status }, user: string) {
  if ((from === "DONE") === (to === "DONE")) return;
  const task = await loadTask(env, channel, ts);
  if (!task?.parent) return;
  const main = await loadTask(env, channel, task.parent.ts);
  if (!main) return;
  const title = task.link ? `<${task.link}|${escapeSlack(task.title)}>` : `*${escapeSlack(task.title)}*`;
  const text = `<@${user}> ${to === "DONE" ? "closed" : "reopened"} the subtask ${title}. ${subtasksLine(main)}.`;
  await callSlack(env, "chat.postMessage", { channel, thread_ts: task.parent.ts, text }).catch((error) => {
    console.warn("Could not tell the main task's thread", { ts: task.parent!.ts, error: error.message });
  });
}

// Close all subtasks: moves each open subtask to Done, each thread hearing it, then the task to the
// status it was going to, and says so in place of the warning. The task's thread hears which were
// closed once, rather than once each.
async function closeAll(payload: SlackPayload, { env }: Context) {
  const request = readPayload<SubtasksClose>(SUBTASKS_CLOSE, payload.actions[0].value, "Close all subtasks button");
  const user = payload.user.id;
  if (!(await loadTask(env, request.channel, request.ts))) {
    await respondLater(payload.response_url, { replace_original: true, text: NOT_A_TASK });
    return;
  }
  const open = (await subtasksOf(env, request.channel, request.ts)).filter(({ task }) => task.status !== "DONE");
  for (const { ts } of open) await applyChanges(env, { channel: request.channel, ts }, { status: "DONE" }, user, { quiet: true });
  if (open.length) {
    const names = open.map(({ task }) => (task.link ? `<${task.link}|${escapeSlack(task.title)}>` : `*${escapeSlack(task.title)}*`)).join(", ");
    await callSlack(env, "chat.postMessage", { channel: request.channel, thread_ts: request.ts, text: `<@${user}> closed all its subtasks: ${names}.` });
  }
  await applyChanges(env, { channel: request.channel, ts: request.ts }, { status: request.status }, user);
  const closed = `Closed ${open.length} subtask${open.length === 1 ? "" : "s"}`;
  await respondLater(payload.response_url, { replace_original: true, text: `${closed} and moved the task to ${STATUSES[request.status]}.` });
}

// The form for a subtask of `parent`, at `origin`.
export function subtaskForm(origin: TaskRef, parent: StoredTask) {
  if (parent.parent) return ONE_LEVEL;
  return {
    type: "modal",
    callback_id: ADD_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("Add subtask"),
    submit: plainText("Add"),
    close: plainText("Cancel"),
    blocks: [
      {
        type: "context",
        elements: [
          mrkdwn(
            parent.incident
              ? `Subtask of the incident *${escapeSlack(parent.title)}*, and an incident too: :red_circle: Urgent and due Immediate. It starts with the incident's people; change them with Edit on its card.`
              : `Subtask of *${escapeSlack(parent.title)}*, with its priority, ${PRIORITIES[parent.priority]} ${parent.priority}. It starts with the task's due date and people; change the date here, or later with Edit on its card.`,
          ),
        ],
      },
      // The task's due date to begin with, as a part of it is usually due with it. No priority: it is the task's.
      ...taskFormBlocks("Subtask title", { dueDate: parent.dueDate }, { details: !parent.incident }).filter((block) => block.block_id !== "priority"),
    ],
  };
}

async function submit(payload: SlackPayload, context: Context) {
  const { env } = context;
  const origin = readPayload<TaskRef>(TASK_BUTTON, payload.view.private_metadata, "Add subtask form");
  const { title, dueDate, errors } = readTaskForm(payload.view.state.values, "Please give the subtask a title.");
  if (errors) return { response_action: "errors", errors };
  const parent = await loadTask(env, origin.channel, origin.ts);
  if (!parent) return { response_action: "errors", errors: { title: "I'm not tracking that task any more." } };
  if (parent.parent) return { response_action: "errors", errors: { title: ONE_LEVEL } };

  context.waitUntil(createTask(env, newSubtask(parent, origin.ts, title, payload.user.id, { dueDate }), { channel: origin.channel }));
  return { response_action: "clear" };
}

// A new subtask of `parent`, whose root message is `ts`, made by `user`: with the parent's people, and
// its priority, and its due date unless `details` gives another. A subtask of an incident is an incident too,
// Urgent and due Immediate, whatever `details` says.
export function newSubtask(parent: StoredTask, ts: string, title: string, user: string, details: Partial<Pick<Task, "dueDate">> = {}): Task {
  return {
    title,
    status: "TODO",
    ...(parent.incident ? { ...INCIDENT, incident: true } : { priority: parent.priority, dueDate: details.dueDate ?? parent.dueDate ?? "" }),
    people: structuredClone(parent.people),
    createdBy: user,
    parent: { ts, title: parent.title, link: parent.link, owner: parent.people.owner },
  };
}

// The modal listing the subtasks of `parent`, at `origin`: open ones first, oldest first, then the
// closed ones, each with its status and people, linking to its thread.
export async function subtasksView(env: AppEnv, origin: TaskRef, parent: StoredTask) {
  const all = await subtasksOf(env, origin.channel, origin.ts);
  const open = all.filter(({ task }) => task.status !== "DONE");
  const closed = all.filter(({ task }) => task.status === "DONE");
  const heading = parent.link ? `<${parent.link}|${escapeSlack(parent.title)}>` : escapeSlack(parent.title);
  const blocks: SlackBlock[] = [
    { type: "section", text: mrkdwn(`*${heading}*`) },
    { type: "context", elements: [mrkdwn(subtasksLine({ subtaskCounts: { open: open.length, closed: closed.length } }) || "No subtasks.")] },
    ...group("Open", open),
    ...group("Closed", closed),
  ];
  return { type: "modal", title: plainText("Subtasks"), close: plainText("Close"), blocks };
}

function group(name: string, entries: { ts: string; task: StoredTask }[]): SlackBlock[] {
  if (!entries.length) return [];
  const blocks: SlackBlock[] = [{ type: "divider" }, { type: "section", text: mrkdwn(`*${name} (${entries.length})*`) }];
  for (const { task } of entries.slice(0, MAX_LISTED)) {
    const title = task.link ? `<${task.link}|${escapeSlack(task.title)}>` : escapeSlack(task.title);
    blocks.push({ type: "section", text: mrkdwn(`${title}\n${STATUSES[task.status]}  ·  ${peopleLine({ people: shownPeople(task) }) || "_Unassigned_"}`) });
  }
  if (entries.length > MAX_LISTED) blocks.push({ type: "context", elements: [mrkdwn(`_…and ${entries.length - MAX_LISTED} more._`)] });
  return blocks;
}
