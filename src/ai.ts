import { PRIORITIES, STATUSES, cleanReason, inParts } from "./tasks.ts";
import type { AppEnv } from "./env.ts";
import type { Changes, PlainMessage, Priority, Role, Status, Task } from "./types.ts";

// Which kinds of change may be suggested (see checkChanges).
export interface Allowed {
  roles?: Role[];
  status?: boolean;
  details?: boolean;
  prs?: boolean;
  blocked?: boolean;
  // False when the author may not be added to a role.
  author?: boolean;
}

// What the message and the task are, for the model.
type Read = {
  message: Pick<PlainMessage, "user" | "mentions" | "text">;
  task: Task;
  today: { date: string; weekday: string };
  allowed: Allowed;
  pullRequests?: string[];
};

// Reading what a message in a task's thread asks to change, with a model on
// Workers AI: who should develop, review or test it, and its status,
// priority and due date, and whether it is blocked. It needs the Workers AI binding `AI` (see
// wrangler.toml); without it, or if the model fails, only pull request links are suggested (see
// suggest.ts). Suggestions as a whole are turned off with `taskChangeDetection`.
//
// The model only proposes: everything it returns is checked against the
// message and the task here (see checkChanges), and nothing changes until
// whoever wrote the message confirms it.

// The quickest and cheapest of the models that read these messages as well
// as any small one did, keeping to a JSON schema. `aiModel` in cade.config.json (AI_MODEL_NAME)
// can name another text model instead, for every project.
export const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

// Models that reason before answering unless told not to, which only slows
// them down for this, and makes some miss the JSON altogether.
const NO_THINKING = [DEFAULT_MODEL, "@cf/google/gemma-4-26b-a4b-it", "@cf/qwen/qwen3-30b-a3b-fp8"];

// A message in which the author speaks of themselves: only then can AI add
// them to a role ("I'll test it", "on it"), as small models otherwise add
// them to whatever the message is about.
const SPEAKS_FOR_SELF =
  /\b(i|i['’](m|ll|d|ve)|me|my|myself|we|we['’](ll|re)|us|our)\b|^\s*(ok(ay)?[,!.]?\s*)?(on it|taking (this|it)|picking (this |it )?up|starting|started)\b/i;

// A message waits this long for the model before falling back.
const TIMEOUT_MS = 8000;

// The model that reads messages: `aiModel` in cade.config.json (AI_MODEL_NAME), the default
// model if it has none, or null when there is no `AI` binding.
export function aiModel(env: Pick<AppEnv, "AI" | "AI_MODEL_NAME">) {
  if (!env.AI) return null;
  return env.AI_MODEL_NAME || DEFAULT_MODEL;
}

// What the model fills in. Empty strings and lists mean no change, as small
// models keep to a schema without nulls more reliably.
const PEOPLE = {
  type: "object",
  properties: {
    add: { type: "array", items: { type: "string" } },
    remove: { type: "array", items: { type: "string" } },
  },
  required: ["add", "remove"],
};
const SCHEMA = {
  type: "object",
  properties: {
    owner: PEOPLE,
    reviewer: PEOPLE,
    tester: PEOPLE,
    status: { type: "string", enum: ["", ...Object.keys(STATUSES)] },
    priority: { type: "string", enum: ["", ...Object.keys(PRIORITIES)] },
    dueDate: { type: "string", description: "YYYY-MM-DD, \"clear\" to remove it, or \"\"" },
    prs: {
      type: "object",
      properties: {
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
      },
      required: ["add", "remove"],
    },
    blocked: { type: "string", enum: ["", "block", "unblock"] },
    blockedReason: { type: "string", description: "Why it is blocked, in a short phrase, when blocked is \"block\"; otherwise \"\"" },
  },
  required: ["owner", "reviewer", "tester", "status", "priority", "dueDate", "prs", "blocked", "blockedReason"],
};

const INSTRUCTIONS = `You read one Slack message posted in the thread of a task, usually a software one, and say what it asks to change on the task. Reply with JSON only.

People are Slack user IDs such as U0123ABC. In the message, <@U0123ABC> mentions that person. "author" wrote the message; in it, "I", "me", "my" and "we" mean the author. The author is added to a role only when they speak of themselves in the first person ("I'll test it", "on it", "taking this"), never because the message is about someone else.
Slack markup is noise: <https://…|text> is a link, and :emoji: codes carry no request on their own. A :+1:, :rocket:, :eyes: or :tada: alone changes nothing; only :white_check_mark: from a reviewer counts as approval.

Roles:
- owner: does the work, whatever it is: builds, implements or fixes it, or takes it on ("can you implement this", "pick this up", "take this over", "can you handle this").
- reviewer: reviews the code or pull request ("can you review").
- tester: tests it or does QA ("can you test", "QA this", "verify").
Add a person to a role only when the message asks that person to do that work, or the author says they will do it themselves ("I'll test it", "while I test this", "on it"). "remove" lists who should stop ("take over from @bob" removes @bob). Use only IDs from "mentioned", "author" or the task's people, and don't add someone who already has the role.
Never add people for anything else: approving ("lgtm"), a deadline, urgency, thanks or a cc changes no one's role.
Only a request or the author's own promise changes a role. These add no one: a question about the past or present ("did <@UB> review this?", "<@UB> already reviewed it"), or a statement about someone else's work ("<@UB> is testing it", "<@UB> tested it yesterday"). A question such as "who can review?" names no one.

Statuses: TODO, IN_PROGRESS (work started), IN_REVIEW (code ready for review), IN_TESTING (review approved, ready to test), CLIENT_REVIEW (the client checks it), DONE (finished, merged and tested).
The task's "nextStatuses" are the only statuses you may answer with; a task never moves back, so answer "" when the message points to an earlier status or to none. "authorRoles" lists the roles the author holds on the task; approving ("lgtm", "approved", a :white_check_mark: alone) counts only from someone whose authorRoles has "reviewer", and "QA passed" or "tested, works" only from "tester". From anyone else it moves nothing.
Set status only when the message says the work has moved on now ("started on this", "lgtm" from a reviewer, "QA passed", "deployed, please test").
Cues: "started", "working on it", "picked up" → IN_PROGRESS. "PR is up", "ready for review", "please review" → IN_REVIEW. A reviewer's approval, "deployed to staging, please test", "ready for QA" → IN_TESTING. "QA passed" from a tester, "released", "shipped and verified" → DONE. "sent to the client", "client is checking", "waiting on client's approval" → CLIENT_REVIEW. "Merged" alone is not enough: with no sign that testing is next or finished, answer "". Work done on only a part of the task changes no status: a subtask, a piece or phase, one of several items, one side of it ("login part is done", "backend merged, frontend pending", "finished the first step", "subtask 2 is in testing"). Only a message about the whole task moves it. Asking someone to start, a plan ("will start tomorrow") or a question ("is QA done?") changes no status.
When the task's "hasSubtasks" is true, you may answer only with DONE or, from TODO, IN_PROGRESS. DONE only when the message says the whole task is finished and can be closed ("we can close this as done", "all subtasks are done", "everything is merged and verified"). IN_PROGRESS when the task is TODO and the message says work began, even on one subtask or part ("started on subtask 1", "picked up the API part"). Anything else about one subtask or part, or about a later status, is "".
Priorities: ${Object.keys(PRIORITIES).join(", ")}. Set one only when the message says how urgent it is ("this is urgent", "blocking the release", "low priority").
dueDate: when the message sets a deadline, as YYYY-MM-DD. Take a weekday ("by Friday"), "tomorrow" or "today" from "comingDays" and "today", "next Friday", "in a week" or "in two weeks" from "nextWeekDays", or use a date written out in the message ("by 12 Dec", "2026-12-12"). "clear" if it says there's no deadline anymore.
Answer "" for any deadline you can't read straight from those: "next week", "end of month", "soon", "EOD", "ASAP". A missing date is better than a wrong one; never work out a date yourself.

Examples (author UA):
- "<@UB> can you implement this while I test it" → owner add UB, tester add UA.
- "lgtm" from a reviewer, task IN_REVIEW → status IN_TESTING, no one added.
- "urgent, client needs it by Friday" → priority Urgent, dueDate that Friday, no one added.
- "will start on this tomorrow" → nothing.
- "the API part is done, UI still to do" → nothing (only a part).
- "finished subtask 1, moving to testing for that bit" → nothing (only a subtask).
- "we can close this as done", task hasSubtasks → status DONE.
- "all subtasks are done", task hasSubtasks → status DONE.
- "subtask 2 is done", task hasSubtasks → nothing.
- "started on subtask 1", task hasSubtasks and TODO → status IN_PROGRESS.
- "started on subtask 2", task hasSubtasks and already IN_PROGRESS → nothing.
- "thanks <@UB>, cc <@UC>" → nothing.
- "PR is up: <link>" → prs add that link.
- "see <link> for how they did it" → nothing (a reference).
- "closed <linked 42>, new PR <link 43>" → prs remove 42, add 43.
- "<linked 42> is abandoned" → prs remove 42.
- "blocked on the payment API keys", task not blocked → blocked block, blockedReason "waiting on the payment API keys".
- "keys arrived, unblocked", task blocked → blocked unblock.
- "we're still blocked", task already blocked → nothing.
- "this blocks the release" → nothing (this task blocks something else).
- "are we blocked on design?" → nothing (a question).
- "<@UB> already reviewed this" → nothing (about the past).
- "is <@UB> testing it?" → nothing (a question).
- "<@UB> is testing it right now" → nothing (about someone else's work).
- "deployed to staging, please test" from the owner, task IN_REVIEW → status IN_TESTING.
- "lgtm" from someone whose authorRoles is empty → nothing.
- "merged" alone → nothing.
- "<@UB> is taking this" from UA → nothing (a statement about UB, not a request, and UA didn't speak of themselves).
- "let's ship it next week" → nothing (no date to read).
- "needed by next Friday" → dueDate that date from "nextWeekDays".
- ":rocket: :tada:" → nothing.

prs: "pullRequests.inMessage" are the pull request links found in the message by code, and "pullRequests.linked" those already on the task. Never write any other address. "add": the ones in the message that the message wants linked to this task, which is the usual reason to paste one. Leave a link out when it is only mentioned for reference ("see how they did it in <link>") or is about another task. "remove": the ones in "linked" that the message says no longer belong: closed, abandoned, replaced or linked by mistake ("closed this one, new PR is <link>", "wrong PR, unlink it"). A link in "linked" that the message merely mentions stays. Both empty when it says nothing about them.
blocked: the task's "blocked" says whether it is blocked now. Answer "block" (only when it isn't) when the message says the work can't go on because of something it waits for or that is in the way ("blocked on the API keys", "waiting for the client's design", "can't continue until staging is fixed"), with blockedReason as a short phrase of what blocks it, in the message's words, under 100 characters. Answer "unblock" (only when it is) when the message says that is over ("unblocked", "keys arrived, carrying on", "no longer waiting on design"). Otherwise "" and an empty blockedReason. A question ("are we blocked?"), a risk ("might get blocked"), a plan, or a task that blocks something else ("this blocks the release") changes nothing. A blocked task keeps its status.

Leave anything the message doesn't clearly ask for empty. Most messages change nothing.`;

// Asks the model what `message` changes on `task`, and returns the checked
// changes (see checkChanges), or null if it changes nothing. Throws when the
// model can't be reached or answers with something that isn't JSON, so
// whoever asked can fall back. `today` is { date: "YYYY-MM-DD", weekday }.
export async function readChanges(env: AppEnv, { message, task, today, allowed, pullRequests = [] }: Read) {
  const model = aiModel(env)!;
  const input = {
    today: `${today.weekday} ${today.date}`,
    // Small models get weekdays wrong when they work them out.
    comingDays: comingDays(today.date),
    // "next Friday" is the Friday a week after the coming one.
    nextWeekDays: nextWeekDays(today.date),
    author: message.user,
    // The roles the author already holds on the task, so "lgtm" or "QA passed" can be weighed by who says it.
    authorRoles: Object.entries(task.people ?? {})
      .filter(([, ids]) => Array.isArray(ids) && ids.includes(message.user))
      .map(([role]) => role),
    mentioned: message.mentions,
    task: {
      title: task.title,
      status: task.status,
      // The only statuses it can move to: forward from the current one.
      nextStatuses: inParts(task) ? laterStatuses(task.status).filter((status) => partsMayMoveTo(task, status)) : laterStatuses(task.status),
      hasSubtasks: inParts(task),
      priority: task.priority,
      dueDate: task.dueDate || "none",
      blocked: Boolean(task.blocked),
      blockedReason: task.blockedReason || "",
      people: task.people,
    },
    pullRequests: { inMessage: pullRequests, linked: task.prs ?? [] },
    message: message.text,
  };
  const started = Date.now();
  const result = await withTimeout(
    env.AI.run(model as keyof AiModels, {
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "task_changes", schema: SCHEMA } },
      max_tokens: 400,
      temperature: 0,
      ...(NO_THINKING.includes(model) && { chat_template_kwargs: { enable_thinking: false } }),
    }),
  );
  const raw = answerOf(result);
  console.log("AI read a message", { model, ms: Date.now() - started });
  return checkChanges(raw, { task, message, allowed: { ...allowed, author: SPEAKS_FOR_SELF.test(message.text) }, pullRequests });
}

// The next seven days after `date` (YYYY-MM-DD), as { Wednesday: "2026-10-28", … }.
export function comingDays(date: string) {
  const day = new Date(`${date}T00:00:00Z`);
  return Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => {
      const next = new Date(day.getTime() + (i + 1) * 86400000);
      return [new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long" }).format(next), next.toISOString().slice(0, 10)];
    }),
  );
}

// "next Friday", etc: the coming days a week later, as { "next Wednesday": "2026-11-04", …}, plus
// "in a week" and "in two weeks".
export function nextWeekDays(date: string) {
  const shift = (iso: string, days: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
  return {
    ...Object.fromEntries(Object.entries(comingDays(date)).map(([day, iso]) => [`next ${day}`, shift(iso, 7)])),
    "in a week": shift(date, 7),
    "in two weeks": shift(date, 14),
  };
}

function withTimeout<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer from the model in ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

// What the model answers, as SCHEMA asks; none of it is trusted until checkChanges has checked it,
// so every field is unknown.
type Proposed = { add?: unknown; remove?: unknown };
type ModelAnswer = Partial<Record<Role, Proposed>> & {
  prs?: Proposed;
  status?: unknown;
  priority?: unknown;
  dueDate?: unknown;
  blocked?: unknown;
  blockedReason?: unknown;
};

// The JSON the model answered with. Models answer in one of two shapes,
// { response } or OpenAI's { choices }, as an object or as text.
function answerOf(result: unknown): ModelAnswer | null {
  const reply = result as { choices?: { message?: { content?: unknown } }[]; response?: unknown } | null | undefined;
  const answer = reply?.choices?.[0]?.message?.content ?? reply?.response;
  if (answer && typeof answer === "object") return answer;
  const text = String(answer ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The model didn't answer with JSON");
  return JSON.parse(text.slice(start, end + 1));
}

// The changes the model proposed that are real changes, as
//   { people: { [role]: { add, remove } }, status, priority, dueDate }
// with only the fields that change, or null if nothing does:
//   - people added must be mentioned in the message or its author, and not
//     have the role already; people removed must have it;
//   - statuses and priorities must be known ones, and differ from the task's;
//   - a due date must be a real date (YYYY-MM-DD, or "clear"), and differ.
// `allowed` says which kinds may change: { roles, status, details }, and
// `roles` which roles; and `author`, false when the author may not be added.
export function checkChanges(raw: ModelAnswer | null | undefined, { task, message, allowed, pullRequests = [] }: Omit<Read, "today">): Changes | null {
  const changes: Changes = {};
  if (allowed.prs) {
    // Only addresses code found in the message can be linked, and only those on the task unlinked.
    const linked = task.prs ?? [];
    const remove = unique(raw?.prs?.remove).filter((url) => linked.includes(url));
    const add = unique(raw?.prs?.add).filter((url) => pullRequests.includes(url) && !linked.includes(url) && !remove.includes(url));
    if (add.length || remove.length) changes.prs = { add, remove };
  }
  const candidates = new Set([...(allowed.author === false ? [] : [message.user]), ...message.mentions]);
  for (const role of allowed.roles ?? []) {
    const current = task.people[role] ?? [];
    const add = unique(raw?.[role]?.add).filter((id) => candidates.has(id) && !current.includes(id));
    const remove = unique(raw?.[role]?.remove).filter((id) => current.includes(id) && !add.includes(id));
    if (add.length || remove.length) (changes.people ??= {})[role] = { add, remove };
  }
  const status = raw?.status;
  if (allowed.status && isForward(task.status, status) && statusFits(status, task, message.text ?? "")) changes.status = status;
  if (allowed.blocked && !/\?\s*$/.test(message.text ?? "")) {
    if (raw?.blocked === "block" && !task.blocked) changes.blocked = { on: true, reason: cleanReason(raw.blockedReason) };
    if (raw?.blocked === "unblock" && task.blocked) changes.blocked = { on: false };
  }
  const priority = raw?.priority;
  // A subtask's priority is its task's, so none is suggested for it.
  if (allowed.details && !task.parent && isPriority(priority) && priority !== task.priority) changes.priority = priority;
  if (allowed.details) {
    const dueDate = raw?.dueDate === "clear" ? "" : isoToDueDate(raw?.dueDate);
    if (dueDate !== null && dueDate !== (task.dueDate ?? "")) changes.dueDate = dueDate;
  }
  return Object.keys(changes).length ? changes : null;
}

// Words that say only a part of the task has moved on ("the login part is done", "subtask 2 is
// in testing", "backend merged"). The model is told so, and a status it still proposes for such a
// message is dropped here.
const PARTIAL =
  /\b(sub-?tasks?|sub-?items?|parts?|partly|partial(ly)?|pieces?|phases?|steps?|stages?|milestones?|(some|one|two|three|half|rest|remaining|other) of (it|them|the)|first (bit|half|one)|second (bit|half|one)|front-?end|back-?end|the (api|ui|db|database) (is|are|was|were)|bits?)\b/i;

// Words that say the whole task is finished ("we can close this", "all subtasks are done").
const WHOLE = /\b(clos(e|ed|ing)|all|every(thing|one)?|entire(ly)?|whole|complete(d|ly)?|finished|done)\b/i;
// "all the subtasks" and the like name every part, so they aren't PARTIAL.
const EVERY_PART = /\b(all|every|each|both)\s+(of\s+)?(the\s+)?(sub-?tasks?|sub-?items?|parts?|pieces?|phases?|steps?|stages?|milestones?)\b/gi;

// Whether a message about parts may move a task done in parts to `status`: to DONE, and from TODO to
// IN_PROGRESS, as work on any part means the task has begun.
function partsMayMoveTo(task: Pick<Task, "status">, status: string) {
  return status === "DONE" || (status === "IN_PROGRESS" && task.status === "TODO");
}

// Whether a status the model proposed fits the message. A message about only a part never moves a
// task, except to start one done in parts. That moves to DONE only when the message speaks of the
// whole, and from TODO to IN_PROGRESS on any work begun.
export function statusFits(status: string, task: Pick<Task, "status" | "subtasks" | "subtaskCounts">, text: string) {
  if (!inParts(task)) return !PARTIAL.test(text);
  if (!partsMayMoveTo(task, status)) return false;
  if (status === "IN_PROGRESS") return true;
  return WHOLE.test(text) && !PARTIAL.test(text.replace(EVERY_PART, "all"));
}

// The statuses in the order work moves through them (the order of STATUSES).
const FLOW = Object.keys(STATUSES) as Status[];

// The statuses after `from`, in order: the only ones a message may move a task to.
export function laterStatuses(from: Status) {
  const at = FLOW.indexOf(from);
  return at < 0 ? [] : FLOW.slice(at + 1);
}

// Whether `to` is a known status later than `from`. A task never goes back from a message:
// moving it back is a deliberate act (`@Cade status`, or Edit on the card).
function isForward(from: Status, to: unknown): to is Status {
  return laterStatuses(from).some((status) => status === to);
}

// Whether `value` is one of the priorities.
function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && Object.hasOwn(PRIORITIES, value);
}

function unique(ids: unknown): string[] {
  return Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === "string"))] : [];
}

// YYYY-MM-DD as DD/MM/YYYY, or null when it isn't a real date.
function isoToDueDate(value: unknown) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === "string" ? value : "");
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCDate() !== Number(day) || date.getUTCMonth() !== Number(month) - 1) return null;
  return `${day}/${month}/${year}`;
}

// Today in TIMEZONE, as { date: "YYYY-MM-DD", weekday: "Monday" }, for dates
// like "Friday" or "tomorrow".
export function today(env: Pick<AppEnv, "TIMEZONE">, now = new Date()) {
  const timeZone = env.TIMEZONE || "UTC";
  return {
    date: new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now),
    weekday: new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(now),
  };
}
