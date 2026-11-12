import { readChanges, today } from "../ai.ts";
import { countReject, pauseRejects, resetRejects, setSuggestions } from "../db.ts";
import { suggesting } from "../intents.ts";
import { callSlack, dismiss, escapeSlack, mentions, mrkdwn, plainText, respondLater } from "../slack.ts";
import { PRIORITIES, ROLES, STATUSES, loadTask, prLink } from "../tasks.ts";
import { applyChanges } from "./changes.ts";
import { editForm } from "./edit.ts";
import { nobodyLine, nobodyText } from "./status.ts";
import type { Allowed } from "../ai.ts";
import type { Changes, Handler, Role, Status } from "../types.ts";
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
// off for the person (the same switch as Settings → Suggestions in the Home tab). Keep them stops
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
      { type: "context", elements: [mrkdwn("You can change this any time in Cade's Home tab → Settings → Suggestions.")] },
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

// Reads with AI what the message asks to change on `about`'s task (with the pull requests the message
// just linked, `linked`, linked already; see suggestWork in suggest.ts), with the people it mentions as
// reviewers of them, or null. Throws if the model fails, for suggest.ts to fall back on the reviewers
// alone.
export async function changesFromAi(env: AppEnv, message: PlainMessage, { task }: About, linked: string[] = []) {
  const handOffs = suggesting(env, "hand-offs", message.channel) || suggesting(env, "started", message.channel);
  const allowed: Allowed = {
    roles: handOffs ? (Object.keys(ROLES) as Role[]) : [],
    // A task done in parts only gets DONE, and only for a message about the whole (see checkChanges):
    // a message about one part says nothing about the whole.
    status: (suggesting(env, "started", message.channel) || suggesting(env, "progress", message.channel)),
    details: suggesting(env, "details", message.channel) && !task.incident,
    // Blocked and unblocked are progress on a task, so they follow the same setting as its status.
    blocked: suggesting(env, "started", message.channel) || suggesting(env, "progress", message.channel),
  };
  // Pull requests aren't suggested: those pasted are linked already (see linkPasted in pr.ts).
  const read = allowed.roles!.length || allowed.status || allowed.details || allowed.blocked;
  return withReviewers(message, task, read ? await readChanges(env, { message, task, today: today(env), allowed }) : null, linked);
}

// `changes` with the people the message mentions added as reviewers, when it linked pull requests
// (`linked`): pasting a link and mentioning someone asks them to review it. Shared with the fallback in
// suggest.ts. Null when there's nothing to change.
export function withReviewers(message: PlainMessage, task: StoredTask, changes: Changes | null, linked: string[]): Changes | null {
  const reviewers = linked.length ? message.mentions.filter((id) => !task.people.reviewer.includes(id)) : [];
  if (!reviewers.length) return changes;
  const current = changes?.people?.reviewer;
  return {
    ...changes,
    people: {
      ...changes?.people,
      reviewer: {
        add: [...new Set([...(current?.add ?? []), ...reviewers])],
        remove: (current?.remove ?? []).filter((id) => !reviewers.includes(id)),
      },
    },
  };
}

// Asks whoever wrote `message`, privately, whether to make `changes` (as changes.ts takes them) to
// `task`, with a summary and Accept, Edit… and Reject.
export async function askToChange(env: AppEnv, message: PlainMessage, { target, task }: About, changes: Changes) {
  await callSlack(env, "chat.postEphemeral", {
    channel: message.channel,
    thread_ts: message.threadTs,
    user: message.user,
    ...suggestionMessage(target, task, changes, { from: task.status, told: message.mentions }),
  });
}

// A private suggestion for the task at `target`. With `changes`: the question, their summary from
// `task`, and Accept, Edit… and Reject, which carry the status it was suggested at, `from`, and who the
// message mentioned, `told`, who were notified by it, so applying it doesn't notify them again (see
// applyChanges). Under the summary, the role they'd leave with no one at the stage they move it to, if
// any (see nobodyLine). With none, only the role with no one, `missing`, the task having reached its
// stage (see askForPerson in status.ts): nothing to accept, so only Edit…, the task's Edit form, and
// Reject. Also what the note that a pasted pull request was linked turns into, once clicked (see pr.ts).
export function suggestionMessage(
  target: Origin,
  task: StoredTask,
  changes: Changes | null,
  { from, told, missing }: { from?: Status; told?: string[]; missing?: Role },
) {
  const question = "Should I update the task? From your message:";
  const value = JSON.stringify({ ...target, changes: changes ?? {}, from, told });
  const role = changes ? nobodyLine(task, changes) : missing;
  const nobody = role ? nobodyText(role) : null;
  const edit = { type: "button", action_id: EDIT_ACTION, text: plainText("Edit…"), value };
  const reject = { type: "button", action_id: REJECT_ACTION, text: plainText("Reject"), value: "{}" };
  return {
    text: changes ? question : nobody!,
    blocks: [
      ...(changes
        ? [
            { type: "section", text: mrkdwn(question) },
            { type: "section", text: mrkdwn(summary(task, changes)) },
            ...(nobody ? [{ type: "context", elements: [mrkdwn(nobody)] }] : []),
          ]
        : [{ type: "section", text: mrkdwn(nobody!) }]),
      {
        type: "actions",
        elements: changes ? [{ type: "button", action_id: ACCEPT_ACTION, text: plainText("Accept"), style: "primary", value }, edit, reject] : [edit, reject],
      },
      // Where to turn these off, as there's no button for it here (see suggestionsRow in home.ts).
      { type: "context", elements: [mrkdwn("Don't want these? Turn them off in Cade's Home tab → Settings → Suggestions.")] },
    ],
  };
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
          await applyChanges(context.env, target, changes, payload.user.id, { from, told, saw: true });
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
      await respondLater(payload.response_url, { replace_original: true, text: "Done. I won't suggest changes from your messages. To get them back, open Cade's Home tab → Settings → Suggestions." });
    },
    [KEEP_ACTION]: async (payload, { env }) => {
      await pauseRejects(env, payload.user.id, KEEP_DAYS);
      await respondLater(payload.response_url, { replace_original: true, text: `OK, I'll keep suggesting changes, and won't ask about this for ${KEEP_DAYS} days.` });
    },
  },
} satisfies Handler;
