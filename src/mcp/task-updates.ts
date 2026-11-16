// Changing tasks for the MCP tools: create_task and update_task.
import { readableName } from "../access.ts";
import { projects, type Project } from "../channels.ts";
import { applyChanges } from "../commands/changes.ts";
import { changeRequests } from "../notify.ts";
import { checkRoot } from "../commands/move.ts";
import { parseStatus, approvalRequest } from "../commands/status.ts";
import { createTask } from "../commands/track.ts";
import { OPEN } from "../commands/tasks.ts";
import { subtasksOf, tasksWithStatuses } from "../db.ts";
import { MAX_TITLE } from "../mcp-tools.ts";
import { INCIDENT, PRIORITIES, ROLES, STATUSES, kindName, loadTask, noPeople, parsePullRequest, statusName, prState, waitsForSubtasks } from "../tasks.ts";
import { newSubtask } from "../commands/subtask.ts";
import type { CreateTaskArgs, UpdateTaskArgs } from "../mcp-args.ts";
import type { AppEnv } from "../env.ts";
import type { Changes, Priority, Role, StoredTask, Task } from "../types.ts";
import { ToolError, threadOf, threadIdOf, readableChannel, taskRef, dueDateOf, userIds, requireActiveUsers } from "./common.ts";

// Makes a task, bug or incident for the person, from a thread or from scratch.
export async function createTaskTool(env: AppEnv, user: string, args: CreateTaskArgs) {
  const title = String(args.title ?? "").trim().replace(/\s+/g, " ");
  if (!title) throw new ToolError("The title is empty.");
  if (title.length > MAX_TITLE) throw new ToolError(`The title is ${title.length} characters; keep it to ${MAX_TITLE} or fewer.`);
  if (args.incident !== undefined && typeof args.incident !== "boolean") throw new ToolError("incident is true or false.");
  if (args.bug !== undefined && typeof args.bug !== "boolean") throw new ToolError("bug is true or false.");
  if (args.bug === true && args.incident === true) throw new ToolError("It is a bug or an incident, not both: an incident is something broken now, always Urgent; a bug is fixed as a task is.");
  // A subtask: in its parent's project, with its people, and its due date and priority unless given.
  let parent: { channel: string; ts: string; task: StoredTask } | undefined;
  if (args.parent_task_id !== undefined) {
    const { channel, ts } = taskRef({ task_id: args.parent_task_id });
    const found = await loadTask(env, channel, ts);
    if (!found) throw new ToolError("parent_task_id isn't a task Cade tracks. Use the task's ID from get_tasks.");
    if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't add a subtask to it for you.");
    if (found.parent) throw new ToolError(`That task is a subtask already, and subtasks don't have their own. Add it to its task instead: ${channel}:${found.parent.ts}.`);
    if (args.incident === true && !found.incident) throw new ToolError("A subtask of a task can't be an incident. Leave out incident; make an incident of its own instead, if it is one.");
    parent = { channel, ts, task: found };
  }
  const incident = args.incident === true || Boolean(parent?.task.incident);
  if (incident && args.bug === true) throw new ToolError("A subtask of an incident is an incident too, so it can't be a bug: leave out bug.");
  const bug = args.bug === true;
  const kind = incident ? "incident" : bug ? "bug" : "task";
  if (incident && (args.priority !== undefined || args.due_date !== undefined)) throw new ToolError(`${parent ? "A subtask of an incident is an incident too: it" : "An incident"} is always Urgent and due immediately, so leave out priority and due_date.`);
  if (args.priority !== undefined && !PRIORITIES[args.priority as Priority]) throw new ToolError(`priority is one of ${Object.keys(PRIORITIES).join(", ")}.`);
  if (parent && args.priority !== undefined) throw new ToolError("A subtask has its task's priority, so leave out priority. Its due date is its own.");
  const dueDate = args.due_date !== undefined ? dueDateOf(args.due_date) : "";

  // The thread to move into the task: one the person can read, that isn't a task or moved already.
  let source: { channel: string; ts: string } | undefined;
  if (args.thread_id !== undefined && args.link !== undefined) throw new ToolError("Give thread_id or link, not both.");
  if (args.thread_id !== undefined || args.link !== undefined) {
    source = args.thread_id !== undefined ? threadIdOf(args.thread_id) : threadOf(args.link);
    await readableChannel(env, user, source.channel);
    const { problem, moved } = await checkRoot(env, source.channel, source.ts);
    if (problem || moved) throw new ToolError(`I can't make a task from that thread: ${problem ?? moved}`);
  }

  // The project: named, or the one the thread is in, or the only one.
  const all = projects(env);
  let project: Project | undefined;
  if (parent) {
    project = all.find((candidate) => candidate.channel === parent!.channel);
    if (args.project !== undefined && project?.name.toLowerCase() !== String(args.project).trim().toLowerCase()) throw new ToolError(`A subtask goes in its task's project, ${project?.name ?? parent.channel}: leave out project.`);
  } else if (args.project !== undefined) project = all.find((candidate) => candidate.name.toLowerCase() === String(args.project).trim().toLowerCase());
  else project = (source && all.find((candidate) => candidate.channel === source!.channel)) || (all.length === 1 ? all[0] : undefined);
  if (!project) {
    throw new ToolError(args.project !== undefined ? `There is no project called "${args.project}". They are: ${all.map((candidate) => candidate.name).join(", ")}.` : `Say which project to make it in with project: ${all.map((candidate) => candidate.name).join(", ")}. get_projects lists them.`);
  }
  if ((await readableName(env, project.channel, user)) === null) throw new ToolError("You aren't in that project's channel, so I can't make a task there for you.");

  if (!source) {
    const same = (await tasksWithStatuses(env, OPEN)).find((entry) => entry.channel === project!.channel && entry.task.title.trim().toLowerCase() === title.toLowerCase());
    if (same) throw new ToolError(`${project.name} already has an open ${(kindName(same.task) || "task").toLowerCase()} called "${same.task.title}" (${same.channel}:${same.ts}). Use it, or give this one a different title.`);
  }
  const task: Task = parent
    ? { ...newSubtask(parent.task, parent.ts, title, user, { dueDate: args.due_date !== undefined ? dueDate : undefined, bug }), viaAgent: true }
    : { title, status: "TODO", ...(incident ? { ...INCIDENT, incident: true } : { priority: (args.priority ?? "Medium") as Priority, dueDate, ...(bug && { bug }) }), people: noPeople(), createdBy: user, viaAgent: true };
  const ts = await createTask(env, task, { channel: project.channel, move: source });
  if (!ts) throw new ToolError(`Slack wouldn't take the ${kind} just now. Cade tries again in a few minutes, so check ${project.name}'s channel before trying again.`);

  const what = parent ? `subtask${bug ? " (a bug)" : ""} "${title}" of "${parent.task.title}"` : `${kind} "${title}"`;
  const told = [`Created the ${what} in ${project.name}${source ? ", and asked for the thread to be moved into it" : ""}.`];
  const made = await loadTask(env, project.channel, ts);
  console.log("Task created by MCP", { channel: project.channel, ts, by: user, kind, fromThread: Boolean(source) });
  return {
    text: `${told.join(" ")}${made?.link ? ` ${made.link}` : ""}`.trim(),
    data: { task_id: `${project.channel}:${ts}`, link: made?.link ?? "", project: project.name, incident, bug, parent_task_id: parent ? `${parent.channel}:${parent.ts}` : null },
  };
}

// The pull request addresses in a list of links, without duplicates, or a ToolError.
function prLinksOf(list: unknown, name: string): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new ToolError(`${name} is a list of pull request links.`);
  return [...new Set(list.map((link) => {
    const pr = parsePullRequest(String(link).trim().replace(/^<|>$/g, ""));
    if (!pr) throw new ToolError(`"${link}" doesn't look like a pull request link (GitHub, GitLab or Bitbucket).`);
    return pr.url;
  }))];
}

// Changes a task's fields for the person, and tells its thread.
export async function updateTask(env: AppEnv, user: string, args: UpdateTaskArgs) {
  const { channel, ts } = taskRef(args);
  const task = await loadTask(env, channel, ts);
  if (!task) throw new ToolError("That isn't a task Cade tracks. Use the task's ID from get_tasks, or the link to its message.");
  if ((await readableName(env, channel, user)) === null) throw new ToolError("You aren't in that task's project channel, so I can't change it for you.");

  const changes: Changes = {};
  if (args.status !== undefined) {
    const status = parseStatus(String(args.status));
    if (!status) throw new ToolError(`status is one of ${Object.keys(STATUSES).join(", ")}.`);
    if (task.status === "CLIENT_REVIEW" && status !== task.status) throw new ToolError("This task is in Client review: it waits for the client's approver, who approves it or sends it back in the task's thread in Slack. Tell the person, and don't change its status here.");
    if (status !== task.status && waitsForSubtasks(task, status)) {
      const open = (await subtasksOf(env, channel, ts)).filter((sub) => sub.task.status !== "DONE");
      const names = open.map((sub) => `"${sub.task.title}" (${statusName(sub.task.status)}, task ID ${channel}:${sub.ts})`).join(", ");
      throw new ToolError(`This task has ${open.length} open subtask${open.length === 1 ? "" : "s"}: ${names}. A task moves to Client review or Done only once all its subtasks are Done, so nothing was changed. Tell the person, and ask whether to close them: if they agree, after the usual preview, set each one to DONE with update_task, then move this task.`);
    }
    changes.status = status;
  }
  if (args.priority !== undefined) {
    if (!PRIORITIES[args.priority as Priority]) throw new ToolError(`priority is one of ${Object.keys(PRIORITIES).join(", ")}.`);
    if (task.parent) throw new ToolError("This is a subtask, which has its task's priority: change the task's priority instead, and its subtasks follow. Its due date is its own.");
    changes.priority = args.priority;
  }
  if (args.due_date !== undefined) changes.dueDate = dueDateOf(args.due_date);
  if (args.bug !== undefined) {
    if (typeof args.bug !== "boolean") throw new ToolError("bug is true or false.");
    if (task.incident) throw new ToolError("This is an incident, and stays one: it can't be made a bug or a task. Leave out bug.");
    changes.bug = args.bug;
  }
  if (args.blocked !== undefined || args.blocked_reason !== undefined) {
    if (args.blocked !== undefined && typeof args.blocked !== "boolean") throw new ToolError("blocked is true or false.");
    if (args.blocked_reason !== undefined && typeof args.blocked_reason !== "string") throw new ToolError("blocked_reason is text.");
    if (args.blocked === false && args.blocked_reason) throw new ToolError("blocked_reason goes with blocked: true.");
    if (args.blocked === undefined && !task.blocked) throw new ToolError("blocked_reason needs blocked: true, as the task isn't blocked.");
    changes.blocked = args.blocked === false ? { on: false } : { on: true, reason: args.blocked_reason };
  }
  for (const role of Object.keys(ROLES) as Role[]) {
    if (args[role] === undefined) continue;
    const add = userIds(role, args[role].add);
    const remove = userIds(role, args[role].remove);
    if (add.some((id) => remove.includes(id))) throw new ToolError(`${role}: the same person is in add and remove.`);
    changes.people = { ...changes.people, [role]: { add, remove } };
  }
  await requireActiveUsers(env, Object.values(changes.people ?? {}).flatMap(({ add = [] }) => add));
  const prs = args.prs;
  if (prs !== undefined) {
    const links = (name: "add" | "remove") => prLinksOf(prs[name], `prs.${name}`);
    const add = links("add");
    const remove = links("remove");
    if (add.some((url) => remove.includes(url))) throw new ToolError("prs: the same pull request is in add and remove.");
    // Merged and closed ones stay with the task, as the card's Pull requests form keeps them (see prs.ts).
    const settled = remove.filter((url) => task.prs.includes(url) && prState(task, url) !== "OPEN");
    if (settled.length) throw new ToolError(`${settled.join(", ")} ${settled.length === 1 ? "is" : "are"} merged or closed, and stay${settled.length === 1 ? "s" : ""} linked: only open pull requests can be unlinked.`);
    changes.prs = { add, remove };
  }
  if (!Object.keys(changes).length) throw new ToolError("Nothing to change: give a status, priority, due_date, bug, blocked, owner, reviewer, tester or prs. A summary is saved with save_task_summary.");

  const skipped = task.incident && ("priority" in changes || "dueDate" in changes) ? " An incident's priority and due date never change, so those were left alone." : "";
  const told: string[] = [];
  // The thread says it was an AI agent, and Slack shows the person no private prompt: they are not looking at it.
  const change = await applyChanges(env, { channel, ts }, changes, user, { source: "mcp" });
  const changed = Boolean(change);
  told.push(changed ? `The change is posted in the task's thread.${skipped}` : `The task already had those values.${skipped}`);
  // What it asks of people isn't posted with it, as in Slack (see commands/ask.ts): the person decides.
  let ask = change ? changeRequests(change).join("\n") : "";
  if (ask) told.push(`Nothing was sent to the people it names. Ask the person whether to send this in the thread, as it is, changed, or not at all, then send_thread_message with their version: ${ask}`);
  // In Client review, the approver's request is the one to offer, sent with send_approval_request.
  if (change && changes.status === "CLIENT_REVIEW") {
    ask = approvalRequest(null, change.task.prs ?? []);
    told.push(`It is in Client review now. Ask the person who should approve it, and show them the request send_approval_request will post to them, with the approver mentioned first as @Name, to send as it is, changed, or not at all: "${ask}". Then call send_approval_request with the approver, and their version as message (leave message out for this one as it is).`);
  }
  console.log("Task updated", { channel, ts, by: user, fields: Object.keys(changes) });
  return {
    text: `${changed ? "Done." : "Nothing changed."} ${told.join(" ")}`,
    data: { task_id: `${channel}:${ts}`, changed, suggested_message: ask },
  };
}
