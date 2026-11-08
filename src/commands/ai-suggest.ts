import { readChanges, today } from "../ai.ts";
import { countReject, pauseRejects, resetRejects, setSuggestions } from "../db.ts";
import { suggesting } from "../intents.ts";
import { callSlack, dismiss, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.ts";
import { PRIORITIES, ROLES, STATUSES, loadTask, prLink } from "../tasks.ts";
import { applyChanges } from "./changes.ts";
import { editForm } from "./edit.ts";
import { pullRequestsIn } from "./pr.ts";
import type { Allowed } from "../ai.ts";
import type { Changes, Handler, Role } from "../types.ts";
import type { AppEnv } from "../env.ts";
import type { PlainMessage, StoredTask } from "../types.ts";
import { SUGGESTION, readPayload, type Suggestion } from "../payloads.ts";

// Where a task is: its channel and its root message.
type Origin = { channel: string; ts: string };
// The task a thread is about (see threadTask in suggest.ts).
type About = { target: Origin; task: StoredTask };

const ACCEPT_ACTION = "ai-suggest:accept";
const EDIT_ACTION = "ai-suggest:edit";
const REJECT_ACTION = "ai-suggest:reject";
const TURN_OFF_ACTION = "ai-suggest:turn-off";
const KEEP_ACTION = "ai-suggest:keep";

// Rejecting this many suggestions in a row, with no Accept or Edit… between, offers to turn them
// off for the person (the same switch as Configure → Suggestions in the Home tab). Keep them stops
// the count for KEEP_DAYS, so they aren't asked again soon. Nothing is turned off without them.
const REJECTS_BEFORE_OFFER = 3;
const KEEP_DAYS = 30;

// The offer, in place of the suggestion just rejected.
function turnOffOffer(rejects: number) {
  const question = `You've turned down my last ${rejects} suggestions. Should I stop suggesting changes from your messages?`;
  return {
    text: question,
    blocks: [
      { type: "section", text: mrkdwn(question) },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: TURN_OFF_ACTION, text: plainText("Turn off"), value: "{}" },
          { type: "button", action_id: KEEP_ACTION, text: plainText("Keep them"), value: "{}" },
        ],
      },
      { type: "context", elements: [mrkdwn("You can change this any time in Cade's Home tab → Configure → Suggestions.")] },
    ],
  };
}

// Suggestions read with AI (see ai.ts): what a message in a task's thread
// asks to change, which can be several people in several roles, the status,
// and, on the team's own tasks, the priority and due date. Whoever wrote it
// is asked, privately, with a summary of what was read: Accept applies it,
// Edit… opens the task's Edit form filled in with it (see edit.ts), and
// Reject drops it. Applying it tells the thread as any change does (see
// changes.ts).

// Reads the message for `about` (the task its thread is about; see
// threadTask in suggest.ts) and, if it asks for changes, asks whoever wrote
// it. Throws if the model fails, for suggest.ts to fall back on pull request links alone.
export async function suggestWithAi(env: AppEnv, message: PlainMessage, { target, task }: About) {
  const handOffs = suggesting(env, "hand-offs", message.channel) || suggesting(env, "started", message.channel);
  const allowed: Allowed = {
    roles: handOffs ? (Object.keys(ROLES) as Role[]) : [],
    // A task done in parts only gets DONE, and only for a message about the whole (see checkChanges):
    // a message about one part says nothing about the whole.
    status: (suggesting(env, "started", message.channel) || suggesting(env, "progress", message.channel)),
    details: suggesting(env, "details", message.channel) && !task.incident,
    // Blocked and unblocked are progress on a task, so they follow the same setting as its status.
    blocked: suggesting(env, "started", message.channel) || suggesting(env, "progress", message.channel),
    prs: suggesting(env, "pr-links", message.channel),
  };
  // The links come from the text, and the model says which are meant to be linked, and which linked ones no longer belong.
  const pullRequests = pullRequestsIn(message.text);
  const read = allowed.roles!.length || allowed.status || allowed.details || allowed.blocked || allowed.prs;
  const changes = withPullRequests(env, message, task, read ? await readChanges(env, { message, task, today: today(env), allowed, pullRequests }) : null, { decided: read });
  if (changes) await askToChange(env, message, { target, task }, changes);
}

// `changes` with the people the message mentions added as reviewers of the pull requests it links,
// unless pr-links is off. Links come from the text, not the model: when the model has decided
// (`decided`), `changes.prs` is its answer, checked; otherwise, with AI off or failed, every link in
// the message that isn't linked yet is added. Shared with the fallback in suggest.ts. Null when there's
// nothing to change.
export function withPullRequests(env: AppEnv, message: PlainMessage, task: StoredTask, changes: Changes | null, { decided = false as boolean | number } = {}): Changes | null {
  if (!suggesting(env, "pr-links", message.channel)) return changes;
  const prs = decided ? changes?.prs : { add: pullRequestsIn(message.text).filter((url) => !task.prs.includes(url)) };
  if (!prs?.add?.length && !prs?.remove?.length) return changes;
  const merged = { ...changes, prs };
  const reviewers = prs.add?.length ? message.mentions.filter((id) => !task.people.reviewer.includes(id)) : [];
  if (reviewers.length) {
    const current = changes?.people?.reviewer ?? { add: [], remove: [] };
    merged.people = {
      ...changes?.people,
      reviewer: {
        add: [...new Set([...current.add!, ...reviewers])],
        remove: current.remove!.filter((id: string) => !reviewers.includes(id)),
      },
    };
  }
  return merged;
}

// Asks whoever wrote `message`, privately, whether to make `changes` (as
// changes.ts takes them) to `task`, with a summary and Accept, Edit… and
// Reject.
export async function askToChange(env: AppEnv, message: PlainMessage, { target, task }: About, changes: Changes) {
  const question = "Should I update the task? From your message:";
  // Whoever the message mentioned was notified by it, so applying it
  // doesn't notify them again (see applyChanges).
  const value = JSON.stringify({ ...target, changes, from: task.status, told: message.mentions });
  await callSlack(env, "chat.postEphemeral", {
    channel: message.channel,
    thread_ts: message.threadTs,
    user: message.user,
    text: question,
    blocks: [
      { type: "section", text: mrkdwn(question) },
      { type: "section", text: mrkdwn(summary(task, changes)) },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: ACCEPT_ACTION, text: plainText("Accept"), style: "primary", value },
          { type: "button", action_id: EDIT_ACTION, text: plainText("Edit…"), value },
          { type: "button", action_id: REJECT_ACTION, text: plainText("Reject"), value: "{}" },
        ],
      },
      // Where to turn these off, as there's no button for it here (see suggestionsRow in home.ts).
      { type: "context", elements: [mrkdwn("Don't want these? Turn them off in Cade's Home tab → Configure → Suggestions.")] },
    ],
  });
}

// What would change, a line each: people added and removed per role,
// marked (Add) and (Remove), then pull requests, then the status, priority and due date, from what they are now.
// Mentions in a message only one person sees notify no one.
export function summary(task: StoredTask, changes: Changes) {
  const lines = (Object.entries(changes.people ?? {}) as [Role, { add: string[]; remove: string[] }][]).map(([role, { add, remove }]) => {
    const parts = [add.length && `${mentions(add)} (Add)`, remove.length && `${mentions(remove)} (Remove)`].filter(Boolean);
    return `*${ROLES[role]}s:* ${parts.join(" · ")}`;
  });
  if (changes.prs) {
    const links = (urls: string[]) => urls.map(prLink).join(", ");
    const { add = [], remove = [] } = changes.prs;
    const parts = [add.length && `${links(add)} (Add)`, remove.length && `${links(remove)} (Remove)`].filter(Boolean);
    if (parts.length) lines.push(`*PRs:* ${parts.join(" · ")}`);
  }
  if (changes.status) lines.push(`*Status:* ${STATUSES[task.status]} → ${STATUSES[changes.status]}`);
  if (changes.priority) lines.push(`*Priority:* ${PRIORITIES[task.priority] ?? ""} ${task.priority} → ${PRIORITIES[changes.priority]} ${changes.priority}`);
  if ("dueDate" in changes) lines.push(`*Due:* ${task.dueDate || "none"} → ${changes.dueDate || "none"}`);
  if (changes.blocked) {
    const { on, reason } = changes.blocked;
    lines.push(on ? `*Blocked:* ${task.blocked ? "yes" : "no"} → yes${reason ? ` (${escapeSlack(reason)})` : ""}` : "*Blocked:* yes → no");
  }
  return lines.join("\n");
}

export default {
  actions: {
    [ACCEPT_ACTION]: async (payload, context) => {
      const { changes, from, told, ...target } = readPayload<Suggestion>(SUGGESTION, payload.actions[0].value, "suggestion's Change button");
      context.waitUntil(
        (async () => {
          // The private message goes first, so the click shows at once:
          // saving takes a few seconds, and may fail.
          await dismiss(payload.response_url);
          await resetRejects(context.env, payload.user.id);
          await applyChanges(context.env, target, changes, payload.user.id, { from, told });
        })(),
      );
    },
    // Opening a form must happen within Slack's three seconds of the click.
    [EDIT_ACTION]: async (payload, { env }) => {
      const { channel, ts, changes, told } = readPayload<Suggestion>(SUGGESTION, payload.actions[0].value, "suggestion's Edit button");
      const task = await loadTask(env, channel, ts);
      if (!task) return;
      await callSlack(env, "views.open", {
        trigger_id: payload.trigger_id,
        view: editForm({ channel, ts }, task, { changes, told, responseUrl: payload.response_url }),
      });
      await resetRejects(env, payload.user.id);
    },
    // A reject goes, unless it's the third in a row: then the suggestion becomes the offer to turn them off.
    [REJECT_ACTION]: async (payload, { env }) => {
      const rejects = await countReject(env, payload.user.id);
      if (rejects < REJECTS_BEFORE_OFFER) return await respondLater(payload.response_url, { delete_original: true });
      await resetRejects(env, payload.user.id);
      await respondLater(payload.response_url, { replace_original: true, ...turnOffOffer(rejects) });
    },
    [TURN_OFF_ACTION]: async (payload, { env }) => {
      await setSuggestions(env, payload.user.id, false);
      console.log("Suggestions turned off", { user: payload.user.id, from: "offer" });
      await respondLater(payload.response_url, { replace_original: true, text: "Done. I won't suggest changes from your messages. To get them back, open Cade's Home tab → Configure → Suggestions." });
    },
    [KEEP_ACTION]: async (payload, { env }) => {
      await pauseRejects(env, payload.user.id, KEEP_DAYS);
      await respondLater(payload.response_url, { replace_original: true, text: `OK, I'll keep suggesting changes, and won't ask about this for ${KEEP_DAYS} days.` });
    },
  },
} satisfies Handler;
