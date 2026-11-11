import { projects, groupEnabled } from "./channels.ts";
import { getTask, putTask, subtasksOf } from "./db.ts";
import { callSlack, escapeSlack, mrkdwn, plainText } from "./slack.ts";
import type { AppEnv } from "./env.ts";
import type { Project } from "./channels.ts";
import type { MessageBody, Parent, People, Priority, Role, SlackBlock, SlackPayload, Status, Task, ViewValues } from "./types.ts";

// Tasks are stored in D1 (see db.ts). The root message in the tasks channel
// is rendered from the stored task.

// Slack cannot colour text, so each value is shown with a coloured emoji
// in menus and lists. Task messages show the priority as the colour of the
// strip down their side instead, the same colours. Other
// values use emoji that aren't coloured circles, so they can't be taken
// for a priority.
export const PRIORITY_COLORS: Record<Priority, string> = {
  Urgent: "#E01E5A",
  High: "#F26A1B",
  Medium: "#F5D020",
  Low: "#2EB67D",
};

export const PRIORITIES: Record<Priority, string> = {
  Urgent: ":red_circle:",
  High: ":large_orange_circle:",
  Medium: ":large_yellow_circle:",
  Low: ":large_green_circle:",
};

export const STATUSES: Record<Status, string> = {
  TODO: ":memo: To do",
  IN_PROGRESS: ":arrow_forward: In progress",
  IN_REVIEW: ":eyes: In review",
  IN_TESTING: ":test_tube: In testing",
  CLIENT_REVIEW: ":raising_hand: Client review",
  DONE: ":white_check_mark: Done",
};

// Each task has a list of people per role; the keys are what people type in
// `@Cade assign owner @person`. The owner does the work, whatever it is.
export const ROLES: Record<Role, string> = {
  owner: "Owner",
  reviewer: "Reviewer",
  tester: "Tester",
};

// The roles as a task's card shows them, by who works on it.
const SHORT_ROLES: Record<Role, string> = { owner: "Owner", reviewer: "Review", tester: "Test" };

export const NOT_A_TASK = "Hmm, I'm not tracking a task in this thread.";

// An incident is a task reported with `/cade incident`. It is always urgent
// and fixed as soon as possible, so its priority and due date never change.
export const INCIDENT = { priority: "Urgent" as Priority, dueDate: "Immediate" };

// A subtask's priority is its task's, set there and followed (see followParent); its due date is its own.
export const SUBTASK_PRIORITY = "A subtask has its task's priority, so change it on the task. Its due date is its own.";

export const INCIDENT_IS_FIXED =
  "Incidents are always :red_circle: Urgent and due Immediate, so I can't change their priority or due date.";

// The task's pull requests that are pending: not sent for approval, nor
// approved.
export function unsentPrs(task: Pick<Task, "prs" | "releases">) {
  const sent = new Set((task.releases ?? []).flatMap((release) => release.prs));
  return task.prs!.filter((url) => !sent.has(url));
}

// The task's PRs for its card, a line each for those
// approved, pending approval and pending, leaving out the empty ones:
//   Approved: Login (cade/42, web/7) · Profile page (web/9)
//   Pending approval: Search (web/11)
//   Pending: web/12, web/13
// A PR goes from pending to pending approval, once sent with `@Cade
// release` (see release.ts) and recorded in the task's `releases`, to
// approved by the client. Releases are named by what they complete; the
// labels say where each PR is, so PRs have no emoji. Once the task is Done,
// all of them are approved, with the PRs never sent as the rest of the
// task.
export function prLines(task: Task) {
  const done = task.status === "DONE";
  const releases = task.releases ?? [];
  const group = (prs: string[], note: string) => `${escapeSlack(note.replace(/\s+/g, " "))} (${prs.map(prLink).join(", ")})`;
  const groups = (status: string) =>
    releases.filter((release) => done || release.status === status).map((release) => group(release.prs, release.note));
  const approved = groups("APPROVED");
  const unsent = unsentPrs(task);
  if (done && unsent.length) approved.push(group(unsent, releases.length ? "The rest of the task" : "The task"));
  const awaiting = done ? [] : groups("PENDING_APPROVAL");
  const pending = done ? [] : unsent;
  return [
    approved.length && `*Approved:* ${approved.join("  ·  ")}`,
    awaiting.length && `*Pending approval:* ${awaiting.join("  ·  ")}`,
    pending.length && `*Pending:* ${pending.map(prLink).join(", ")}`,
  ].filter(Boolean);
}

// Other words for each role, besides its name: `@Cade assign dev @rex`, as
// owners were called developers before.
const ROLE_WORDS: Record<string, Role> = { dev: "owner", developer: "owner", review: "reviewer", rev: "reviewer", test: "tester", qa: "tester" };

// Returns the first role named in `text` ("owners", "dev" and "qa" work
// too), or null.
export function parseRole(text: string): Role | null {
  const words = text.toLowerCase().split(/\s+/).filter((word) => !word.startsWith("<@"));
  return (
    (words
      .map((word) => word.replace(/s$/, ""))
      .map((word) => ROLE_WORDS[word] ?? word)
      .find((word) => ROLES[word as Role]) as Role | undefined) ?? null
  );
}

export function noPeople(): People {
  return { owner: [], reviewer: [], tester: [] };
}

// Who has each role on the task, as "Owner @a  ·  Review @b", leaving out
// roles with no one; empty if no one has any. `viewer`, if given, is
// written as "you".
// Who works on the task as it is shown: a subtask with no owner of its own is its parent's owners', as
// whoever owns the task owns its parts unless someone else is given one. Only shown so, not stored, so
// it follows the parent's owners as they change.
export function shownPeople(task: Pick<Task, "people" | "parent">): People {
  const inherited = task.parent?.owner ?? [];
  return task.people.owner.length || !inherited.length ? task.people : { ...task.people, owner: inherited };
}

export function peopleLine(task: Pick<Task, "people">, viewer?: string) {
  return (Object.entries(SHORT_ROLES) as [Role, string][])
    .filter(([role]) => task.people[role].length)
    .map(([role, label]) => `${label} ${task.people[role].map((id) => (id === viewer ? "you" : `<@${id}>`)).join(", ")}`)
    .join("  ·  ");
}

export function taskMessage(task: Task, { archivedBy }: { archivedBy?: string | null } = {}): MessageBody {
  // The title, led by its priority, then in small text a link to its notes
  // page (once it has one) and to its thread's export, its status and due date, its linked pull
  // requests (when it has any) by whether they're approved, and who works on
  // it and who tracked it. Under the title, its Edit button and ⋯ menu; the rest sits in an
  // attachment, whose strip down the side has the priority's colour. Roles
  // with no one are left out. An archived task's card says who archived it
  // in place of its status, and has no buttons, as Cade no longer tracks it.
  const people = peopleLine({ people: shownPeople(task) });
  // The links under the title, on one line: to its notes page and to its thread's
  // export (see export.ts).
  const links = [
    task.notes && `Extra notes <${task.notes.url}|here>`,
    task.export && `Full history <${task.export.url}|here>`,
  ].filter(Boolean);
  // A subtask's card says whose it is first; a task's says how its subtasks stand, under its status.
  const subtasks = subtasksLine(task);
  // Three blocks, each a few lines: whose subtask it is and its pages; the work (its status, subtasks,
  // pull requests and people); and who tracked it. Lines in a block sit closer than the blocks do, so
  // the card reads in those three parts. A block with nothing in it is left out.
  const status = metaLine(archivedBy ? `:file_cabinet: Archived by <@${archivedBy}>` : STATUSES[task.status], task.dueDate, !archivedBy && blockedLine(task)).text;
  const card: SlackBlock[] = [
    [task.parent && parentLine(task.parent), links.length && links.join("  ·  ")],
    [status, subtasks, ...(task.prs?.length ? prLines(task) : []), people || "_Unassigned_"],
    [`${task.incident ? "Reported" : "Tracked"} by <@${task.createdBy}>${task.viaAgent ? " · *Sent using* AI agent" : ""}`],
  ]
    .map((lines) => lines.filter(Boolean))
    .filter((lines) => lines.length)
    .map(smallText);
  // Incidents share the dev channel with the rest of the work, so their
  // cards say which they are.
  const label = `[${task.priority.toUpperCase()}] ${task.incident ? "[Incident] " : ""}`;
  return {
    text: `${task.priority} ${task.incident ? "incident" : "task"}: ${task.title}`,
    blocks: [{ type: "section", text: mrkdwn(`${label}*${escapeSlack(task.title)}*`) }, ...(archivedBy ? [] : [taskActions(task)])],
    attachments: [{ color: PRIORITY_COLORS[task.priority], blocks: card }],
  };
}

// A subtask's line naming the task it belongs to, linking to it once it has a link.
export function parentLine(parent: Parent) {
  const title = escapeSlack(parent.title);
  return `:arrow_right_hook: Subtask of ${parent.link ? `<${parent.link}|${title}>` : `*${title}*`}`;
}

// What a main task's thread hears when `user` adds the subtask `task`, made or linked, naming it.
export function subtaskAdded(user: string, task: Pick<Task, "title" | "link">) {
  const title = escapeSlack(task.title);
  return `<@${user}> added a subtask: ${task.link ? `<${task.link}|${title}>` : `*${title}*`}. It's tracked in its own thread.`;
}

// How many subtasks are open (not Done) and closed, or "" for a task with none.
export function subtasksLine(task: Pick<Task, "subtaskCounts">) {
  const { open = 0, closed = 0 } = task.subtaskCounts ?? {};
  return open + closed ? `Subtasks: ${open} open  ·  ${closed} closed` : "";
}

// Whether the task is done in parts, so a message about one part mustn't move it: it has subtasks of
// its own, open or closed.
export function inParts(task: Pick<Task, "subtaskCounts">) {
  const { open = 0, closed = 0 } = task.subtaskCounts ?? {};
  return open + closed > 0;
}

// The statuses that speak of the whole task, which it reaches only once all its subtasks are done: the
// client checks it, or it is finished.
export const AFTER_SUBTASKS: Status[] = ["CLIENT_REVIEW", "DONE"];

// Whether moving the task to `status` waits for its subtasks: it has some still open.
export function waitsForSubtasks(task: Pick<Task, "subtaskCounts">, status: Status) {
  return AFTER_SUBTASKS.includes(status) && (task.subtaskCounts?.open ?? 0) > 0;
}

// The buttons on a task's card, so people change it without typing a command in its thread (see
// menu.ts). A section holds only one, so they sit in a row of their own under the title: Edit, one
// form for everything and the change made most, as a button; then the ⋯ menu with the rest: Add
// subtask, on a task that isn't a subtask itself (they go one level deep); View subtasks, once it has
// any; Release, while it has PRs not sent for approval; and Archive, when it's no longer needed (see
// archive.ts).
export const TASK_EDIT_ACTION = "task:edit";
export const TASK_MENU_ACTION = "task:menu";

function taskActions(task: Task) {
  return { type: "actions", elements: [{ type: "button", action_id: TASK_EDIT_ACTION, text: plainText("Edit") }, taskMenu(task)] };
}

// The ⋯ menu: Archive is always there, so it is never empty.
function taskMenu(task: Task) {
  const choices = [
    !task.parent && ["subtask", "Add subtask"],
    subtasksLine(task) && ["subtasks", "View subtasks"],
    task.prs?.length && unsentPrs(task).length && ["release", "Release"],
    ["archive", "Archive"],
  ].filter(Boolean) as [string, string][];
  return {
    type: "overflow",
    action_id: TASK_MENU_ACTION,
    options: choices.map(([value, text]) => ({ text: plainText(text), value })),
  };
}

// Lines of a card in small text, as its status line is. A context element
// holds up to 3,000 characters.
export function smallText(lines: (string | false | null | undefined | 0)[]) {
  return { type: "context", elements: [mrkdwn(lines.join("\n").slice(0, 3000))] };
}

// A card's line under its title, in small text: the status, whether it is blocked, and the due date,
// leaving out those not set.
export function metaLine(status: string, dueDate?: string | null, blocked?: string | false | null) {
  return mrkdwn([status, blocked, dueDate && `Due ${dueDate}`].filter(Boolean).join("  ·  "));
}

// Longest blocked reason kept, so a long message doesn't fill a card.
export const MAX_BLOCKED_REASON = 100;

// The marker on a blocked task's card, with its reason when it has one, or "" when it isn't blocked.
export function blockedLine(task: Pick<Task, "blocked" | "blockedReason">) {
  if (!task.blocked) return "";
  return `:no_entry: *Blocked*${task.blockedReason ? `: ${escapeSlack(task.blockedReason)}` : ""}`;
}

// A blocked reason as kept: one line, trimmed, cut to MAX_BLOCKED_REASON.
export function cleanReason(reason: unknown) {
  const line = String(reason ?? "").replace(/\s+/g, " ").trim();
  return line.length > MAX_BLOCKED_REASON ? `${line.slice(0, MAX_BLOCKED_REASON - 1)}…` : line;
}


// Pull request addresses on GitHub, GitLab and Bitbucket: the repository's
// name and the request's number.
const PULL_REQUEST = /^https?:\/\/[^/\s]+\/(?:[^/\s]+\/)+?([^/\s]+)\/(?:pull|-\/merge_requests|pull-requests)\/(\d+)\b/;

// Returns { url, repo, number } for a pull request address, or null. `url`
// is the request's own address, without a tab such as /files after it.
export function parsePullRequest(url: string) {
  const match = PULL_REQUEST.exec(url);
  return match ? { url: match[0], repo: match[1]!, number: match[2]! } : null;
}

// A pull request as reponame/number, linking to it.
export function prLink(url: string) {
  const pr = parsePullRequest(url);
  return pr ? `<${url}|${escapeSlack(pr.repo)}/${pr.number}>` : `<${url}>`;
}

// Returns the task whose root message is `ts`, or null if it is not a task.
export async function loadTask(env: AppEnv, channel: string, ts: string) {
  return getTask(env, channel, ts);
}

// Stores the task, then renders it to its root message and the summaries. A subtask's parent's card
// counts it, so is redrawn too.
export async function saveTask(env: AppEnv, channel: string, ts: string, task: Task) {
  await putTask(env, channel, ts, task);
  console.log("Task saved", { ts, people: task.people });
  await callSlack(env, "chat.update", { channel, ts, ...taskMessage(task) });
  await redrawParent(env, channel, task);
  await followParent(env, channel, ts, task);
  await refreshSummary(env, channel);
}

// Brings the task's subtasks in line with it, as it may have just changed: each takes its priority
// (an incident's subtasks are incidents, whose priority never changes), saved, and the cards of those
// that changed, or that show its owners for want of their own (see shownPeople), are redrawn. A
// convenience, so a failure is only logged.
async function followParent(env: AppEnv, channel: string, ts: string, task: Task) {
  const { open = 0, closed = 0 } = task.subtaskCounts ?? {};
  if (task.parent || !(open + closed)) return;
  try {
    for (const sub of await subtasksOf(env, channel, ts)) {
      const behind = !sub.task.incident && sub.task.priority !== task.priority;
      if (behind) {
        sub.task.priority = task.priority;
        await putTask(env, channel, sub.ts, sub.task);
      }
      if (behind || !sub.task.people.owner.length) await callSlack(env, "chat.update", { channel, ts: sub.ts, ...taskMessage(sub.task) });
    }
  } catch (error) {
    console.warn("Could not bring the subtasks in line", { ts, error: error.message });
  }
}

// Redraws the card of the subtask `task`'s parent, whose count of open and closed subtasks it is in,
// after it was made, changed, archived or deleted. Not for a task that isn't a subtask, nor for a
// parent no longer tracked. The count is a convenience, so a failure is only logged.
export async function redrawParent(env: AppEnv, channel: string, task: Pick<Task, "parent">) {
  if (!task.parent) return;
  try {
    const parent = await getTask(env, channel, task.parent.ts);
    if (parent) await callSlack(env, "chat.update", { channel, ts: task.parent.ts, ...taskMessage(parent) });
  } catch (error) {
    console.warn("Could not redraw the parent task", { ts: task.parent.ts, error: error.message });
  }
}

// Rewrites the summary a change in `channel` touches (see summary.ts); with
// `create`, for a new task, making its canvas if it has none. It is
// imported when needed, as summary.ts uses this module's exports when it
// loads. Only a project with `summaryCanvas` on (SUMMARY_CANVAS for every project) has one.
export async function refreshSummary(env: AppEnv, channel: string, options?: { create?: boolean }) {
  if (!groupEnabled(env, channel, "summaryCanvas", "SUMMARY_CANVAS")) return;
  const summary = await import("./summary.ts");
  await summary.refreshSummary(env, channel, options);
}

// The status label without its emoji.
export function statusName(status: Status) {
  return STATUSES[status].replace(/^:[a-z0-9_+-]+:\s*/, "");
}

// The title, due date and priority fields of the task form. `initial` fills
// them in: { title, dueDate (DD/MM/YYYY), priority }. Without `details` the
// form asks only for the title, for an incident, whose are fixed.
export function taskFormBlocks(titleLabel: string, initial: { title?: string; dueDate?: string; priority?: string } = {}, { details = true } = {}): SlackBlock[] {
  const option = (priority: Priority) => ({
    text: { ...plainText(`${PRIORITIES[priority]} ${priority}`), emoji: true },
    value: priority,
  });
  const title = {
    type: "input",
    block_id: "title",
    label: plainText(titleLabel),
    element: {
      type: "plain_text_input",
      action_id: "value",
      max_length: 150,
      initial_value: initial.title?.slice(0, 150) || undefined,
    },
  };
  if (!details) return [title];
  return [
    title,
    {
      type: "input",
      block_id: "due_date",
      optional: true,
      label: plainText("Due date"),
      element: {
        type: "datepicker",
        action_id: "value",
        placeholder: plainText("Select a date"),
        initial_date: pickerDate(initial.dueDate),
      },
    },
    {
      type: "input",
      block_id: "priority",
      label: plainText("Priority"),
      element: {
        type: "static_select",
        action_id: "value",
        placeholder: plainText("Select a priority"),
        options: (Object.keys(PRIORITIES) as Priority[]).map(option),
        initial_option: PRIORITIES[initial.priority as Priority] ? option(initial.priority as Priority) : undefined,
      },
    },
  ];
}

// Reads the fields from taskFormBlocks. `errors` is keyed by block_id, as a
// modal's response_action "errors" expects, or null when there are none. A
// form without details gives no priority or due date.
export function readTaskForm(values: ViewValues, titleError: string) {
  const title = values.title!.value.value?.trim() ?? "";
  // The date picker gives YYYY-MM-DD, or null when no date was chosen.
  const dueDate = formatDueDate(values.due_date?.value.selected_date);
  const priority = values.priority?.value.selected_option?.value as Priority | undefined;

  const errors: Record<string, string> = {};
  if (!title) errors.title = titleError;
  if (values.priority && !PRIORITIES[priority!]) errors.priority = "Please pick a priority.";
  return { title, dueDate, priority, errors: Object.keys(errors).length ? errors : null };
}

// Turns DD/MM/YYYY back into the date picker's YYYY-MM-DD (undefined when
// there is none).
export function pickerDate(dueDate?: string | null) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dueDate ?? "");
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
}

// Turns the date picker's YYYY-MM-DD into DD/MM/YYYY ("" when there is none).
export function formatDueDate(selectedDate?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(selectedDate ?? "");
  if (!match) return "";
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

// The Project picker on forms opened outside a dev channel, such as from a
// message shortcut in a DM: each group by name, its value the group's dev
// channel. The only group is picked to begin with. With `actionId`,
// choosing one sends that action, for a form that changes with it.
export function projectBlock(env: AppEnv, { actionId, initial }: { actionId?: string; initial?: string | null } = {}) {
  const groups = projects(env);
  const option = (group: Project) => ({ text: plainText(group.name.slice(0, 75)), value: group.channel });
  const picked = groups.find((group) => group.channel === initial) ?? (groups.length === 1 ? groups[0] : null);
  return {
    type: "input",
    block_id: "project",
    label: plainText("Project"),
    ...(actionId && { dispatch_action: true }),
    element: {
      type: "static_select",
      action_id: actionId ?? "value",
      placeholder: plainText("Choose a project"),
      options: groups.map(option),
      ...(picked && { initial_option: option(picked) }),
    },
  };
}

// The dev channel of the project chosen on a form, or undefined.
export function chosenProject(values: ViewValues): string | undefined {
  return Object.values(values.project ?? {})[0]?.selected_option?.value;
}

// The approval forms' picker for who approves or rejects: the client, or
// whoever handles them.
export function approverBlock(initialUser?: string | null) {
  return {
    type: "input",
    block_id: "approver",
    label: plainText("Who approves"),
    element: {
      type: "users_select",
      action_id: "value",
      placeholder: plainText("Choose a person"),
      ...(initialUser && { initial_user: initialUser }),
    },
  };
}

export function readApprover(values: ViewValues) {
  return values.approver?.value?.selected_user ?? null;
}

// Whether `payload`'s Approve or Not approve click came from someone other
// than `approver`, who alone decides; they are told so, privately. Buttons
// from before an approver was picked have none, and anyone may click them.
export async function notTheApprover(env: AppEnv, payload: SlackPayload, approver: string | null | undefined) {
  if (!approver || payload.user.id === approver) return false;
  await callSlack(env, "chat.postEphemeral", {
    channel: payload.channel!.id,
    thread_ts: payload.message!.thread_ts,
    user: payload.user.id,
    text: `Only <@${approver}> can approve or reject this.`,
  });
  return true;
}
