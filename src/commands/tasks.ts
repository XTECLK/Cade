import { tasksWithStatus } from "../db.ts";
import { escapeSlack, mentions } from "../slack.ts";
import { PRIORITIES, ROLES, STATUSES } from "../tasks.ts";
import type { AppEnv } from "../env.ts";
import type { Project } from "../channels.ts";
import type { Priority, Role, Status, Task } from "../types.ts";

// An open task in a list, with a link to its thread (see groupTasks).
export interface TaskEntry {
  channel: string;
  ts: string;
  task: Task;
  incident?: boolean;
  link: string;
}

// Helpers for lists of open tasks: the Home tab, standups, summaries and the MCP tools.

// Open tasks: every status but Done.
export const OPEN: Status[] = (Object.keys(STATUSES) as Status[]).filter((status) => status !== "DONE");

export function line({ task, link, incident }: Pick<TaskEntry, "task" | "link" | "incident">, { people = false } = {}) {
  const label = incident ? "*Incident:* " : "";
  const parts = [
    `• ${label}<${link}|${escapeSlack(task.title)}>`,
    STATUSES[task.status],
    `${PRIORITIES[task.priority]} ${task.priority}`,
    `Due ${task.dueDate || "_none_"}`,
  ];
  if (people) {
    const ids = [...new Set((Object.keys(ROLES) as Role[]).flatMap((role) => task.people[role]))];
    parts.push(ids.length ? mentions(ids) : "_Unassigned_");
  }
  return parts.join("  ·  ");
}

// Incidents first, then by priority, then the soonest due date. "Immediate"
// is the soonest; no due date is the latest.
export function byUrgency(a: Pick<TaskEntry, "task" | "incident">, b: Pick<TaskEntry, "task" | "incident">) {
  const order = Object.keys(PRIORITIES) as Priority[];
  return (
    Number(b.incident) - Number(a.incident) ||
    order.indexOf(a.task.priority) - order.indexOf(b.task.priority) ||
    dueOrder(a.task.dueDate) - dueOrder(b.task.dueDate)
  );
}

function dueOrder(dueDate: string | undefined) {
  if (dueDate === "Immediate") return -Infinity;
  const iso = isoDate(dueDate);
  return iso ? Date.parse(iso) : Infinity;
}

// Today's date in TIMEZONE (UTC by default), as YYYY-MM-DD.
export function todayIn(env: Pick<AppEnv, "TIMEZONE">, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env.TIMEZONE || "UTC" }).format(now);
}

// DD/MM/YYYY as YYYY-MM-DD, or "" for anything else.
function isoDate(dueDate: string | undefined) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dueDate ?? "");
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

// A link to the message `ts` that opens its thread, not just the message,
// from the workspace's address, `url`.
export function threadLink(url: string, channel: string, ts: string) {
  return `${url}archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel}`;
}

// The group's tasks with one of `statuses`, as { channel, ts, task, link,
// incident }, from its tasks channel. Links are built from the workspace's address, `url`, rather
// than looked up one by one, which would take a Slack call per task.
export async function groupTasks(env: AppEnv, group: Pick<Project, "channel">, statuses: readonly Status[], url: string): Promise<TaskEntry[]> {
  const channel = group.channel;
  return (await tasksWithStatus(env, channel, statuses)).map(({ ts, task }) => ({
    channel,
    ts,
    task,
    incident: task.incident,
    link: threadLink(url, channel, ts),
  }));
}
