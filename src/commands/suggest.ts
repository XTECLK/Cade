import { aiModel } from "../ai.ts";
import { roleOf } from "../channels.ts";
import { suggestionsOn } from "../db.ts";
import { intent, phraseTest } from "../intents.ts";
import { loadTask } from "../tasks.ts";
import { askToChange, changesFromAi, withReviewers } from "./ai-suggest.ts";
import { linkPasted, noteLinked, pullRequestsIn } from "./pr.ts";
import { soundsLikeProgress } from "./status.ts";
import type { Handler } from "../types.ts";
import type { AppEnv } from "../env.ts";
import type { PlainMessage, StoredTask } from "../types.ts";

// People's own words in a task's thread often mean the task should change,
// and so does a pasted pull request link. This is the one place messages in a
// thread are read; a message posted on its own in a channel has no task yet
// (see move.ts).
//
// A pasted pull request link is linked at once, and the thread hears it was auto-linked. Whoever pasted
// it gets a private note with OK and Unlink, which, clicked, turns into the question below, if there is
// one (see linkPasted and noteLinked in pr.ts). The rest of the message is read with AI (see ai-suggest.ts), which says what it asks to change: who takes each role, the status,
// the priority and due date, and whether the task is blocked. Cade then asks whoever wrote it,
// privately: Accept, Edit… or Reject (see askToChange in ai-suggest.ts). Nothing changes until then,
// and the thread hears only what changed, credited to them.
//
// Phrases decide only which messages are worth sending to the model (see MIGHT_CHANGE); they
// suggest nothing themselves. Without AI, or when it fails, only the people a message linking a pull
// request mentions are suggested, as reviewers. Each kind can be turned off with
// `taskChangeDetection` in cade.config.json:
//   pr-links   a pull request link: linked, and the people it mentions
//              suggested as reviewers
//   hand-offs  a request to develop, review or test it, or saying so oneself
//   started    the work starting: In progress, and blocked or unblocked
//   progress   a reviewer approving, a tester passing it, or anyone on it
//              saying it's finished: the next status; and blocked or unblocked
//   details    the priority and due date, but not an incident's

// Words that make a message worth reading with AI, besides mentioning someone or a pull request
// link: status, priority, dates, who does what, and what is in the way. This only decides which
// messages are sent to the model; it suggests nothing itself.
const MIGHT_CHANGE = phraseTest([
  "urgent",
  "asap",
  "block(er|ing|ed)?",
  "unblock(ed|ing)?",
  "stuck",
  "waiting (on|for)",
  "can['’]?t (continue|proceed|move on|go on)",
  "no longer (blocked|waiting)",
  "critical",
  "priority",
  "due",
  "deadline",
  "by (today|tonight|tomorrow|eod|eow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|end of)",
  "tomorrow",
  "\\d{1,2}(st|nd|rd|th)",
  "\\d{1,2}/\\d{1,2}",
  "lgtm",
  "approv*",
  "merged",
  "deployed",
  "done",
  "finished",
  "review*",
  "test*",
  "qa",
  "started",
  "in progress",
  "wip",
  "on it",
  "start(ing)?",
  "working",
  "picking",
  "taking",
  "looking",
  "handle",
  "fix*",
  "implement*",
  "verify*",
  "assign*",
  "take over",
]);

const workIntent = intent({
  name: "work",
  order: 20,
  kinds: ["pr-links", "hand-offs", "started", "progress", "details"],
  needs: { thread: true },
  match: (message) =>
    message.mentions.length > 0 || pullRequestsIn(message.text).length > 0 || MIGHT_CHANGE(message) || soundsLikeProgress(message),
  handle: (message, { env }) => suggestWork(message, env),
});

export default {
  intents: [workIntent],
  actions: {},
} satisfies Handler;

// The work intent's handler: asks whoever wrote the message, privately, with
// the summary of what it suggests, if anything. Someone who turned suggestions off for
// themselves (Home tab → Settings) is asked nothing, and their message isn't sent to the model.
async function suggestWork(message: PlainMessage, env: AppEnv) {
  if (!(await suggestionsOn(env, message.user))) return;
  const found = await threadTask(env, message);
  if (!found || found.task.status === "DONE") return;
  const linked = await linkPasted(env, message, found.target, found.task);
  // The task as it now is, with them, for the rest of the message to be read against: as if they had
  // been linked before it.
  const about = { ...found, task: { ...found.task, prs: [...found.task.prs, ...linked] } };
  const changes = await readSuggestion(env, message, about, linked);
  if (linked.length) await noteLinked(env, message, about, linked, changes);
  else if (changes) await askToChange(env, message, about, changes);
}

// What the message asks to change, read with AI, or, without it or when it fails, only the people it
// mentions as reviewers of the pull requests it linked; null for nothing.
async function readSuggestion(env: AppEnv, message: PlainMessage, about: { target: { channel: string; ts: string }; task: StoredTask }, linked: string[]) {
  if (aiModel(env)) {
    try {
      return await changesFromAi(env, message, about, linked);
    } catch (error) {
      console.warn("AI couldn't read the message, so only who it asks to review a pull request is read", { error: error.message });
    }
  }
  return withReviewers(message, about.task, null, linked);
}

// The task a thread in a dev channel is about, as { target, task }, or null
// when it is not a task's.
async function threadTask(env: AppEnv, message: PlainMessage) {
  if (roleOf(env, message.channel) !== "channel") return null;
  const target = { channel: message.channel, ts: message.threadTs! };
  const task = await loadTask(env, target.channel, target.ts);
  return task ? { target, task } : null;
}
