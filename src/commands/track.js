import { groupDisabled } from "../channels.js";
import { POST_ATTEMPTS, countPostAttempt, insertTask, markTaskPosted } from "../db.js";
import { CLOSE_ALL, callSlack, escapeSlack, plainText } from "../slack.js";
import { moveMessage, offerStart } from "./move.js";
import { mcpEnabled } from "../mcp.js";
import { addPages } from "../export.js";
import {
  INCIDENT,
  chosenProject,
  noPeople,
  projectBlock,
  readTaskForm,
  refreshSummary,
  setPinned,
  taskFormBlocks,
  taskMessage,
} from "../tasks.js";

const TRACK_VIEW = "track";
const INCIDENT_VIEW = "incident";

// `/cade task` in a dev channel opens the task form straight away, since a
// slash command carries a trigger_id, and posts the task in that channel.
// `/cade incident` does the same for an incident, asking only what it is:
// incidents are always urgent and due immediately, and their cards say
// they're incidents.
//
// `@Cade task` or `@Cade incident` in the thread of a message in a dev
// channel offers, privately, to start one from that message (see offerStart
// in move.js): the form, named from its first line, and once it is posted
// the message is moved into its thread. The message shortcuts New task
// and New incident do the same from any message, anywhere (see
// move.js); outside a dev channel, with more than one group, the form asks
// which project it's for.
export default {
  name: "task",
  description: "Track a task (`@Cade task` in a message's thread tracks that message)",
  usage: "@Cade task",
  slashUsage: "/cade task",
  section: "message",
  channel: "channel",
  run: (command, { env }) => fromThread(env, command, "task"),
  async slash(command, { env }) {
    await callSlack(env, "views.open", { trigger_id: command.triggerId, view: trackView(env, { channel: command.channel }) });
  },
  views: { [TRACK_VIEW]: submit },
};

export const incident = {
  name: "incident",
  description: "Report an incident, always urgent and due immediately",
  usage: "@Cade incident",
  slashUsage: "/cade incident",
  section: "message",
  channel: "channel",
  run: (command, { env }) => fromThread(env, command, "incident"),
  async slash(command, { env }) {
    await callSlack(env, "views.open", { trigger_id: command.triggerId, view: incidentView(env, { channel: command.channel }) });
  },
  views: { [INCIDENT_VIEW]: submitIncident },
};

// `@Cade task` and `@Cade incident` start one from a message in the
// channel, replied in its thread.
function fromThread(env, command, kind) {
  const inThread = command.threadTs && command.threadTs !== command.ts;
  if (inThread) return offerStart(env, command, kind);
  return `To start one from a message, reply \`@Cade ${kind}\` in its thread, or use \`/cade ${kind}\` for something new.`;
}

// `origin` says where the task goes: `channel`, the dev channel, or, without
// one, the form asks for the project. It may have `title` to start with,
// and `move`, the message to move into the task's thread once it is posted
// (see moveMessage in move.js).
export function trackView(env, origin) {
  return {
    type: "modal",
    callback_id: TRACK_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("New task"),
    submit: plainText("Create"),
    close: plainText("Cancel"),
    blocks: [
      ...(origin.channel ? [] : [projectBlock(env)]),
      ...taskFormBlocks("Task title", origin),
    ],
  };
}

// `origin` is as for trackView.
export function incidentView(env, origin) {
  return {
    type: "modal",
    callback_id: INCIDENT_VIEW,
    private_metadata: JSON.stringify(origin),
    title: plainText("New incident"),
    submit: plainText("Report"),
    close: plainText("Cancel"),
    blocks: [
      ...(origin.channel ? [] : [projectBlock(env)]),
      ...taskFormBlocks("What's the incident?", origin, { details: false }),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Incidents are :red_circle: Urgent and due Immediate. I'll pass this straight to the team." }],
      },
    ],
  };
}

// The form's origin, with the project chosen on it, or the errors to show.
function readOrigin(payload) {
  const origin = JSON.parse(payload.view.private_metadata || "{}");
  origin.channel ??= chosenProject(payload.view.state.values);
  return origin.channel ? { origin } : { errors: { project: "Please choose a project." } };
}

async function submit(payload, context) {
  const { values } = payload.view.state;
  const { title, dueDate, priority, errors } = readTaskForm(values, "Please give the task a title.");
  const { origin, errors: noProject } = readOrigin(payload);
  if (errors || noProject) return { response_action: "errors", errors: { ...noProject, ...errors } };

  const task = { title, priority, status: "TODO", dueDate, people: noPeople(), createdBy: payload.user.id };
  if (guides(context.env, origin)) return createAndGuide(context, task, origin, payload.user.id);
  context.waitUntil(createTask(context.env, task, origin));
  return { response_action: "clear" };
}

function submitIncident(payload, context) {
  const { title, errors } = readTaskForm(payload.view.state.values, "Please tell us what's going on.");
  const { origin, errors: noProject } = readOrigin(payload);
  if (errors || noProject) return { response_action: "errors", errors: { ...noProject, ...errors } };

  const task = { title, status: "TODO", ...INCIDENT, incident: true, people: noPeople(), createdBy: payload.user.id };
  if (guides(context.env, origin)) return createAndGuide(context, task, origin, payload.user.id);
  context.waitUntil(createTask(context.env, task, origin));
  return { response_action: "clear" };
}

// Stores the task in the dev channel `origin.channel`, then posts it, and
// returns its root message's ts, if it was posted. Stored before it is
// posted, so that if Slack doesn't take it, it is posted later (see
// retry.js); what follows the post needs only `move` and whoever made it.
// `onPosted`, if given, is called with the task, its link included, as soon
// as its root message is posted, before the rest of what follows the post.
export async function createTask(env, task, origin, { onPosted } = {}) {
  const after = { move: origin.move };
  const id = await insertTask(env, origin.channel, task, after);
  return publishTask(env, { id, channel: origin.channel, task, origin: after, attempts: 0 }, { onPosted });
}

// Posts a stored task that has no root message yet, then pins it
// and moves the message it was made from into its thread, and
// returns its ts. If Slack refuses the post, the task waits for the next
// retry, and whoever made it is told, the first time and when Cade gives up.
export async function publishTask(env, { id, channel, task, origin, attempts }, { onPosted } = {}) {
  let message;
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
  onPosted?.({ ...task, taskId: `${message.channel}:${message.ts}` });
  console.log("Task created", {
    channel: message.channel,
    ts: message.ts,
    priority: task.priority,
    incident: Boolean(task.incident),
    createdBy: task.createdBy,
  });
  await setPinned(env, message.channel, message.ts, true);
  await addPages(env, message.channel, message.ts, task);
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

// After a task is made from a message, its form gives way to a second one
// with a short prompt to paste into the person's AI agent, which reads the
// task's thread and the thread it was made from through Cade's MCP endpoint
// and writes the summary on the task's notes page (see mcp.js), and a line
// on what to do if the agent isn't connected to Cade yet (the Home tab's AI agent button,
// see commands/mcp.js). Only for a task made from a message, and not one from
// a direct message, which Cade can't read. A project turns it off with
// `aiAgentSummary` (false), and turning MCP off (`mcp`: false) does too.

// How long the first form waits for the task to be posted, so its ID can
// go in the prompt, before it closes and the prompt follows as a private
// message. Slack wants an answer within three seconds.
const WAIT_MS = 2200;
const TIMED_OUT = Symbol("timed out");

// Whether the form for a task from `origin` is followed by the prompt.
function guides(env, origin) {
  return mcpEnabled(env) && Boolean(origin.move) && !origin.move.channel.startsWith("D") && !groupDisabled(env, origin.channel, "aiAgentSummary", "AI_AGENT_SUMMARY");
}

// Makes the task as createTask does, then answers its form with the prompt
// for it: a form's answer that replaces the form. If the task isn't posted in
// time, the form closes and the prompt follows in a private message once it
// is.
async function createAndGuide({ env, waitUntil }, task, origin, user) {
  let posted;
  const root = new Promise((resolve) => (posted = resolve));
  waitUntil(createTask(env, task, origin, { onPosted: posted }).finally(() => posted(null)));

  let timer;
  const first = await Promise.race([root, new Promise((resolve) => (timer = setTimeout(resolve, WAIT_MS, TIMED_OUT)))]);
  clearTimeout(timer);

  if (first === TIMED_OUT) {
    waitUntil(
      root.then(async (posted) => {
        if (!posted?.taskId) return;
        await callSlack(env, "chat.postEphemeral", {
          channel: origin.channel,
          user,
          text: `Your task is up. To have your AI agent write its summary, paste this:\n\`\`\`${prompt(posted.taskId)}\`\`\`\n${NOT_CONNECTED}`,
        });
      }),
    );
    return CLOSE_ALL;
  }
  if (!first?.taskId) return CLOSE_ALL;
  return { response_action: "update", view: agentView(prompt(first.taskId)) };
}

const NOT_CONNECTED = "Agent not connected to Cade yet? Open Cade's Home tab and press AI agent.";

// What to paste into the agent, for the task with this ID.
const prompt = (taskId) => `Summarize the Cade task ${taskId} and save the summary once I approve it.`;

// The second form: the prompt, and where to go if the agent isn't connected.
function agentView(text) {
  const section = (mrkdwn) => ({ type: "section", text: { type: "mrkdwn", text: mrkdwn } });
  return {
    type: "modal",
    title: plainText("Summarize with AI"),
    close: plainText("Done"),
    blocks: [
      section(`:white_check_mark: *The task is made.* Paste this into your AI agent to write its summary:\n\`\`\`${text}\`\`\``),
      { type: "context", elements: [{ type: "mrkdwn", text: NOT_CONNECTED }] },
    ],
  };
}
