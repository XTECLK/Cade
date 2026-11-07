import { isQuestion, phraseTest } from "../intents.ts";
import { changeMessage } from "../notify.ts";
import { acknowledged, changeTask } from "./changes.ts";
import { acknowledge, callSlack, dismiss, escapeSlack, mrkdwn, plainText } from "../slack.ts";
import {
  NOT_A_TASK,
  STATUSES,
  approverBlock,
  loadTask,
  notTheApprover,
  prLink,
  readApprover,
  saveTask,
  setPinned,
  unsentPrs,
} from "../tasks.ts";
import type { Handler } from "../types.ts";
import type { AppEnv } from "../env.ts";
import type { Context, PlainMessage, SlackBlock, SlackPayload, Status, StoredTask, Task } from "../types.ts";
import { TASK_APPROVAL, TASK_BUTTON, TASK_FORM, readPayload, type TaskApproval, type TaskForm, type TaskRef } from "../payloads.ts";

// Where a task is: its channel and its root message.
type Origin = { channel: string; ts: string };

const APPROVE_ACTION = "status:approve";
const REJECT_ACTION = "status:reject";
const ASK_ACTION = "status:ask";
const REVIEW_VIEW = "status:review";

// `@Cade status in progress` (or `IN_PROGRESS`, `in-progress`, `wip`) in a
// task thread sets the task's status, and Cade reacts ✅ to the message.
// Without a status it says which there are. Moving a task to DONE unpins it
// from the channel; moving it out of DONE pins it again.
//
// Done can be set directly. Client review is an optional step for work the
// client should check first: whoever moves a task there picks who approves
// it, and Cade asks them in the task's thread, with Approve and Not approve
// buttons that only they can click. Approve moves the task to Done; Not
// approve moves it back to In progress.

const STATUS_USAGE = "Try `@Cade status in review`: to do, in progress, in review, in testing, client review or done.";

// The words that say how the work is going (see soundsLikeProgress): a
// reviewer approving, a tester passing it, or anyone on the task finishing it.
// See intents.ts for how phrases match.
const APPROVED = phraseTest(["lgtm", "approv(ed|ing)", "looks good", "review(ed)? (is )?done", "done review*", "ship it"]);
const PASSED = phraseTest([
  "qa (passed|done|ok)",
  "passed qa",
  "test(s|ing)? (passed|done)",
  "tested",
  "verified",
  "works (fine|well|as expected)",
  "all good",
  "no (issues|bugs) found",
]);
const FINISHED = phraseTest(["done", "finished", "complete(d)?", "merged", "deployed", "released", "shipped", "fixed"]);
// Words that put the progress off or in doubt: "not done yet", "almost
// finished", "once it's merged"; or say only part of it is: "finished the
// login subtask", "first part is done".
const HEDGED =
  /\b(not|almost|nearly|once|when|after|until|before|if|sub-?tasks?|parts?|partly|partial(ly)?|some of|one of|first|half|step)\b|n['’]t\b/i;

// Whether a message says, in so many words, that the work has moved on: an
// approval, a pass or it being finished, not asked and not hedged. Which
// status that means depends on who said it (see progressOptions); Cade
// suggests it in a task's thread (see suggest.ts).
export function soundsLikeProgress(message: PlainMessage) {
  return !isQuestion(message) && !HEDGED.test(message.text) && [APPROVED, PASSED, FINISHED].some((test) => test(message));
}

export default {
  name: "status",
  description: "Update the task's status (in its thread)",
  usage: "@Cade status in review",
  section: "task",
  channel: "channel",
  inThread: true,
  async run(command, { env }) {
    const task = await loadTask(env, command.channel, command.threadTs!);
    if (!task) return NOT_A_TASK;

    const input = command.text.trim();
    const status = parseStatus(input);
    if (!status) {
      const asked = input ? `I don't know "${escapeSlack(input)}" as a status.` : "Which status?";
      return `${asked} ${STATUS_USAGE}`;
    }

    // A status typed in the command needs only a ✅, since the task card shows
    // it, plus the testers' request when it reached In testing.
    return acknowledged(await changeTask(env, { channel: command.channel, ts: command.threadTs! }, { status }, command.user));
  },
  actions: {
    [APPROVE_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, true));
    },
    [REJECT_ACTION]: async (payload, context) => {
      context.waitUntil(review(payload, context.env, false));
    },
    [ASK_ACTION]: (payload, { env }) => openApproverForm(payload, env),
  },
  views: { [REVIEW_VIEW]: submitApprover },
} satisfies Handler;

// The statuses a message about how the work is going could move a task in
// `status` to, given what `user` does on it and what they wrote, or []:
//   - a reviewer approving a task In review: In testing;
//   - a tester passing a task In testing, or anyone on the task (or whoever
//     tracked it) saying it's finished: Done.
// A task in Client review waits for the client, and a Done one is done.
export function progressOptions(task: StoredTask, user: string, message: PlainMessage) {
  const { owner, reviewer, tester } = task.people;
  if (task.status === "IN_REVIEW" && reviewer.includes(user) && APPROVED(message)) return ["IN_TESTING"];
  const finishing =
    (task.status === "IN_TESTING" && tester.includes(user) && (PASSED(message) || APPROVED(message))) ||
    ([...owner, ...reviewer, ...tester, task.createdBy].includes(user) && FINISHED(message));
  if (!finishing || ["CLIENT_REVIEW", "DONE"].includes(task.status)) return [];
  return ["DONE"];
}

// Short names people type for each status, besides its own name ("in
// progress", "IN_PROGRESS"), in `@Cade status`.
const STATUS_NAMES: Record<Status, string[]> = {
  TODO: ["to do", "todo", "open"],
  IN_PROGRESS: ["progress", "started", "doing", "wip"],
  IN_REVIEW: ["review", "code review"],
  IN_TESTING: ["testing", "test", "qa"],
  CLIENT_REVIEW: ["client", "approval", "uat"],
  DONE: ["complete", "completed", "finished", "closed"],
};

// The status `input` names, or undefined.
export function parseStatus(input: string): Status | undefined {
  const key = input.toUpperCase().replace(/[\s-]+/g, "_") as Status;
  if (STATUSES[key]) return key;
  const words = input.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  return (Object.keys(STATUS_NAMES) as Status[]).find((status) => STATUS_NAMES[status].includes(words));
}

// A status menu's option.
export function statusOption(status: Status) {
  return { text: { ...plainText(STATUSES[status]), emoji: true }, value: status };
}

// Sets the task's status for `user`, and returns what the thread then
// hears, as one message. Null if it isn't a task, or the status isn't a
// change. For `/cade standup`.
export async function setStatus(env: AppEnv, channel: string, ts: string, status: Status, user: string) {
  const change = await changeTask(env, { channel, ts }, { status }, user);
  return change && changeMessage(change);
}

// Sets the task's status and completion time, for the caller to save.
export function setStatusFields(task: StoredTask, status: Status) {
  const previous = task.status;
  task.status = status;
  if (status !== "DONE") task.completedAt = "";
  else if (previous !== "DONE") task.completedAt = new Date().toISOString();
}

// What follows saving a status change `{ from, to }` made by `user`: the
// task is pinned or unpinned as it leaves or reaches Done, and Client review
// asks whoever moved it, privately, who approves it (see askApprover). Not when
// `source` is "mcp": the change was made by an AI agent, and the person isn't looking at
// Slack, so the private prompt would only be missed; the agent asks them, and then asks the approver
// with requestApproval.
export async function afterStatusChange(env: AppEnv, channel: string, ts: string, { from, to }: { from: Status; to: Status }, user: string, source?: string) {
  if ((from === "DONE") !== (to === "DONE")) await setPinned(env, channel, ts, to !== "DONE");
  if (to === "CLIENT_REVIEW" && source !== "mcp") await askApprover(env, channel, ts, user);
}

// Saves the new status, pinning or unpinning the task as it leaves or
// reaches Done.
async function applyStatus(env: AppEnv, channel: string, ts: string, task: StoredTask, status: Status) {
  const from = task.status;
  setStatusFields(task, status);
  await saveTask(env, channel, ts, task);
  if ((from === "DONE") !== (status === "DONE")) await setPinned(env, channel, ts, status !== "DONE");
}

// A task reaching Client review asks whoever moved it, privately, who
// approves it: the client, or whoever handles them. Only a click carries the
// trigger_id the form needs, so it is a button.
async function askApprover(env: AppEnv, channel: string, ts: string, user: string) {
  const text = "Who should approve this? Choose them, and I'll ask.";
  await callSlack(env, "chat.postEphemeral", {
    channel,
    thread_ts: ts,
    user,
    text,
    blocks: [
      { type: "section", text: mrkdwn(text) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: ASK_ACTION,
            text: plainText("Ask for approval"),
            style: "primary",
            value: JSON.stringify({ channel, ts }),
          },
        ],
      },
    ],
  });
}

const notInReview = (task: Task | null) =>
  task ? `This task is ${STATUSES[task.status]} now, so there's nothing to approve.` : NOT_A_TASK;

// The Ask for approval button opens the form.
async function openApproverForm(payload: SlackPayload, env: AppEnv) {
  const { channel, ts } = readPayload<TaskRef>(TASK_BUTTON, payload.actions[0].value, "Ask for approval button");
  const task = await loadTask(env, channel, ts);
  if (task?.status !== "CLIENT_REVIEW") {
    await callSlack(env, "chat.postEphemeral", { channel, thread_ts: ts, user: payload.user.id, text: notInReview(task) });
    return;
  }
  await callSlack(env, "views.open", {
    trigger_id: payload.trigger_id,
    view: {
      type: "modal",
      callback_id: REVIEW_VIEW,
      // The private button goes once the form is sent (see dismiss).
      private_metadata: JSON.stringify({ channel, ts, responseUrl: payload.response_url }),
      title: plainText("Ask for approval"),
      submit: plainText("Ask"),
      close: plainText("Cancel"),
      blocks: [approverBlock(), { type: "context", elements: [mrkdwn("They approve it in this thread.")] }],
    },
  });
}

function submitApprover(payload: SlackPayload, context: Context) {
  const approver = readApprover(payload.view.state.values);
  if (!approver) return { response_action: "errors", errors: { approver: "Please choose who approves it." } };
  const origin = readPayload<TaskForm>(TASK_FORM, payload.view.private_metadata || "{}", "approver form");
  context.waitUntil(requestReview(context.env, origin, approver, payload.user.id));
  return { response_action: "clear" };
}

// Asks the approver to review the task, in its thread, with its PRs and the
// Approve and Not approve buttons.
async function requestReview(env: AppEnv, origin: Origin & { responseUrl?: string }, approver: string, user: string) {
  const { channel, ts, responseUrl } = origin;
  const task = await loadTask(env, channel, ts);
  if (task?.status !== "CLIENT_REVIEW") {
    await callSlack(env, "chat.postEphemeral", { channel, thread_ts: ts, user, text: notInReview(task) });
    return;
  }
  const ready = `<@${user}> says this is ready for review.`;
  await dismiss(responseUrl);
  await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...reviewPrompt(ready, channel, ts, task, approver) });
}

// Asks `approver` to review the task, in its thread, for `user`, who asked through their AI agent:
// the same request, with the Approve and Not approve buttons, as the form in Slack gives. Returns
// a problem to tell them, or null once it is posted.
export async function requestApproval(env: AppEnv, channel: string, ts: string, approver: string, user: string) {
  const task = await loadTask(env, channel, ts);
  if (task?.status !== "CLIENT_REVIEW") return notInReview(task);
  const ready = `<@${user}> says this is ready for review.\n_(via AI agent)_`;
  await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, ...reviewPrompt(ready, channel, ts, task, approver) });
  return null;
}

// The request with the task's linked pull requests (only those not sent
// with `@Cade release`, if some were), and the approver's Approve and Not
// approve buttons, mentioning them so they are notified. The buttons carry
// the request, PRs included, to keep it when they are replaced, and who may
// click them.
function reviewPrompt(text: string, channel: string, ts: string, task: StoredTask, approver: string) {
  const request = `<@${approver}>, could you take a look and approve it, or let us know what needs to change?`;
  const remaining = task.releases?.length ? unsentPrs(task) : null;
  const prs = remaining ?? task.prs;
  const label = remaining ? "Remaining PRs" : "PRs";
  const announced = prs.length ? `${text}\n*${label}:* ${prs.map(prLink).join(", ")}` : text;
  const value = JSON.stringify({ channel, ts, text: announced, approver });
  return {
    // The mention is in the notification text too.
    text: `${announced}\n${request}`,
    blocks: [
      { type: "section", text: mrkdwn(`${announced}\n${request}`) },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: APPROVE_ACTION,
            text: plainText("Approve"),
            style: "primary",
            value,
          },
          {
            type: "button",
            action_id: REJECT_ACTION,
            text: plainText("Not approve"),
            value,
          },
        ],
      },
    ],
  };
}

// Applies the approver's decision on a task in Client review, then replaces
// the buttons with the decision and tells the task's thread.
async function review(payload: SlackPayload, env: AppEnv, approved: boolean) {
  const request = readPayload<TaskApproval>(TASK_APPROVAL, payload.actions[0].value, "approval button");
  if (await notTheApprover(env, payload, request.approver)) return;
  const user = payload.user.id;
  const task = await loadTask(env, request.channel, request.ts);

  let outcome;
  if (!task) {
    outcome = "Hmm, this task doesn't exist anymore.";
  } else if (task.status !== "CLIENT_REVIEW") {
    // The team moved the task on before anyone clicked.
    outcome = `I didn't change anything: the task has since moved to ${STATUSES[task.status]}.`;
  } else {
    const status = approved ? "DONE" : "IN_PROGRESS";
    await applyStatus(env, request.channel, request.ts, task, status);
    const text = approved
      ? `<@${user}> approved this, so it's now ${STATUSES.DONE}.`
      : `<@${user}> didn't approve this, so it's back to ${STATUSES.IN_PROGRESS}. Have a look at the thread for what needs to change.`;
    await callSlack(env, "chat.postMessage", {
      channel: request.channel,
      thread_ts: request.ts,
      ...asMessage(text),
    });
    outcome = approved
      ? `<@${user}> approved it.`
      : `<@${user}> didn't approve it, so the team will pick it up again.`;
  }
  await callSlack(env, "chat.update", {
    channel: payload.channel.id,
    ts: payload.message.ts,
    ...asMessage(`${request.text}\n${outcome}`),
  });
}

// chat.update keeps a message's old blocks unless new ones are sent, so text
// replies are wrapped in a section.
function asMessage(reply: string | SlackBlock) {
  return typeof reply === "string"
    ? { text: reply, blocks: [{ type: "section", text: mrkdwn(reply) }] }
    : reply;
}
