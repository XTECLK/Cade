import { assigned, autoLinked, onTheirPlate, request, toAsk } from "../notify.ts";
import { acknowledged, applyChanges, changeTask } from "./changes.ts";
import { suggesting } from "../intents.ts";
import { suggestionMessage } from "./ai-suggest.ts";
import { askForPerson } from "./status.ts";
import { callSlack, dismiss, escapeSlack, mrkdwn, plainText, respondLater } from "../slack.ts";
import { NOT_A_TASK, loadTask, openPrs, parsePullRequest, prLink, prState, saveTask } from "../tasks.ts";
import type { Handler } from "../types.ts";
import type { AppEnv } from "../env.ts";
import type { Changes, PlainMessage, SlackPayload, StoredTask } from "../types.ts";
import { OutdatedPayload, PR_LINKED, PR_LIST, PR_SUGGESTION, readPayload, type PrLinked, type PrSuggestion, type TaskRef } from "../payloads.ts";

const REVIEWERS_ACTION = "pr:reviewers";
const SUGGEST_LINK_ACTION = "pr:suggest-link";
// Slack needs each button in a row to have its own action_id, so "Just link"
// has one too; its value says what to do, as for the other button.
const SUGGEST_LINK_ONLY_ACTION = "pr:suggest-link-only";
const SUGGEST_SKIP_ACTION = "pr:suggest-skip";
// The reviewer picker on the question, for a task with no reviewer yet; its
// choice is read when Link is pressed.
const SUGGEST_REVIEWERS_ACTION = "pr:suggest-reviewers";
const SUGGEST_REVIEWERS_BLOCK = "pr:suggest-reviewers";
// OK and Unlink on the private note that pasted pull requests were linked (see linkPasted).
const LINKED_OK_ACTION = "pr:linked-ok";
const LINKED_UNLINK_ACTION = "pr:linked-unlink";

// Slack sends links as <https://…> or <https://…|label>; pasted text may also
// hold bare addresses.
const LINK = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/\S+)/g;

const HOW = "Try `@Cade pr add <link>` or `@Cade pr remove <link>`.";

// `@Cade pr add <link> [<link> …]` in a task thread links pull requests to the
// task, counted on its card; `@Cade pr remove <link> [<link> …]` unlinks them.
// GitHub, GitLab and Bitbucket links are recognised.
//
// Linking reacts ✅ to the command and asks the task's reviewers to review it
// in a message of its own while it is In review (see notify.ts); the status is left to the
// suggestions. In review with no reviewer yet, whoever sent it is asked privately to assign one
// (see askForPerson in status.ts), as moving it to In review would.
//
// People also paste pull requests into a task's thread without `@Cade pr
// add`. Those are linked at once (see linkPasted). The Link buttons and the reviewer picker below
// answer questions posted before: when pasted ones were asked about first, and when this command
// asked who should review with a picker.
export default {
  name: "pr",
  description: "Link or unlink pull requests (in a task thread)",
  usage: ["@Cade pr add <link>", "@Cade pr remove <link>"],
  section: "task",
  channel: "channel",
  inThread: true,
  async run(command, { env }) {
    const [action = ""] = command.text.split(/\s+/, 1);
    const adding = action.toLowerCase() === "add";
    if (!adding && action.toLowerCase() !== "remove") return HOW;

    const links = [...command.text.slice(action.length).matchAll(LINK)].map((match) => (match[1] ?? match[2])!);
    if (!links.length) return `Which pull request? Paste its link. ${HOW}`;
    const prs = links.map(parsePullRequest);
    const notPr = links.find((link, i) => !prs[i]);
    if (notPr) return `Hmm, that doesn't look like a pull request link: ${escapeSlack(notPr)}`;
    // The same request linked twice in one message counts once.
    const urls = [...new Set(prs.map((pr) => pr!.url))];

    const task = await loadTask(env, command.channel, command.threadTs!);
    if (!task) return NOT_A_TASK;

    const where = { channel: command.channel, ts: command.threadTs! };
    if (adding) {
      const added = urls.filter((url) => !task.prs.includes(url));
      if (!added.length) return "Those pull requests are already linked to this task, so we're all set.";
      // The task card counts it, so a ✅ says it was linked; the reviewers
      // are still asked, or whoever sent it to assign one.
      const parts = await changeTask(env, where, { prs: { add: added } }, command.user);
      if (task.status === "IN_REVIEW" && !task.people.reviewer.length) await askForPerson(env, where.channel, where.ts, "reviewer", command.user);
      return acknowledged(parts);
    }

    const removed = urls.filter((url) => task.prs.includes(url));
    if (!removed.length) return "Hmm, those pull requests aren't linked to this task.";
    return acknowledged(await changeTask(env, where, { prs: { remove: removed } }, command.user));
  },
  actions: {
    [REVIEWERS_ACTION]: async (payload, context) => {
      context.waitUntil(chooseReviewers(payload, context.env));
    },
    [SUGGEST_LINK_ACTION]: async (payload, context) => {
      context.waitUntil(acceptSuggestion(payload, context.env));
    },
    [SUGGEST_LINK_ONLY_ACTION]: async (payload, context) => {
      context.waitUntil(acceptSuggestion(payload, context.env));
    },
    [SUGGEST_SKIP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
    [LINKED_OK_ACTION]: async (payload, context) => {
      const note = readPayload<PrLinked>(PR_LINKED, payload.actions[0].value, "OK button");
      context.waitUntil(
        (async () => {
          await afterNote(context.env, note, payload.response_url);
          if (!note.changes) await askToReview(context.env, note, payload.user.id);
        })(),
      );
    },
    [LINKED_UNLINK_ACTION]: async (payload, context) => {
      const note = readPayload<PrLinked>(PR_LINKED, payload.actions[0].value, "Unlink button");
      context.waitUntil(
        (async () => {
          await afterNote(context.env, note, payload.response_url);
          await unlinkPasted(context.env, note, note.urls, payload.user.id);
        })(),
      );
    },
    // Choosing reviewers only chooses; Link links.
    [SUGGEST_REVIEWERS_ACTION]: async () => {},
  },
} satisfies Handler;

// Links the pull requests that aren't linked yet. Returns { added }, or null
// when they were all linked already.
async function addPullRequests(env: AppEnv, channel: string, ts: string, task: StoredTask, urls: string[]) {
  const added = urls.filter((url) => !task.prs.includes(url));
  if (!added.length) return null;
  task.prs = [...task.prs, ...added];
  await saveTask(env, channel, ts, task);
  return { added };
}

// Links the pull requests pasted into a task's thread that aren't linked yet, and returns them. People
// paste one to say it's this task's, and when they were asked first, privately, many were never
// linked. Cade linked them, not whoever pasted them, so the thread hears only that they were
// auto-linked, as any link is recorded, and no one is asked anything yet: whoever pasted them is told
// privately first (see noteLinked), and what else the message means, who reviews them included, is
// suggested after that and notifies as any change does. Off with pr-links.
export async function linkPasted(env: AppEnv, message: PlainMessage, target: TaskRef, task: StoredTask) {
  if (!suggesting(env, "pr-links", message.channel)) return [];
  const urls = pullRequestsIn(message.text).filter((url) => !task.prs.includes(url));
  if (!urls.length) return [];
  const change = await changeTask(env, target, { prs: { add: urls } }, message.user, { told: message.mentions });
  if (!change?.prs) return [];
  const added = change.prs.added;
  await callSlack(env, "chat.postMessage", { channel: target.channel, thread_ts: target.ts, text: autoLinked(added) });
  return added;
}

// Tells whoever pasted pull requests, privately, that they were linked (`urls`), with OK and Unlink, for
// one pasted only to point at. Either, clicked, turns the note into the question about `changes`, what
// else the message means (see afterNote), or removes it when there are none; once it's gone, the card's
// Pull requests button takes one off (see prs.ts).
export async function noteLinked(env: AppEnv, message: PlainMessage, { target, task }: { target: TaskRef; task: StoredTask }, urls: string[], changes: Changes | null) {
  const note = `I linked ${urls.map(prLink).join(", ")} to this task from your message.`;
  const value = JSON.stringify({ ...target, urls, told: message.mentions, ...(changes && { changes, from: task.status }) });
  await callSlack(env, "chat.postEphemeral", {
    channel: message.channel,
    thread_ts: message.threadTs,
    user: message.user,
    text: note,
    blocks: [
      { type: "section", text: mrkdwn(note) },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: LINKED_OK_ACTION, text: plainText("OK"), value },
          { type: "button", action_id: LINKED_UNLINK_ACTION, text: plainText("Unlink"), value },
        ],
      },
    ],
  });
}

// OK or Unlink clicked: the note becomes the question about what else the message means, from the
// task as it is now, or goes when there's nothing to ask.
async function afterNote(env: AppEnv, { channel, ts, changes, from, told }: PrLinked, responseUrl: string) {
  const task = changes && (await loadTask(env, channel, ts));
  if (!changes || !task) return dismiss(responseUrl);
  await respondLater(responseUrl, { replace_original: true, ...suggestionMessage({ channel, ts }, task, changes, { from, told }) });
}

// OK on a note with nothing to suggest: the pull requests stay, so they're reviewed as any linked
// while the task is In review would be. Its reviewers are asked in the thread, but not those the
// message mentioned, who saw it, nor whoever pasted it; with no reviewer yet, whoever pasted it is
// asked privately to assign one (see askForPerson in status.ts). Before In review, no one is: moving
// there asks them. With something to suggest, accepting it notifies instead, so no one is asked twice.
async function askToReview(env: AppEnv, { channel, ts, urls, told = [] }: PrLinked, user: string) {
  const task = await loadTask(env, channel, ts);
  if (task?.status !== "IN_REVIEW" || !urls.some((url) => openPrs(task).includes(url))) return;
  if (!task.people.reviewer.length) return askForPerson(env, channel, ts, "reviewer", user);
  const reviewers = toAsk(task.people.reviewer, user, Object.fromEntries(told.map((id) => [id, null])));
  if (reviewers.length) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: request(reviewers, "reviewer") });
}

// Unlink on that note: takes off the pull requests the message linked that are still linked and open
// (a merged or closed one stays, as in the Pull requests form), and the thread hears who did, as for any
// change.
async function unlinkPasted(env: AppEnv, target: TaskRef, urls: string[], user: string) {
  const task = await loadTask(env, target.channel, target.ts);
  if (!task) return;
  const remove = urls.filter((url) => task.prs.includes(url) && prState(task, url) === "OPEN");
  if (remove.length) await applyChanges(env, { channel: target.channel, ts: target.ts }, { prs: { remove } }, user);
}

// The pull requests linked in a message's text, each once.
export function pullRequestsIn(text: string | undefined): string[] {
  return [
    ...new Set(
      [...(text ?? "").matchAll(LINK)]
        .map((match) => parsePullRequest((match[1] ?? match[2])!)?.url)
        .filter(Boolean) as string[],
    ),
  ];
}

// Applies the chosen suggestion of an earlier question, adding the reviewers and linking the pull
// requests, and removes the private question. The thread only hears what's
// new to it: a review request for reviewers the message didn't mention; with no reviewer at all,
// while it is In review, whoever clicked is asked privately to assign one (see askForPerson).
async function acceptSuggestion(payload: SlackPayload, env: AppEnv) {
  const { channel, ts, urls = [], mentioned = [], ...fields } = readPayload<PrSuggestion>(PR_SUGGESTION, payload.actions[0].value, "pull request suggestion");
  // Reviewers chosen on the question's picker, when it had one.
  const picked = payload.state?.values?.[SUGGEST_REVIEWERS_BLOCK]?.[SUGGEST_REVIEWERS_ACTION]?.selected_users;
  const reviewers = picked ?? fields.reviewers ?? [];
  const user = payload.user.id;
  const task = await loadTask(env, channel, ts);
  let reply: string | null = null;
  if (task) {
    const added = reviewers.filter((id: string) => !task.people.reviewer.includes(id));
    task.people.reviewer = [...task.people.reviewer, ...added];
    const linked = await addPullRequests(env, channel, ts, task, urls);
    // Linking saves the task; adding only reviewers needs its own save.
    if (!linked && added.length) await saveTask(env, channel, ts, task);

    const lines: string[] = [];
    // Not those the message mentioned, nor whoever wrote it.
    const unasked = toAsk(task.people.reviewer, user, Object.fromEntries(mentioned.map((id: string) => [id, null])));
    // They are asked while it is In review; otherwise when it gets there.
    if (linked && unasked.length && onTheirPlate(task, "reviewer")) lines.push(request(unasked, "reviewer", linked.added));
    if (lines.length) reply = lines.join("\n");
    if (linked && !task.people.reviewer.length && task.status === "IN_REVIEW") await askForPerson(env, channel, ts, "reviewer", user);
  }
  if (reply) await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: reply });
  // An ephemeral message can only be changed through its response_url.
  await respondLater(payload.response_url, { delete_original: true });
}

// Assigns the chosen people as reviewers, and posts who did with the request
// to review, as a new reply, since an edited message notifies no one. The
// picker keeps what happened before its question, or goes if there was
// nothing. It is a reply in the task's thread.
async function chooseReviewers(payload: SlackPayload, env: AppEnv) {
  const channel = payload.channel.id;
  const ts = payload.message.thread_ts!;
  const chosen: string[] = payload.actions[0].selected_users ?? [];
  if (!chosen.length) return;

  const task = await loadTask(env, channel, ts);
  if (!task) {
    await callSlack(env, "chat.update", { channel, ts: payload.message.ts, ...asSection(NOT_A_TASK) });
    return;
  }
  task.people.reviewer = [...new Set([...task.people.reviewer, ...chosen])];
  await saveTask(env, channel, ts, task);
  // The pull requests the picker asked about, or all of the task's when the
  // list did not fit in the block.
  let urls: string[];
  try {
    urls = readPayload<string[]>(PR_LIST, payload.actions[0].block_id, "reviewer picker");
  } catch (error) {
    if (!(error instanceof OutdatedPayload)) throw error;
    urls = task.prs;
  }
  const lead = (payload.message.text ?? "").split("\n").slice(0, -1).join("\n");
  if (lead) await callSlack(env, "chat.update", { channel, ts: payload.message.ts, ...asSection(lead) });
  else await callSlack(env, "chat.delete", { channel, ts: payload.message.ts });
  // Whoever picked themselves isn't asked.
  const others = chosen.filter((id) => id !== payload.user.id);
  // Asked while it is In review; otherwise when it gets there.
  const asked = others.length && onTheirPlate(task, "reviewer") && request(others, "reviewer", urls);
  const text = [assigned(payload.user.id, chosen, "reviewer"), asked].filter(Boolean).join("\n");
  await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text });
}

// chat.update keeps a message's old blocks unless new ones are sent.
function asSection(text: string) {
  return { text, blocks: [{ type: "section", text: mrkdwn(text) }] };
}
