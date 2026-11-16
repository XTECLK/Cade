// Reading tasks for the MCP tools: get_task, get_tasks and get_projects.
import { readableName } from "../access.ts";
import { projects } from "../channels.ts";
import { OPEN, byUrgency, threadLink, type TaskEntry } from "../task-list.ts";
import { subtasksOf, tasksWithStatuses, threadMessages } from "../db.ts";
import { DEFAULT_TASKS, EXTRA_FIELDS, MAX_TASKS, TASK_FIELDS, TASK_VIEW_FIELDS } from "../mcp-tools.ts";
import { callSlack } from "../slack.ts";
import { ROLES, STATUSES, kindName, loadTask, parsePullRequest, statusName, shownPeople, prState } from "../tasks.ts";
import type { GetProjectsArgs, GetTaskArgs, GetTasksArgs } from "../mcp-args.ts";
import type { AppEnv } from "../env.ts";
import type { Role, Status, Task } from "../types.ts";
import { ToolError, taskRef, projectChannel, requireActiveUsers } from "./common.ts";
import { threadOut, sourceThreadOf } from "./threads.ts";

// A task in a list, before it has its link (see taskLines).
type ListedTask = Omit<TaskEntry, "link">;

// A task as data, `link` being its link for the tools to give, with its parent, if it is a subtask. A
// subtask with no owner of its own has its parent's (see shownPeople).
function taskData(env: AppEnv, channel: string, ts: string, task: Task, link: string) {
  const name = projects(env).find((pair) => pair.channel === channel)?.name ?? channel;
  const people = shownPeople(task);
  return {
    task_id: `${channel}:${ts}`,
    title: task.title,
    project: name,
    channel_id: channel,
    status: task.status,
    priority: task.priority,
    due_date: task.dueDate || "",
    incident: Boolean(task.incident),
    bug: Boolean(task.bug),
    blocked: Boolean(task.blocked),
    blocked_reason: task.blockedReason || "",
    link,
    owner: people.owner,
    reviewer: people.reviewer,
    tester: people.tester,
    parent: task.parent
      ? { task_id: `${channel}:${task.parent.ts}`, title: task.parent.title, link: task.parent.link ?? "" }
      : null,
  };
}

// A subtask's line naming its parent, for a tool's text, or none for a task that isn't one.
const parentLines = (parent: ReturnType<typeof taskData>["parent"], indent: string) =>
  parent ? [`${indent}Subtask of "${parent.title}" (task ID ${parent.task_id}).`] : [];

// A task's pull requests with where each stands on GitHub (see github.ts), as data.
function prData(task: Task) {
  const prs = task.prs!.map((url) => {
    const pr = parsePullRequest(url);
    return { url, label: pr ? `${pr.repo}/${pr.number}` : url, state: prState(task, url) };
  });
  return { prs };
}

// One task: its details, without its threads or summary, or only the `fields` asked for. Nothing is
// asked of Slack.
export async function getTaskView(env: AppEnv, user: string, args: GetTaskArgs) {
  const { channel, ts } = taskRef(args);
  const { fields } = args;
  if (fields !== undefined && !(Array.isArray(fields) && fields.every((field) => TASK_VIEW_FIELDS.includes(field))))
    throw new ToolError(`fields is a list of: ${TASK_VIEW_FIELDS.join(", ")}.`);
  const task = await loadTask(env, channel, ts);
  if (!task)
    throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks, or the link to its message.");
  const where = await readableName(env, channel, user);
  if (where === null) throw new ToolError("You aren't in that task's project channel, so I can't read it for you.");
  // Only what is asked for is read.
  const want = (...names: NonNullable<GetTaskArgs["fields"]>) => !fields || names.some((name) => fields.includes(name));
  const [kept, subtasks] = await Promise.all([
    want("original_thread", "original_thread_state") ? threadMessages(env, channel, ts) : [],
    want("subtasks") ? subtasksOf(env, channel, ts) : [],
  ]);
  const original = sourceThreadOf(kept);
  const state = original ? "found" : kept.length ? "none" : "unknown";
  const all: Record<string, unknown> = {
    ...taskData(env, channel, ts, task, task.link ?? ""),
    subtasks: subtasks.map((sub) => ({
      task_id: `${channel}:${sub.ts}`,
      title: sub.task.title,
      link: sub.task.link ?? "",
      status: sub.task.status,
    })),
    created_by: task.createdBy ?? "",
    completed_at: task.completedAt ? task.completedAt.slice(0, 16).replace("T", " ") : "",
    original_thread_state: state,
    original_thread: threadOut(original),
    ...prData(task),
  };
  const data = fields ? Object.fromEntries(["task_id", ...fields].map((field: string) => [field, all[field]])) : all;

  const people = (Object.entries(ROLES) as [Role, string][])
    .map(([key, label]) => `${label.toLowerCase()}: ${task.people[key].join(", ") || "—"}`)
    .join("; ");
  const lines = [`Task "${task.title}" in #${where}`, `Task ID: ${channel}:${ts}`];
  if (want("status", "priority", "due_date", "incident", "bug")) {
    const kind = kindName(task).toLowerCase();
    lines.push(
      `Status: ${statusName(task.status)}  ·  Priority: ${task.priority}${kind ? ` (${kind})` : ""}  ·  Due: ${task.dueDate || "—"}`,
    );
  }
  if (want("owner", "reviewer", "tester", "created_by"))
    lines.push(`People: ${people}; raised by ${task.createdBy ?? "unknown"}`);
  if (want("link")) lines.push(`Links: ${task.link ? `thread ${task.link}` : "—"}`);
  if (want("prs")) {
    const { prs } = prData(task);
    lines.push(
      "",
      "Pull requests:",
      ...(prs.length ? prs.map((pr) => `- ${pr.label} (${pr.state.toLowerCase()}): ${pr.url}`) : ["(none linked)"]),
    );
  }
  if (want("original_thread", "original_thread_state")) {
    lines.push(
      "",
      original
        ? `Original thread (where the problem was first raised): thread ID ${original.channel}:${original.ts}, ${original.link}. Read it with get_thread_history.`
        : kept.length
          ? "Original thread: none, the task wasn't made from another thread."
          : "Original thread: unknown, no messages are kept for the task yet. Someone can send /cade resync with the task's link.",
    );
  }
  if (want("parent") && task.parent)
    lines.push("", ...parentLines(all.parent as ReturnType<typeof taskData>["parent"], ""));
  if (want("subtasks") && subtasks.length) {
    lines.push(
      "",
      "Subtasks (each has its own thread; read it with get_task_history):",
      ...subtasks.map((sub) =>
        `- ${sub.task.title} — ${statusName(sub.task.status)} (task ID ${channel}:${sub.ts}) ${sub.task.link ?? ""}`.trimEnd(),
      ),
    );
  }
  if (!fields)
    lines.push("Task thread (what was done about it): read it with get_task_history. Its summary: get_task_summary.");
  return { text: lines.join("\n"), data };
}

// The projects whose channel `user` is in, one per line.
export async function getProjects(env: AppEnv, user: string, _args: GetProjectsArgs) {
  const seen: { name: string; channel_id: string }[] = [];
  for (const project of projects(env)) {
    if ((await readableName(env, project.channel, user)) !== null)
      seen.push({ name: project.name, channel_id: project.channel });
  }
  const lines = seen.map((project) => `- ${project.name}: <#${project.channel_id}> (${project.channel_id})`);
  const text = lines.length
    ? [`${lines.length} project${lines.length === 1 ? "" : "s"}:`, ...lines].join("\n")
    : "There are no projects whose channel you're in.";
  return { text, data: { total: seen.length, projects: seen } };
}

// get_tasks' arguments, with what it works out from them for getAllTasks: the project's channel, which
// tasks done in the days asked count, whether those not done come first, and whose tasks they are.
type ListArgs = GetTasksArgs & {
  channel?: string;
  completed?: (task: Task) => boolean;
  openFirst?: boolean;
  assigned?: (task: Task) => boolean;
};

// The tasks the arguments ask for, of those in the channels the person can read.
export async function getTasks(env: AppEnv, user: string, args: ListArgs) {
  const { assignees, roles, unassigned, limit, project, fields } = args;
  if (fields !== undefined && !(Array.isArray(fields) && fields.every((field) => TASK_FIELDS.includes(field))))
    throw new ToolError(`fields is a list of: ${TASK_FIELDS.join(", ")}.`);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_TASKS))
    throw new ToolError(`limit is a whole number from 1 to ${MAX_TASKS}.`);
  if (roles !== undefined && assignees === undefined)
    throw new ToolError('roles goes with assignees, the people to have them. Give assignees: ["me"] for your own.');
  if (unassigned && assignees !== undefined) throw new ToolError("unassigned can't be combined with assignees.");
  if (assignees !== undefined) {
    // "me" is whoever's API key it is; anyone else has to be someone in the workspace.
    const ids = new Set(assignees.map((id) => (id === "me" ? user : id)));
    await requireActiveUsers(
      env,
      [...ids].filter((id) => id !== user),
    );
    const wanted = (roles ?? Object.keys(ROLES)) as Role[];
    args = {
      ...args,
      assigned: (task: Task) => wanted.some((role) => shownPeople(task)[role].some((id) => ids.has(id))),
    };
  }
  if (project !== undefined) args = { ...args, channel: projectChannel(env, project) };
  if (args.completed_from !== undefined || args.completed_to !== undefined) {
    const day = (value: unknown, name: string) => (value === undefined ? undefined : dayOf(value, name));
    const [first, last] = [day(args.completed_from, "completed_from"), day(args.completed_to, "completed_to")];
    const inRange = ({ completedAt }: Task) =>
      Boolean(completedAt) &&
      (!first || completedAt!.slice(0, 10) >= first) &&
      (!last || completedAt!.slice(0, 10) <= last);
    if (args.include_open) {
      if (args.status !== undefined && args.status !== "all")
        throw new ToolError(
          "include_open can't be combined with status. It gives the tasks not done, and those done in the days.",
        );
      // Open tasks as well as those done in the days; the open ones come first.
      args = {
        ...args,
        status: "all",
        completed: (task: Task) => OPEN.includes(task.status) || inRange(task),
        openFirst: true,
      };
    } else {
      args = { ...args, status: args.status ?? "DONE", completed: inRange };
    }
  } else if (args.include_open) {
    throw new ToolError(
      "include_open goes with completed_from or completed_to. Without them, open tasks are listed anyway.",
    );
  }
  return getAllTasks(env, user, args);
}

// Orders tasks not done before those done (the sort is stable, so urgency holds within each).
const byOpenFirst = (a: { task: Task }, b: { task: Task }) =>
  Number(!OPEN.includes(a.task.status)) - Number(!OPEN.includes(b.task.status));

// The tasks in the projects whose channels you can read, most urgent first: everyone's, or those
// `assigned` picks.
async function getAllTasks(
  env: AppEnv,
  user: string,
  { limit, status, assigned, unassigned, bug, channel, fields, completed, openFirst }: ListArgs,
) {
  const { wanted, statuses } = statusFilter(status);
  const max = limit ?? DEFAULT_TASKS;
  const everyone = (task: Task) => (Object.keys(ROLES) as Role[]).flatMap((role) => task.people[role]);
  const found = (await tasksWithStatuses(env, statuses))
    .filter((entry) => !channel || entry.channel === channel)
    .filter(({ task }) => !completed || completed(task))
    .filter(({ task }) => bug === undefined || Boolean(task.bug) === bug)
    // Only a task is unassigned, not a subtask: whoever takes the task takes its parts.
    .filter(({ task }) => (!assigned || assigned(task)) && (!unassigned || (!task.parent && !everyone(task).length)))
    .map(({ channel, ts, task }) => ({ channel, ts, task, incident: task.incident }))
    .sort(byUrgency)
    .sort(openFirst ? byOpenFirst : () => 0);

  // A channel's tasks are for those who can read it, so each is asked about once, as the tasks come.
  const readable = new Map<string, boolean>();
  const shown: typeof found = [];
  let allowed = 0;
  for (const entry of found) {
    if (!readable.has(entry.channel))
      readable.set(entry.channel, (await readableName(env, entry.channel, user)) !== null);
    if (!readable.get(entry.channel)) continue;
    allowed++;
    if (shown.length < max) shown.push(entry);
  }
  if (!allowed)
    return {
      text: `There are no ${wanted === "open" ? "open " : ""}tasks you can see${statuses.length === 1 ? ` in ${statusName(wanted as Status)}` : ""}.`,
      data: { total: 0, tasks: [] },
    };
  const people = ({ task }: ListedTask) =>
    (Object.entries(ROLES) as [Role, string][])
      .map(([key, label]) => `${label.toLowerCase()}: ${task.people[key].join(", ") || "—"}`)
      .join("; ");
  const more =
    allowed > shown.length
      ? `\n…and ${allowed - shown.length} more; raise limit (up to ${MAX_TASKS}) or filter by status to see them.`
      : "";
  const { lines, items } = await taskLines(env, shown, people, fields);
  return {
    text:
      [`${allowed} task${allowed === 1 ? "" : "s"}, showing the ${shown.length} most urgent:`, ...lines].join("\n") +
      more,
    data: { total: allowed, tasks: items },
  };
}

// A status argument as { wanted, statuses }: open (the default), all, or one status.
function statusFilter(status: unknown): { wanted: string; statuses: Status[] } {
  const wanted = (status ?? "open") as string;
  if (!["open", "all"].includes(wanted) && !STATUSES[wanted as Status])
    throw new ToolError(`status is open, all or one of ${Object.keys(STATUSES).join(", ")}.`);
  return {
    wanted,
    statuses: wanted === "open" ? OPEN : wanted === "all" ? (Object.keys(STATUSES) as Status[]) : [wanted as Status],
  };
}

// The entries as sections, one per project (in PROJECTS order, then any other channel), each a
// "*Project*" line over its tasks: a numbered entry each (numbers run on across sections) with
// its priority, title, status and due date, `about(entry)`, its ID and its link. Gives
// { lines, items }: the text, and the tasks as data in the same order.
async function taskLines(
  env: AppEnv,
  entries: ListedTask[],
  about: (entry: ListedTask) => string,
  fields: string[] | undefined,
) {
  // A task made before its link was kept gets one built from the workspace's address.
  let base: string | undefined;
  const named = projects(env);
  const order = (channel: string) => {
    const at = named.findIndex((pair) => pair.channel === channel);
    return at < 0 ? named.length : at;
  };
  const sorted = entries
    .map((entry, i) => ({ entry, i }))
    .sort((x, y) => order(x.entry.channel) - order(y.entry.channel) || x.i - y.i);
  const lines: string[] = [];
  const items: Record<string, unknown>[] = [];
  let section: string | undefined;
  for (const [n, { entry }] of sorted.entries()) {
    const { channel, ts, task } = entry;
    if (section !== channel) {
      section = channel;
      lines.push(`*${named.find((pair) => pair.channel === channel)?.name ?? channel}*`);
    }
    if (!task.link && base === undefined)
      base = (await callSlack(env, "auth.test", {}).catch(() => ({}) as { url?: string })).url ?? "";
    const link = task.link || (base ? threadLink(base, channel, ts) : `${channel}/${ts}`);
    const due = task.dueDate ? `, due ${task.dueDate}` : "";
    lines.push(
      `${n + 1}. [${task.priority}]${kindName(task) ? ` [${kindName(task)}]` : ""} ${task.title} — ${statusName(task.status)}${due} (${about(entry)})\n   Task ID: ${channel}:${ts}\n   ${link}`,
    );
    const all: Record<string, unknown> = {
      ...taskData(env, channel, ts, task, link),
      created_by: task.createdBy ?? "",
      prs: fields?.includes("prs") ? prData(task).prs : [],
      completed_at: task.completedAt ? task.completedAt.slice(0, 16).replace("T", " ") : "",
    };
    // Only the fields asked for, or the base ones.
    const item = fields
      ? Object.fromEntries(["task_id", ...fields].map((field) => [field, all[field]]))
      : Object.fromEntries(Object.entries(all).filter(([field]) => !(field in EXTRA_FIELDS)));
    items.push(item);
    // The list is flat: a subtask is listed as any task is, naming its parent.
    if (!fields || fields.includes("parent"))
      lines.push(...parentLines(all.parent as ReturnType<typeof taskData>["parent"], "   "));
  }
  return { lines, items };
}

// A day argument (YYYY-MM-DD) as given, or a ToolError.
function dayOf(value: unknown, name: string) {
  const text = String(value).trim();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ||
    new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text
  ) {
    throw new ToolError(`${name} is a day written YYYY-MM-DD, such as 2026-11-06.`);
  }
  return text;
}
