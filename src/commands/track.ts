import { knownProject } from "../channels.ts";
import { POST_ATTEMPTS, countPostAttempt, insertTask, markTaskPosted } from "../db.ts";
import { callSlack, escapeSlack, plainText, type SlackAnswers } from "../slack.ts";
import { moveMessage, offerStart } from "./move.ts";
import { addPages } from "../export.ts";
import {
  INCIDENT,
  chosenProject,
  noPeople,
  projectBlock,
  readTaskForm,
  redrawParent,
  refreshSummary,
  subtaskAdded,
  taskFormBlocks,
  taskMessage,
} from "../tasks.ts";
import type { Handler } from "../types.ts";
import type { AppEnv } from "../env.ts";
import type { Command, Context, SlackPayload, Task } from "../types.ts";
import { TRACK_FORM, readPayload, type TrackForm } from "../payloads.ts";

// Where a new task goes (see trackView): its channel, a title to start with, and the
// message to move into its thread once it is posted, with `away` when Cade isn't in
// that message's channel.
export type TrackOrigin = { channel: string; title?: string; move?: { channel: string; ts: string; away?: boolean } };
type Origin = TrackOrigin;
// What a form starts with: as TrackOrigin, but the project may be left for the person to choose.
export type FormOrigin = Omit<TrackOrigin, "channel"> & { channel?: string };
// A task stored but not yet posted (see unpostedTasks).
type Unposted = { id: number; channel: string; task: Task; origin: { move?: { channel: string; ts: string } }; attempts: number };

const TRACK_VIEW = "track";
const INCIDENT_VIEW = "incident";

// `/cade task`, in any channel (Slack sends a slash command even from one Cade isn't in), opens the task form straight away,
// since a slash command carries a trigger_id. `/cade incident` does the same
// for an incident, asking only what it is: incidents are always urgent and
// due immediately, and their cards say they're incidents.
//
// `@Cade task` or `@Cade incident` in the thread of a message, in any channel
// Cade is in, offers, privately, to start one from that message (see
// offerStart in move.ts): the form, named from its first line, and once it is
// posted the message is moved into its thread. The message shortcuts New task
// and New incident do the same from any message, anywhere (see move.ts).
//
// Every one of these forms starts with the Project, which it needs: chosen
// already in a project's channel, or when there's only one project, and
// otherwise left for the person to choose.
export default {
  name: "task",
  description: "Track a task (`@Cade task` in a message's thread tracks that message)",
  usage: "@Cade task",
  slashUsage: "/cade task",
  section: "message",
  run: (command, { env }) => fromThread(env, command, "task"),
  async slash(command, { env }) {
    await callSlack(env, "views.open", { trigger_id: command.triggerId, view: trackView(env, { channel: knownProject(env, command.channel) }) });
  },
  views: { [TRACK_VIEW]: submit },
} satisfies Handler;

export const incident = {
  name: "incident",
  description: "Report an incident, always urgent and due immediately",
  usage: "@Cade incident",
  slashUsage: "/cade incident",
  section: "message",
  run: (command, { env }) => fromThread(env, command, "incident"),
  async slash(command, { env }) {
    await callSlack(env, "views.open", { trigger_id: command.triggerId, view: incidentView(env, { channel: knownProject(env, command.channel) }) });
  },
  views: { [INCIDENT_VIEW]: submitIncident },
} satisfies Handler;

// `@Cade task` and `@Cade incident` start one from a message in the
// channel, replied in its thread.
function fromThread(env: AppEnv, command: Command, kind: "task" | "incident") {
  const inThread = command.threadTs && command.threadTs !== command.ts;
  if (inThread) return offerStart(env, command, kind);
  return `To start one from a message, reply \`@Cade ${kind}\` in its thread, or use \`/cade ${kind}\` for something new.`;
}

// `origin` says where the task goes: `channel`, the project's dev channel,
// chosen on the form's Project to begin with, or, without one, left for the
// person to choose. It may have `title` to start with, and `move`, the
// message to move into the task's thread once it is posted (see moveMessage
// in move.ts).
export function trackView(env: AppEnv, origin: FormOrigin) {
  return {
    type: "modal",
    callback_id: TRACK_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("New task"),
    submit: plainText("Create"),
    close: plainText("Cancel"),
    blocks: [
      projectBlock(env, { initial: origin.channel }),
      ...awayWarning(origin),
      ...taskFormBlocks("Task title", origin),
    ],
  };
}

// `origin` is as for trackView.
export function incidentView(env: AppEnv, origin: FormOrigin) {
  return {
    type: "modal",
    callback_id: INCIDENT_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("New incident"),
    submit: plainText("Report"),
    close: plainText("Cancel"),
    blocks: [
      projectBlock(env, { initial: origin.channel }),
      ...awayWarning(origin),
      ...taskFormBlocks("What's the incident?", origin, { details: false }),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Incidents are :red_circle: Urgent and due Immediate. I'll pass this straight to the team." }],
      },
    ],
  };
}

// The warning for a form made from a message in a channel Cade isn't in: the message is copied
// from the form, but Cade can't note under it where it went, nor read its replies.
export function awayWarning({ move }: FormOrigin) {
  if (!move?.away) return [];
  const text = `:warning: I'm not in <#${move.channel}>, so I'll copy only this message, and can't note under it where it went or read its replies. Invite me with \`/invite @Cade\` in <#${move.channel}> first.`;
  return [{ type: "context", elements: [{ type: "mrkdwn", text }] }];
}

// The form's origin, with the project chosen on it, or the errors to show.
// Forms opened before every form had the Project have only the origin's.
function readOrigin(payload: SlackPayload) {
  const origin = readPayload<TrackForm>(TRACK_FORM, payload.view.private_metadata || "{}", "New task form");
  const channel = chosenProject(payload.view.state.values) ?? origin.channel;
  return channel ? { origin: { ...origin, channel } } : { errors: { project: "Please choose a project." } };
}

function submit(payload: SlackPayload, context: Context) {
  const { values } = payload.view.state;
  const { title, dueDate, priority, errors } = readTaskForm(values, "Please give the task a title.");
  const { origin, errors: noProject } = readOrigin(payload);
  if (errors || noProject) return { response_action: "errors", errors: { ...noProject, ...errors } };

  const task: Task = { title, priority: priority!, status: "TODO", dueDate, people: noPeople(), createdBy: payload.user.id };
  context.waitUntil(createTask(context.env, task, origin));
  return { response_action: "clear" };
}

function submitIncident(payload: SlackPayload, context: Context) {
  const { title, errors } = readTaskForm(payload.view.state.values, "Please tell us what's going on.");
  const { origin, errors: noProject } = readOrigin(payload);
  if (errors || noProject) return { response_action: "errors", errors: { ...noProject, ...errors } };

  const task: Task = { title, status: "TODO", ...INCIDENT, incident: true, people: noPeople(), createdBy: payload.user.id };
  context.waitUntil(createTask(context.env, task, origin));
  return { response_action: "clear" };
}

// Stores the task in the dev channel `origin.channel`, then posts it, and
// returns its root message's ts, if it was posted. Stored before it is
// posted, so that if Slack doesn't take it, it is posted later (see
// retry.ts); what follows the post needs only `move` and whoever made it.
export async function createTask(env: AppEnv, task: Task, origin: Origin) {
  const after = { move: origin.move };
  const id = await insertTask(env, origin.channel, task, after);
  return publishTask(env, { id, channel: origin.channel, task, origin: after, attempts: 0 });
}

// Posts a stored task that has no root message yet, then moves the
// message it was made from into its thread, and
// returns its ts. If Slack refuses the post, the task waits for the next
// retry, and whoever made it is told, the first time and when Cade gives up.
export async function publishTask(env: AppEnv, { id, channel, task, origin, attempts }: Unposted): Promise<string | undefined> {
  let message: SlackAnswers["chat.postMessage"];
  try {
    message = await callSlack(env, "chat.postMessage", { channel, ...taskMessage(task) });
  } catch (error) {
    const tried = await countPostAttempt(env, id);
    console.warn("Could not post the task", { id, attempts: tried, error: error.message });
    if (attempts === 0 || tried >= POST_ATTEMPTS) {
      const text = tried >= POST_ATTEMPTS
        ? `Sorry, I couldn't create the task "${escapeSlack(task.title)}", even after a few tries.`
        : `Sorry, I couldn't post the task "${escapeSlack(task.title)}" just now. I'll try again in a few minutes.`;
      await callSlack(env, "chat.postEphemeral", { channel, user: task.createdBy, text }).catch(() => {});
    }
    return;
  }
  // The task's link is stored with it. It is a convenience,
  // so the task is stored without it if it can't be looked up.
  try {
    ({ permalink: task.link } = await callSlack(env, "chat.getPermalink", {
      channel: message.channel,
      message_ts: message.ts,
    }));
  } catch (error) {
    console.warn("Could not link the task", { ts: message.ts, error: error.message });
  }
  await markTaskPosted(env, id, message.ts, task.link);
  console.log("Task created", {
    channel: message.channel,
    ts: message.ts,
    priority: task.priority,
    incident: Boolean(task.incident),
    createdBy: task.createdBy,
  });
  await addPages(env, message.channel, message.ts, task);
  if (task.parent) await announceSubtask(env, message.channel, task);
  // A group's summary canvas is made with its first new task.
  await refreshSummary(env, message.channel, { create: true });
  if (origin.move) {
    const problem = await moveMessage(env, {
      from: origin.move,
      target: { channel: message.channel, ts: message.ts },
      user: task.createdBy,
    }).catch((error) => error.message);
    if (problem) console.warn("Could not move the message", { ts: origin.move.ts, problem });
  }
  return message.ts;
}

// A new subtask is counted on its parent's card, and the parent's thread hears it was added, with a
// link to the subtask's own thread. Both are conveniences, so a failure is only logged.
async function announceSubtask(env: AppEnv, channel: string, task: Task) {
  await redrawParent(env, channel, task);
  await callSlack(env, "chat.postMessage", { channel, thread_ts: task.parent!.ts, text: subtaskAdded(task.createdBy, task) }).catch((error) => {
    console.warn("Could not tell the parent's thread about its subtask", { ts: task.parent!.ts, error: error.message });
  });
}
