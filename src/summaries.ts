import { deleteSummary, insertSummary, lastSummary, putSummaryItem, recordSummaryDoc, summaryItems } from "./db.ts";
import { docsEnabled, readSection, workDocId, writeSection } from "./doc.ts";
import { linkedThread } from "./slack.ts";
import { STATUSES, statusName } from "./tasks.ts";
import { byUrgency, groupTasks, todayIn } from "./commands/tasks.ts";
import type { AppEnv } from "./env.ts";
import type { Project } from "./channels.ts";
import type { DocBlock } from "./doc.ts";
import type { Summary, SummaryItem } from "./db.ts";
import type { Status, Task } from "./types.ts";

// A task in a summary (see collect).
export interface SummaryEntry {
  channel: string;
  ts: string;
  title: string;
  incident?: boolean;
  link: string;
  completedAt: string;
  // Its status's name, without the emoji.
  status: string;
  task: Task;
}

// What the person said of a task for a summary: what's not given keeps what the last summary said.
export interface Choice {
  channel: string;
  ts: string;
  included?: boolean;
  health?: string;
  progress?: string;
  notes?: string;
}

// What a summary says of a task.
type Said = { included: boolean; health: string | null; progress: string; notes: string };

// A summary's period: when it starts and ends.
type Period = Pick<Summary, "since" | "until">;

// Executive summaries, for the MCP tools get_executive_summary,
// get_executive_summary_doc, create_executive_summary and
// update_executive_summary_after_call (see mcp.ts). The agent writes a summary
// with the person; it goes at the top of the Summary tab of the project's
// Google Doc (its `workDoc`), where it is gone through with the client, and
// what it said of each task is kept here as a snapshot. After the call the
// agent reads the doc back, compares it with the snapshot itself, and keeps
// what the call changed as updates. A summary's period starts the day after
// the last one's ends, so no closed task is missed.

// Thrown for what's wrong with what a summary was asked to say, as a message for the person.
export class SummaryError extends Error {}

// The first summary of a project covers the past week, to today.
const FIRST_PERIOD_DAYS = 7;

// How active work is going, as the summary says it, worst first: the
// summary lists it in this order.
export const HEALTH: Record<"BLOCKED" | "DELAYED" | "AT_RISK" | "ON_TRACK", string> = {
  BLOCKED: ":no_entry: Blocked",
  DELAYED: ":hourglass_flowing_sand: Delayed",
  AT_RISK: ":warning: At risk",
  ON_TRACK: ":thumbsup: On track",
};

// Why the project's summaries can't be written in its Google Doc, if they
// can't: the doc's web app isn't set up, or the project has no doc.
export function docProblem(env: AppEnv, project: Project) {
  if (!docsEnabled(env)) {
    return "Executive summaries are kept in a Google Doc, and the Google web app isn't set up yet: run npm run google:create (see GETTING_STARTED.md).";
  }
  if (!workDocId(project)) {
    return `${project.name} has no Google Doc yet. Every project has one, made when it's added from the Home tab.`;
  }
  return undefined;
}

// The instant a day (YYYY-MM-DD) starts in TIMEZONE, or with `end` the
// last millisecond before it ends, as an ISO timestamp.
export function dayBoundary(env: Pick<AppEnv, "TIMEZONE">, day: string, { end = false } = {}) {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const wall = end ? Date.UTC(year, month - 1, date, 23, 59, 59, 999) : Date.UTC(year, month - 1, date);
  // How far the zone's clock is ahead of UTC at `at`; asked twice, in case
  // it changes between the guess and the answer.
  const offset = (at: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: env.TIMEZONE || "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(at)
        .map(({ type, value }) => [type, Number(value)]),
    );
    const local = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
    return local - Math.floor(at / 1000) * 1000;
  };
  const guess = wall - offset(wall);
  return new Date(wall - offset(guess)).toISOString();
}

// YYYY-MM-DD, `days` later (earlier, if negative).
function addDays(day: string, days: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// A day (YYYY-MM-DD) as DD/MM/YYYY.
export function showDay(day: string) {
  const [year, month, date] = day.split("-");
  return `${date}/${month}/${year}`;
}

// The summary's period as days in TIMEZONE: { from, to }, as YYYY-MM-DD.
export function period(env: Pick<AppEnv, "TIMEZONE">, summary: Period) {
  return { from: todayIn(env, new Date(summary.since)), to: todayIn(env, new Date(summary.until)) };
}

// "18/10/2026 – 25/10/2026"
export function periodLabel(env: Pick<AppEnv, "TIMEZONE">, summary: Period) {
  const { from, to } = period(env, summary);
  return `${showDay(from)} – ${showDay(to)}`;
}

// A status label without its emoji.
function label(text: string) {
  return text.replace(/^:[a-z0-9_+-]+:\s*/, "");
}

// The period a new summary of the project covers unless the person says
// otherwise, as { from, to, last }: the day after the last summary's period
// (the past week, for the first) to today, as YYYY-MM-DD, and the last summary.
export async function defaultPeriod(env: AppEnv, project: Project) {
  const last = await lastSummary(env, project.name);
  const to = todayIn(env);
  let from = addDays(to, -FIRST_PERIOD_DAYS);
  if (last) from = addDays(todayIn(env, new Date(last.until)), 1);
  if (from > to) from = to;
  return { from, to, last };
}

// The project's tasks for a summary covering `since` to `until` (ISO
// timestamps), as { done, active } of entries { channel, ts, title, incident, link,
// completedAt, status, task }: `done` what was completed in the period, oldest
// first; `active` what isn't done, most urgent first.
export async function collect(env: AppEnv, project: Project, since: string, until: string, url: string) {
  // Subtasks are parts of a task, which the summary speaks of as a whole.
  const all: SummaryEntry[] = (await groupTasks(env, project, Object.keys(STATUSES) as Status[], url)).filter(({ task }) => !task.parent).map(({ channel, ts, task, link, incident }) => ({
    channel,
    ts,
    title: task.title,
    incident,
    link,
    completedAt: task.completedAt!,
    status: statusName(task.status),
    task,
  }));
  const done = all
    .filter((entry) => entry.task.status === "DONE" && entry.completedAt >= since && entry.completedAt <= until)
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const active = all.filter((entry) => entry.task.status !== "DONE").sort(byUrgency);
  return { done, active };
}

// Writes a new summary of `project` to its Google Doc and keeps what it says. `choices` are
// { channel, ts, included?, health?, progress?, notes? } for the tasks the person said something about:
// any other task keeps the health, progress and notes the last summary gave it (as agreed after its call; an
// active one with none is on track) and is included. Returns { summary, address, carried } with the active tasks that were
// carried over; throws if a task isn't in the period's work or the doc can't be written (then nothing is kept).
export async function writeSummary(
  env: AppEnv,
  project: Project,
  { user, since, until, choices, url }: { user: string; since: string; until: string; choices: Choice[]; url: string },
) {
  const { done, active } = await collect(env, project, since, until, url);
  const entries = new Map([...done, ...active].map((entry) => [`${entry.channel}:${entry.ts}`, entry]));
  const said = new Map<string, Choice>();
  for (const choice of choices) {
    const key = `${choice.channel}:${choice.ts}`;
    if (!entries.has(key)) throw new SummaryError(`${key} isn't one of ${project.name}'s tasks completed in the period or not done. get_tasks lists them (completed_from finds those closed in the period).`);
    said.set(key, choice);
  }
  // The last summary as it stands: as agreed after the call, if that was recorded, else as written.
  const last = await lastSummary(env, project.name);
  const lastItems = last ? await summaryItems(env, last.id) : { before: [] as SummaryItem[], after: [] as SummaryItem[] };
  const before = new Map((lastItems.after.length ? lastItems.after : lastItems.before).map((item) => [`${item.channel}:${item.ts}`, item]));

  // What the summary says of an entry: the person's word, else the last summary's, else the default.
  const chosen = (entry: SummaryEntry): Said => {
    const key = `${entry.channel}:${entry.ts}`;
    const choice: Partial<Choice> = said.get(key) ?? {};
    const was = before.get(key);
    return {
      included: choice.included ?? true,
      health: choice.health ?? was?.health ?? "ON_TRACK",
      progress: choice.progress ?? was?.progress ?? "",
      notes: choice.notes ?? was?.notes ?? "",
    };
  };

  const id = await insertSummary(env, project.name, { createdBy: user, since, until });
  const summary = { id, project: project.name, since, until };
  try {
    for (const [kind, list] of [["COMPLETED", done], ["ACTIVE", active]] as [string, SummaryEntry[]][]) {
      for (const entry of list) {
        const mine = chosen(entry);
        await putSummaryItem(env, id, "BEFORE", { channel: entry.channel, ts: entry.ts, kind, title: entry.title, status: entry.task.status, incident: entry.incident, ...mine, health: kind === "ACTIVE" ? mine.health : null });
      }
    }
    const blocks = summaryDocBlocks(env, summary, done, active, chosen);
    const doc = workDocId(project);
    const address = await writeSection(env, doc, `summary:${id}`, blocks);
    await recordSummaryDoc(env, id, doc, address, blocks.map(docBlockText));
    const carried = active.filter((entry) => !said.has(`${entry.channel}:${entry.ts}`));
    return { summary, address, carried };
  } catch (error) {
    await deleteSummary(env, id);
    throw error;
  }
}

// The summary's section of its doc as it reads now, as a list of { type: "heading" | "paragraph" | "item",
// level, text, task_id, written }: `task_id` is the task a line links to ("" for none), and `written`
// whether it is a line Cade wrote (so false for what people added). Null if the section is gone.
export async function readSummaryDoc(env: AppEnv, summary: Summary) {
  const elements = await readSection(env, summary.docId!, `summary:${summary.id}`);
  if (!elements) return null;
  const written = new Set(summary.docLines.map((text) => text.trim()));
  return elements
    .map((element) => {
      const text = (element.text ?? "").trim();
      const thread = (element.links ?? []).map(threadOf).find(Boolean);
      return { type: element.type, level: element.level ?? 0, text, task_id: thread ? `${thread.channel}:${thread.ts}` : "", written: written.has(text) };
    })
    .filter((element) => element.text);
}

// The thread a link in the doc opens, as { channel, ts }, or null. Cade's
// links (see threadLink) name the thread; others are read as Slack message
// links.
function threadOf(link: string) {
  const match = /\/archives\/([A-Z0-9]+)\/p\d+\?(?:[^#]*&)?thread_ts=([\d.]+)/.exec(link.replace(/&amp;/g, "&"));
  return match ? { channel: match[1], ts: match[2] } : linkedThread(link);
}

// The summary as a section of the doc (see writeSection in doc.ts): a
// heading with the day it was written, the period, then the same sections
// as the others, each line a bullet whose title links to its thread, with
// its notes as bullets under it.
export function summaryDocBlocks(
  env: AppEnv,
  summary: Pick<Summary, "project" | "since" | "until">,
  done: SummaryEntry[],
  active: SummaryEntry[],
  chosen: (entry: SummaryEntry) => Said,
) {
  type Health = keyof typeof HEALTH;
  const health = (entry: SummaryEntry) => (HEALTH[chosen(entry).health as Health] ? chosen(entry).health : "ON_TRACK") as Health;
  const going = active.filter((entry) => chosen(entry).included);
  const blocks: DocBlock[] = [
    { type: "heading", level: 2, text: `${showDay(todayIn(env))} · ${summary.project} executive summary` },
    { type: "paragraph", italic: true, text: `Period: ${periodLabel(env, summary)}` },
  ];
  const section = (heading: string, entries: SummaryEntry[], item: (entry: SummaryEntry) => DocBlock[]) => {
    if (!entries.length) return;
    blocks.push({ type: "heading", level: 3, text: `${heading} (${entries.length})` }, ...entries.flatMap(item));
  };
  const named = (entry: SummaryEntry) => [...(entry.incident ? [{ text: "Incident: " }] : []), { text: entry.title, link: entry.link }];
  const activeItem = (entry: SummaryEntry, label?: string): DocBlock[] => {
    const { progress, notes } = chosen(entry);
    const rest = [label, entry.status, progress].filter(Boolean).join("  ·  ");
    return [
      { type: "item", level: 0, parts: [{ text: entry.title, link: entry.link }, ...(rest ? [{ text: `  ·  ${rest}` }] : [])] },
      ...(notes ?? "")
        .split("\n")
        .map((note) => note.trim())
        .filter(Boolean)
        .map((note): DocBlock => ({ type: "item", level: 1, parts: [{ text: note }] })),
    ];
  };
  section("Completed", done.filter((entry) => chosen(entry).included), (entry) => [{ type: "item", level: 0, parts: named(entry) }]);
  section("Incidents", going.filter((entry) => entry.incident), (entry) => activeItem(entry, label(HEALTH[health(entry)])));
  for (const [key, heading] of Object.entries(HEALTH) as [Health, string][]) {
    const these = going.filter((entry) => !entry.incident && health(entry) === key);
    section(label(heading), these, (entry) => activeItem(entry));
  }
  if (blocks.length === 2) blocks.push({ type: "paragraph", text: "Nothing completed or active." });
  return blocks;
}

// A doc block's text, as the doc shows it.
export function docBlockText(block: DocBlock) {
  type Loose = { parts?: { text: string }[]; text: string };
  return (block as Loose).parts ? (block as Loose).parts!.map((part) => part.text).join("") : (block as Loose).text;
}

// A summary's two versions side by side, from summaryItems: a list of { channel, ts, kind, title, status,
// incident, before, after, change, informedAt }, `before` and `after` being { included, health, progress,
// notes } or null (null `after` before the call was recorded; null `before` for what the call added).
// `change` is "pending" while no call was recorded, else "unchanged", "changed", "removed" (in the summary
// before, taken out after the call) or "added" (suggested in the call).
export function compareVersions({ before, after }: { before: SummaryItem[]; after: SummaryItem[] }) {
  type Version = Pick<SummaryItem, "included" | "health" | "progress" | "notes">;
  type Row = Pick<SummaryItem, "channel" | "ts" | "kind" | "title" | "status" | "incident" | "informedAt"> & {
    before: Version | null;
    after: Version | null;
    change: "pending" | "unchanged" | "changed" | "removed" | "added";
  };
  const key = (item: SummaryItem) => `${item.channel}:${item.ts}:${item.title}`;
  const state = (item: SummaryItem): Version => ({ included: item.included, health: item.health, progress: item.progress, notes: item.notes });
  const later = new Map(after.map((item) => [key(item), item]));
  const rows = before.map((item): Row => {
    const now = later.get(key(item));
    let change: Row["change"] = "pending";
    if (after.length) {
      if (!now || (item.included && !now.included)) change = "removed";
      else if ((["included", "health", "progress", "notes"] as const).some((field) => (item[field] ?? null) !== (now[field] ?? null))) change = "changed";
      else change = "unchanged";
    }
    return { channel: item.channel, ts: item.ts, kind: item.kind, title: item.title, status: item.status, incident: item.incident, before: state(item), after: now ? state(now) : null, change, informedAt: now?.informedAt ?? null };
  });
  const known = new Set(before.map(key));
  for (const item of after) {
    if (known.has(key(item))) continue;
    rows.push({ channel: item.channel, ts: item.ts, kind: item.kind, title: item.title, status: item.status, incident: item.incident, before: null, after: state(item), change: "added", informedAt: item.informedAt });
  }
  return rows;
}
