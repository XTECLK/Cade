import { projects } from "./channels.ts";
import { getHomeProject, getHomeTab, setHomeTab, suggestionsOn } from "./db.ts";
import { byUrgency, groupTasks, OPEN, todayIn } from "./commands/tasks.ts";
import { formatTime } from "./format.ts";
import { MCP_ACTION, WEB_ACTION, mcpLine, webLine } from "./commands/configure.ts";
import { mcpEnabled } from "./mcp.ts";
import { SETTINGS, isAdmin, projectMembers, settingOn } from "./settings.ts";
import { callSlack, escapeSlack, mrkdwn, plainText } from "./slack.ts";
import { PRIORITIES, blockedLine, peopleLine, ROLES, STATUSES } from "./tasks.ts";
import type { AppEnv } from "./env.ts";
import type { Project } from "./channels.ts";
import type { TaskEntry } from "./commands/tasks.ts";
import type { Role, SlackBlock, Status, Task } from "./types.ts";

type Tab = keyof typeof TABS;
// What the Home tab shows: a view of the tasks, or Configure.
export type HomeTab = Tab | typeof CONFIGURE;
type Section = { role: Role; emoji: string; title: string; ready: Status[]; empty: string };

// The Home tab of Cade's app: what the person has open, by what they do on
// it, most urgent first. It is only another view of the tasks Cade already
// stores, drawn when they open it or press Refresh.

// What each role is doing, and the statuses in which the task is waiting on
// them. Tasks in other statuses are theirs but not yet, and are listed
// after the ones to act on.
const SECTIONS: Section[] = [
  { role: "owner", emoji: ":hammer_and_wrench:", title: "To work on", ready: ["TODO", "IN_PROGRESS"], empty: "Nothing to work on." },
  { role: "reviewer", emoji: ":eyes:", title: "To review", ready: ["IN_REVIEW"], empty: "Nothing to review." },
  { role: "tester", emoji: ":test_tube:", title: "To test", ready: ["IN_TESTING"], empty: "Nothing to test." },
];

// A view holds 100 blocks and each task takes two, so long lists are cut
// short.
const MAX_READY = 12;
const MAX_LATER = 5;

export const REFRESH_ACTION = "home:refresh";

// Assign to me, on an unassigned task's card. Each card's button has its own
// id, ending in the task's channel and thread, as a view can't repeat one.
export const CLAIM_ACTION = "home:claim";

// The project picker, which also remembers the choice (see db.ts). Its value
// is a project's name; with none chosen, or one that is gone, the first project is shown.
export const PROJECT_ACTION = "home:project";

// The two parts of the tab, as buttons under the picker: the person's tasks, and Configure, with the
// setup buttons (see commands/configure.ts) and, for an admin, the project's settings. Which part is
// open isn't kept: the tab opens on tasks.
export const HOME_ACTION = "home:section:home";
export const CONFIGURE_ACTION = "home:section:configure";
export const CONFIGURE = "configure";
export const SETTINGS_ACTION = "home:settings";
export const ADD_PROJECT_ACTION = "home:project:add";
// Turn off / Turn on, in Configure: the person's own suggestions (see suggestionsRow).
export const SUGGESTIONS_ACTION = "home:suggestions";

// The buttons along the top, each a view of the open tasks. Slack has no
// tabs in the Home tab, so a button draws the tab again with its view.
export const TABS = {
  mine: { action: "home:tab:mine", label: "My Tasks" },
  unassigned: { action: "home:tab:unassigned", label: "Unassigned" },
  all: { action: "home:tab:all", label: "All Tasks" },
};
const DEFAULT_TAB = "mine";

// The cards in the Unassigned and All Tasks views, two blocks each (three
// with the Assign to me button).
const MAX_LISTED = 20;

// Draws `user`'s Home tab, on the `tab` view, which is kept for next time, or on Configure, which isn't.
// With none, it opens on the tasks tab they were last on.
export async function publishHome(env: AppEnv, user: string, tab?: string) {
  if (TABS[tab as Tab]) await setHomeTab(env, user, tab!);
  else if (tab !== CONFIGURE) tab = (await getHomeTab(env, user)) ?? DEFAULT_TAB;
  await callSlack(env, "views.publish", { user_id: user, view: await homeView(env, user, tab) });
}

// The view carries its tab (or Configure), for the project picker to draw it again on.
export async function homeView(env: AppEnv, user: string, tab: string = DEFAULT_TAB) {
  if (!TABS[tab as Tab] && tab !== CONFIGURE) tab = DEFAULT_TAB;
  return { ...(await draw(env, user, tab)), private_metadata: tab };
}

async function draw(env: AppEnv, user: string, tab: string) {
  const { url } = await callSlack(env, "auth.test", {});
  const all = projects(env);
  // The person's last project, unless it is gone from the settings: then the first.
  const chosen = await getHomeProject(env, user);
  const project = all.find((group) => group.name === chosen) ?? all[0];
  // The project picker, Add project (for an admin) and Refresh share a row, then the two parts of the tab, then (for tasks) the tabs.
  const top: SlackBlock[] = [
    {
      type: "actions",
      elements: [
        ...(project ? [projectPicker(all, project)] : []),
        ...(isAdmin(env, user) ? [{ type: "button", action_id: ADD_PROJECT_ACTION, text: plainText("Add project") }] : []),
        { type: "button", action_id: REFRESH_ACTION, text: plainText("Refresh"), value: tab },
      ],
    },
    {
      type: "actions",
      elements: [
        { type: "button", action_id: HOME_ACTION, text: plainText("Home"), ...(tab !== CONFIGURE && { style: "primary" }) },
        { type: "button", action_id: CONFIGURE_ACTION, text: plainText("Configure"), ...(tab === CONFIGURE && { style: "primary" }) },
      ],
    },
  ];
  if (!project) {
    return { type: "home", blocks: [...top, { type: "context", elements: [mrkdwn("_There are no projects yet. An admin adds one with the Add project button._")] }] };
  }
  if (tab === CONFIGURE) return await configureView(env, user, top, project);
  const open = await groupTasks(env, project, OPEN, url);
  const today = todayIn(env);
  const tabRow = {
    type: "actions",
    elements: Object.entries(TABS).map(([name, { action, label }]) => ({
      type: "button",
      action_id: action,
      text: plainText(label),
      ...(name === tab && { style: "primary" }),
    })),
  };
  if (tab !== "mine") return listView(env, tab, top, tabRow, open, today, user);

  const entries = open.filter((entry) => (Object.keys(ROLES) as Role[]).some((role) => entry.task.people[role].includes(user)));

  const sections = SECTIONS.map((section) => {
    const theirs = entries.filter((entry) => entry.task.people[section.role].includes(user)).sort(byUrgency);
    return {
      ...section,
      ready: theirs.filter((entry) => section.ready.includes(entry.task.status)),
      later: theirs.filter((entry) => !section.ready.includes(entry.task.status)),
    };
  });
  const overdue = new Set(entries.filter((entry) => isOverdue(entry.task, today)).map((entry) => entry.ts + entry.channel));

  const waiting = sections.reduce((sum, section) => sum + section.ready.length, 0);
  const summary = waiting
    ? `*${waiting}* waiting on you${overdue.size ? `  ·  :warning: *${overdue.size}* overdue` : ""}`
    : "You're all caught up :tada:";

  const blocks: SlackBlock[] = [
    ...top,
    { type: "header", text: plainText("Your tasks") },
    { type: "context", elements: [mrkdwn(summary)] },
    tabRow,
  ];
  for (const section of sections) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "header", text: { type: "plain_text", text: `${section.emoji} ${section.title} (${section.ready.length})`, emoji: true } });
    blocks.push(...list(section, today, user));
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// A dropdown of the projects, on `project`.
function projectPicker(groups: Project[], project: Project) {
  const options = groups.slice(0, 100).map((group) => ({ text: plainText(group.name.slice(0, 75)), value: group.name }));
  return {
    type: "static_select",
    action_id: PROJECT_ACTION,
    placeholder: plainText("Project"),
    options,
    initial_option: options[groups.indexOf(project)] ?? options[0],
  };
}

// The Configure part: the whole picture without a click, a section for each setup with how it stands
// now and a button to change it. AI agent says so when MCP is turned off, and has no button then; Project
// settings is for admins only, and lists the project's switches.
async function configureView(env: AppEnv, user: string, top: SlackBlock[], project: Project) {
  const row = (title: string, now: string, action: string | false, label: string, value?: string) => ({
    type: "section",
    text: mrkdwn(`*${title}*\n${now}`),
    ...(action && { accessory: { type: "button", action_id: action, text: plainText(label), ...(value && { value }) } }),
  });
  const members = projectMembers(env, project.channel);
  const switches = SETTINGS.map(({ key, label }) => `${label}: ${stateOf(settingOn(env, project.channel, key))}`).join("  ·  ");
  const blocks = [
    ...top,
    { type: "header", text: plainText("Configure") },
    row("Web pages", `${await webLine(env, user)}\nThe thread and notes pages that task cards link to.`, WEB_ACTION, "Manage"),
    row("AI agent", `${await mcpLine(env, user)}\nYour own AI agent, connected to Cade.`, mcpEnabled(env) && MCP_ACTION, "Manage"),
    await suggestionsRow(env, user, project),
    ...(isAdmin(env, user)
      ? [row("Project settings", `*${project.name}*: ${members.length ? `${members.length} ${members.length === 1 ? "person" : "people"} picked` : "everyone in the workspace"}\n${switches}`, SETTINGS_ACTION, "Change", project.channel)]
      : []),
    { type: "divider" },
    { type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] },
  ];
  return { type: "home", blocks };
}

// The person's own switch for the suggestions Cade offers them from their messages in task threads
// (see suggest.ts). It can only turn them off for them: when the project has them off, that's said too.
async function suggestionsRow(env: AppEnv, user: string, project: Project) {
  const on = await suggestionsOn(env, user);
  const now = on
    ? ":white_check_mark: On. Cade privately offers to update a task from what you write in its thread."
    : ":x: Off for you. Cade won't offer to update a task from your messages, so update it yourself.";
  const projectOff = settingOn(env, project.channel, "taskChangeDetection") === false ? `\n_Turned off for everyone in *${project.name}* by an admin._` : "";
  return {
    type: "section",
    text: mrkdwn(`*Suggestions*\n${now}${projectOff}`),
    accessory: { type: "button", action_id: SUGGESTIONS_ACTION, text: plainText(on ? "Turn off" : "Turn on"), value: JSON.stringify({ on: !on }) },
  };
}

const stateOf = (on: boolean | "some") => (on === "some" ? "partly on" : on ? "on" : "off");

// The Unassigned and All Tasks views: the open tasks as cards, most urgent
// first. Unassigned ones have an Assign to me button there, and only there.
function listView(env: AppEnv, tab: string, top: SlackBlock[], tabRow: SlackBlock, open: TaskEntry[], today: string, user: string) {
  const unassigned = tab === "unassigned";
  const entries = (unassigned ? open.filter((entry) => !(Object.keys(ROLES) as Role[]).some((role) => entry.task.people[role].length)) : open).sort(byUrgency);
  const blocks: SlackBlock[] = [
    ...top,
    { type: "header", text: plainText(unassigned ? "Unassigned tasks" : "All open tasks") },
    { type: "context", elements: [mrkdwn(`*${entries.length}* open`)] },
    tabRow,
    { type: "divider" },
  ];
  if (!entries.length) blocks.push({ type: "context", elements: [mrkdwn(`_${unassigned ? "Everything open has someone on it." : "Nothing is open."}_`)] });
  blocks.push(...entries.slice(0, MAX_LISTED).flatMap((entry) => card(entry, today, user, unassigned)));
  if (entries.length > MAX_LISTED) {
    blocks.push({ type: "context", elements: [mrkdwn(`_…and ${entries.length - MAX_LISTED} more._`)] });
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// A section's tasks: those waiting on the person as cards, most urgent
// first, then the rest as small lines.
function list({ ready, later, empty }: { ready: TaskEntry[]; later: TaskEntry[]; empty: string }, today: string, user: string) {
  const blocks: SlackBlock[] = [];
  if (!ready.length) blocks.push({ type: "context", elements: [mrkdwn(`_${empty}_`)] });
  blocks.push(...ready.slice(0, MAX_READY).flatMap((entry) => card(entry, today, user)));
  if (ready.length > MAX_READY) {
    blocks.push({ type: "context", elements: [mrkdwn(`_…and ${ready.length - MAX_READY} more._`)] });
  }
  if (later.length) {
    const lines = later.slice(0, MAX_LATER).map(({ task, link }) => `<${link}|${escapeSlack(task.title)}>  ·  ${STATUSES[task.status]}`);
    if (later.length > MAX_LATER) lines.push(`_…and ${later.length - MAX_LATER} more._`);
    blocks.push({ type: "context", elements: [mrkdwn(`*Coming up*\n${lines.join("\n")}`)] });
  }
  return blocks;
}

// A task as a card, in two blocks: its title, linking to its thread, then
// in the smaller type of a context block its priority, status and due date, and below them its owner,
// reviewers and testers (as on the task's message).
// The title has no button beside it, which would leave a gap under it.
function card({ task, link, incident, channel, ts }: TaskEntry, today: string, viewer: string, claim = false) {
  const title = `${incident ? ":rotating_light: " : ""}*<${link}|${escapeSlack(task.title)}>*`;
  const due = task.dueDate && (isOverdue(task, today) ? `:warning: *Overdue* ${task.dueDate}` : `Due ${task.dueDate}`);
  const details = [`${PRIORITIES[task.priority] ?? ""} ${task.priority}`.trim(), STATUSES[task.status], blockedLine(task), due].filter(Boolean).join("  ·  ");
  const people = peopleLine(task, viewer) || "_Unassigned_";
  if (claim) {
    return [
      { type: "section", text: mrkdwn(title) },
      { type: "context", elements: [mrkdwn(`${details}\n${people}`)] },
      { type: "actions", elements: [{ type: "button", action_id: `${CLAIM_ACTION}:${channel}:${ts}`, text: plainText("Assign to me") }] },
    ];
  }
  return [
    { type: "section", text: mrkdwn(title) },
    // The blank last line (a braille blank, as Slack trims plain ones) puts
    // a gap before the next card.
    { type: "context", elements: [mrkdwn(`${details}\n${people}\n\u2800`)] },
  ];
}

// Whether the task's due date has passed. An incident, due Immediate, never
// has.
function isOverdue(task: Task, today: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(task.dueDate ?? "");
  return Boolean(match) && `${match![3]}-${match![2]}-${match![1]}` < today;
}
