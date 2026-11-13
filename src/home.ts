import { channelMembers, isMember } from "./access.ts";
import { projects } from "./channels.ts";
import { getHomeProject, getHomeTab, setHomeTab, suggestionsOn } from "./db.ts";
import { nameMap } from "./export.ts";
import { byUrgency, groupTasks, OPEN, todayIn } from "./commands/tasks.ts";
import { formatTime } from "./format.ts";
import { MCP_ACTION, WEB_ACTION, mcpLine, webLine } from "./commands/configure.ts";
import { mcpEnabled } from "./mcp.ts";
import { SETTINGS, isAdmin, settingOn } from "./settings.ts";
import { callSlack, escapeSlack, mrkdwn, plainText } from "./slack.ts";
import { PRIORITIES, blockedLine, parentLine, peopleLine, ROLES, shownPeople, STATUSES } from "./tasks.ts";
import type { AppEnv } from "./env.ts";
import type { Project } from "./channels.ts";
import type { TaskEntry } from "./commands/tasks.ts";
import type { Role, SlackBlock, Status, Task } from "./types.ts";

type Tab = keyof typeof TABS;
// What the Home tab shows: a view of the tasks, or Settings.
export type HomeTab = Tab | typeof CONFIGURE;
type Section = { role: Role; emoji: string; title: string; ready: Status[]; empty: string };
// A card: a task, and the open subtasks shown under it. With `context`, the task isn't in the view
// itself, and is shown only for its subtasks that are, which are the only ones listed under it.
type Row = { entry: TaskEntry; subs: TaskEntry[]; context: boolean };

// The Home tab of Cade's app: what the person has open, by what they do on
// it, most urgent first. It is only another view of the tasks Cade already
// stores, drawn when they open it or press Refresh.

// What each role is doing, and the statuses in which the task is waiting on
// them. Tasks in a status before those are theirs but not yet, and are listed
// after the ones to act on, as Coming up; those past them they have handed
// over, and are listed once for all roles at the bottom, as Worked on.
const SECTIONS: Section[] = [
  { role: "owner", emoji: ":hammer_and_wrench:", title: "To work on", ready: ["TODO", "IN_PROGRESS"], empty: "Nothing to work on." },
  { role: "reviewer", emoji: ":eyes:", title: "To review", ready: ["IN_REVIEW"], empty: "Nothing to review." },
  { role: "tester", emoji: ":test_tube:", title: "To test", ready: ["IN_TESTING"], empty: "Nothing to test." },
];

// A view holds 100 blocks and each task takes two, so long lists are cut
// short.
const MAX_READY = 12;
const MAX_LATER = 5;

// The blank last line of a card (a braille blank, as Slack trims plain ones), for a gap before the next.
const GAP = "\n\u2800";

// The statuses in the order a task goes through them.
const ORDER = Object.keys(STATUSES) as Status[];

export const REFRESH_ACTION = "home:refresh";

// Assign to me, on an unassigned task's card. Each card's button has its own
// id, ending in the task's channel and thread, as a view can't repeat one.
export const CLAIM_ACTION = "home:claim";

// The project picker, which also remembers the choice (see db.ts). Its value
// is a project's name; with none chosen, or one that is gone, the first project is shown.
export const PROJECT_ACTION = "home:project";

// The two parts of the tab, as the buttons along the top: Home, the person's tasks, and Settings, with
// their own setup (see commands/configure.ts) and, for an admin, each project's settings. Which part is
// open isn't kept: the tab opens on tasks. Settings was called Configure, which its ids still say, so a
// Home tab drawn before then keeps working.
export const HOME_ACTION = "home:section:home";
export const CONFIGURE_ACTION = "home:section:configure";
export const CONFIGURE = "configure";
// The team member picker, on the By person view. Its value is their Slack user ID. The pick isn't kept:
// the view carries it (see publishHome), so Refresh and the project picker keep it, and the tab opens
// without one.
export const PERSON_ACTION = "home:person";

// Edit, under Projects in Settings: opens the picked project's settings form (see commands/project.ts).
export const SETTINGS_ACTION = "home:settings";
export const ADD_PROJECT_ACTION = "home:project:add";
// Turn off / Turn on, in Settings: the person's own suggestions (see suggestionsRow).
export const SUGGESTIONS_ACTION = "home:suggestions";

// The buttons along the top, each a view of the open tasks. Slack has no
// tabs in the Home tab, so a button draws the tab again with its view.
export const TABS = {
  mine: { action: "home:tab:mine", label: "My Tasks" },
  person: { action: "home:tab:person", label: "By person" },
  unassigned: { action: "home:tab:unassigned", label: "Unassigned" },
  all: { action: "home:tab:all", label: "All Tasks" },
};
const DEFAULT_TAB = "mine";

// The cards in the Unassigned and All Tasks views, two blocks each (three
// with the Assign to me button).
const MAX_LISTED = 20;

// The subtasks listed under a card.
const MAX_SUBS = 8;

// A view holds at most 100 blocks, and Slack refuses one with more. Cards are drawn while there is
// room (see card), keeping `left` for what follows them; those that don't fit are counted instead.
const MAX_BLOCKS = 100;
type Budget = { left: number };
// What the Your tasks view adds after its cards, at most: each section's divider, header, empty or
// "…and more" line and Coming up, then Worked on's divider, header and list, and the closing divider and Updated line.
const MINE_AFTER = SECTIONS.length * 4 + 5;
// The same for the Unassigned and All Tasks views: "…and more", the divider and Updated.
const LIST_AFTER = 3;

// The All Tasks view's sections, by where a task (or a subtask without its task open) is: its subtasks
// are shown under it whatever their own status.
const STAGES: { emoji: string; title: string; statuses: Status[]; empty: string }[] = [
  { emoji: ":arrow_forward:", title: "Working on", statuses: ["TODO", "IN_PROGRESS"], empty: "Nothing being worked on." },
  { emoji: ":eyes:", title: "In review", statuses: ["IN_REVIEW"], empty: "Nothing in review." },
  { emoji: ":test_tube:", title: "In testing", statuses: ["IN_TESTING"], empty: "Nothing in testing." },
  { emoji: ":raising_hand:", title: "Delivered", statuses: ["CLIENT_REVIEW"], empty: "Nothing delivered." },
];
// What the All Tasks view adds after its cards, at most: each section's divider, header and empty or
// "…and more" line, then the closing divider and Updated.
const ALL_AFTER = STAGES.length * 3 + 2;

// Draws `user`'s Home tab, on the `shown` view, whose tab is kept for next time, or on Settings, which
// isn't. With none, it opens on the tasks tab they were last on. `shown` is a tab, or on By person the
// tab and the picked person's ID, as "person:U123", which is what the view carries in its metadata and
// Refresh button: views drawn before By person carry only the tab.
export async function publishHome(env: AppEnv, user: string, shown?: string) {
  let [tab, person] = (shown ?? "").split(":");
  if (TABS[tab as Tab]) await setHomeTab(env, user, tab!);
  else if (tab !== CONFIGURE) tab = (await getHomeTab(env, user)) ?? DEFAULT_TAB;
  await callSlack(env, "views.publish", { user_id: user, view: await homeView(env, user, tab, person) });
}

// The view carries its tab (or Settings), and on By person who was picked, for the project picker to draw it again on.
export async function homeView(env: AppEnv, user: string, tab: string = DEFAULT_TAB, person?: string) {
  if (!TABS[tab as Tab] && tab !== CONFIGURE) tab = DEFAULT_TAB;
  const shown = tab === "person" && person ? `${tab}:${person}` : tab;
  return { ...(await draw(env, user, tab, shown, person)), private_metadata: shown };
}

async function draw(env: AppEnv, user: string, tab: string, shown: string, picked?: string) {
  const { url, user_id: bot } = await callSlack(env, "auth.test", {});
  const all = projects(env);
  // Home shows only the projects whose channel the person is in, as everywhere else (see readableName
  // in access.ts). Admins manage every project in Settings.
  const yours = await projectsOf(env, user, all);
  // The person's last project, unless it is gone or theirs no more: then the first.
  const chosen = await getHomeProject(env, user);
  const pick = (from: Project[]) => from.find((group) => group.name === chosen) ?? from[0];
  const project = pick(yours);
  const admin = isAdmin(env, user);
  // The two parts of the tab, with Refresh, along the top of both, and a line under them.
  const navRow: SlackBlock = {
    type: "actions",
    elements: [
      { type: "button", action_id: HOME_ACTION, text: plainText("Home"), ...(tab !== CONFIGURE && { style: "primary" }) },
      { type: "button", action_id: CONFIGURE_ACTION, text: plainText("Settings"), ...(tab === CONFIGURE && { style: "primary" }) },
      { type: "button", action_id: REFRESH_ACTION, text: plainText("Refresh"), value: shown },
    ],
  };
  const nav: SlackBlock[] = [navRow, { type: "divider" }];
  if (tab === CONFIGURE) return await settingsView(env, user, nav, all, yours, pick(all));
  const addProject = { type: "button", action_id: ADD_PROJECT_ACTION, text: plainText("Add project") };
  if (!project) {
    const none = all.length ? "You aren't in any project's channel yet. Join one to see its tasks here." : "There are no projects yet.";
    return {
      type: "home",
      blocks: [...nav, admin ? { type: "section", text: mrkdwn(none), accessory: addProject } : { type: "context", elements: [mrkdwn(`_${none} An admin adds one on this tab._`)] }],
    };
  }
  // On Home, under the two parts: which project's tasks are shown, and (for an admin) Add project, then the task tabs.
  const top: SlackBlock[] = [...nav, { type: "actions", elements: [projectPicker(yours, project), ...(admin ? [addProject] : [])] }];
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
  if (tab === "mine") return tasksOf(env, [...top, tabRow], open, today, user, user, "Your tasks");
  if (tab === "person") return await personView(env, [...top, tabRow], project, open, today, user, bot, picked);
  return listView(env, tab, top, tabRow, open, today, user);
}

// The By person view: a picker of the project's people, then the `picked` one's tasks as My Tasks shows
// the viewer's own. With no one picked, or someone not in the channel (as after switching project), it
// asks for a pick. The people are those in the project's channel but Cade itself, by name.
async function personView(env: AppEnv, top: SlackBlock[], project: Project, open: TaskEntry[], today: string, viewer: string, bot: string, picked?: string) {
  let members: string[];
  try {
    members = (await channelMembers(env, project.channel)).filter((id) => id !== bot);
  } catch (error) {
    console.warn("Could not read the channel's members", { channel: project.channel, error: error.message });
    return { type: "home", blocks: [...top, { type: "context", elements: [mrkdwn("_I couldn't read who is in the project's channel just now. Press Refresh to try again._")] }] };
  }
  const names = await nameMap(env, members);
  const people = members.map((id) => ({ id, name: names.get(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
  const person = people.find(({ id }) => id === picked);
  const options = people.map(({ id, name }) => ({ text: plainText(name.slice(0, 75)), value: id }));
  const picker: SlackBlock = {
    type: "actions",
    elements: [
      {
        type: "static_select",
        action_id: PERSON_ACTION,
        placeholder: plainText("Team member"),
        options,
        ...(person && { initial_option: options[people.indexOf(person)] }),
      },
    ],
  };
  if (!people.length) return { type: "home", blocks: [...top, { type: "context", elements: [mrkdwn("_No one is in the project's channel yet._")] }] };
  if (!person) return { type: "home", blocks: [...top, picker, { type: "context", elements: [mrkdwn("_Pick a team member to see their tasks._")] }] };
  return tasksOf(env, [...top, picker], open, today, person.id, viewer, person.id === viewer ? "Your tasks" : `${person.name}'s tasks`.slice(0, 150));
}

// `person`'s tasks, as `viewer` sees them, under `top` and headed `title`: a section for each thing they
// do on a task, most urgent first, with what is coming up under each, then what they have worked on.
function tasksOf(env: AppEnv, top: SlackBlock[], open: TaskEntry[], today: string, person: string, viewer: string, title: string) {
  // A subtask with no owner of its own is its task's owners' (see shownPeople).
  const has = (entry: TaskEntry, role: Role) => shownPeople(entry.task)[role].includes(person);
  const entries = open.filter((entry) => (Object.keys(ROLES) as Role[]).some((role) => has(entry, role)));

  // A subtask of theirs brings its parent along, as the card it is shown under, and a task of theirs
  // brings all its subtasks. A card is ready to act on when anything on it is: a task in testing is,
  // while issues found in it are being fixed.
  // A card not ready yet is coming up while anything on it is still before the role's turn, and handed
  // over once all of it is past it.
  const sections = SECTIONS.map((section) => {
    const theirs = sorted(cards(open, (entry) => has(entry, section.role)));
    const onCard = (row: Row) => (row.context ? row.subs : [row.entry, ...row.subs]);
    const ready = (row: Row) => onCard(row).some((entry) => section.ready.includes(entry.task.status));
    const turn = Math.min(...section.ready.map((status) => ORDER.indexOf(status)));
    const before = (row: Row) => onCard(row).some((entry) => ORDER.indexOf(entry.task.status) < turn);
    const notReady = theirs.filter((row) => !ready(row));
    return { ...section, ready: theirs.filter(ready), later: notReady.filter(before), handed: notReady.filter((row) => !before(row)) };
  });
  const workedOn = handedOver(sections);
  const overdue = new Set(entries.filter((entry) => isOverdue(entry.task, today)).map((entry) => entry.ts + entry.channel));

  const waiting = sections.reduce((sum, section) => sum + section.ready.length, 0);
  const self = person === viewer;
  const summary = waiting
    ? `*${waiting}* waiting on ${self ? "you" : `<@${person}>`}${overdue.size ? `  ·  :warning: *${overdue.size}* overdue` : ""}`
    : `${self ? "You're" : `<@${person}> is`} all caught up :tada:`;

  const blocks: SlackBlock[] = [...top, { type: "header", text: plainText(title) }, { type: "context", elements: [mrkdwn(summary)] }];
  const budget = { left: MAX_BLOCKS - blocks.length - MINE_AFTER };
  for (const section of sections) {
    blocks.push(...divider(blocks));
    blocks.push({ type: "header", text: { type: "plain_text", text: `${section.emoji} ${section.title} (${section.ready.length})`, emoji: true } });
    blocks.push(...list(section, today, viewer, budget, self ? "Your subtasks" : "Their subtasks"));
  }
  blocks.push(...divider(blocks));
  blocks.push({ type: "header", text: { type: "plain_text", text: `:outbox_tray: Worked on (${workedOn.length})`, emoji: true } });
  blocks.push({ type: "context", elements: [mrkdwn(workedOn.length ? smallLines(workedOn).join("\n") : "_Nothing handed over yet._")] });
  blocks.push(...divider(blocks));
  blocks.push({ type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// The projects whose channel `user` is in, in the same order, asked about all at once.
async function projectsOf(env: AppEnv, user: string, all: Project[]) {
  const inIt = await Promise.all(
    all.map((project) =>
      isMember(env, project.channel, user).catch((error) => {
        console.warn("Could not check the channel's members", { channel: project.channel, error: error.message });
        return false;
      }),
    ),
  );
  return all.filter((_, i) => inIt[i]);
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

// The Settings part: the whole picture without a click, a section for each setup with how it stands
// now and a button to change it, in two groups. Just for you is the person's own, the same in every
// project: AI agent says so when MCP is turned off, and has no button then. Projects is for admins
// only: a picker of every project, whether or not the admin is in its channel (the same choice as on
// Home), then that project's channel and switches, with Edit to change them in a form.
async function settingsView(env: AppEnv, user: string, nav: SlackBlock[], all: Project[], yours: Project[], project: Project | undefined) {
  const row = (title: string, now: string, action: string | false, label: string, value?: string) => ({
    type: "section",
    text: mrkdwn(`*${title}*\n${now}`),
    ...(action && { accessory: { type: "button", action_id: action, text: plainText(label), ...(value && { value }) } }),
  });
  const blocks: SlackBlock[] = [
    ...nav,
    { type: "header", text: plainText("Just for you") },
    row("Web pages", `${await webLine(env, user)}\nThe thread and notes pages that task cards link to.`, WEB_ACTION, "Manage"),
    row("AI agent", `${await mcpLine(env, user)}\nYour own AI agent, connected to Cade.`, mcpEnabled(env) && MCP_ACTION, "Manage"),
    await suggestionsRow(env, user, yours),
  ];
  if (isAdmin(env, user)) {
    blocks.push({ type: "divider" }, { type: "header", text: plainText("Projects") });
    if (project) {
      const switches = SETTINGS.map(({ key, label }) => `${label}: ${stateOf(settingOn(env, project.channel, key))}`).join("  ·  ");
      blocks.push({ type: "actions", elements: [projectPicker(all, project)] }, row("Project settings", `*${project.name}* in <#${project.channel}>\n${switches}`, SETTINGS_ACTION, "Edit", project.channel));
    } else {
      blocks.push({ type: "context", elements: [mrkdwn("_There are no projects yet. Add one with Add project on Home._")] });
    }
  }
  blocks.push({ type: "divider" }, { type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// The person's own switch for the suggestions Cade offers them from their messages in task threads
// (see suggest.ts). It can only turn them off for them: the projects where an admin has them off for
// everyone are named too, as the switch is the same wherever they write.
async function suggestionsRow(env: AppEnv, user: string, all: Project[]) {
  const on = await suggestionsOn(env, user);
  const now = on
    ? ":white_check_mark: On. Cade privately offers to update a task from what you write in its thread."
    : ":x: Off for you. Cade won't offer to update a task from your messages, so update it yourself.";
  const off = all.filter((candidate) => settingOn(env, candidate.channel, "taskChangeDetection") === false).map((candidate) => `*${escapeSlack(candidate.name)}*`);
  const projectOff = off.length ? `\n_Turned off for everyone by an admin in ${off.join(", ")}._` : "";
  return {
    type: "section",
    text: mrkdwn(`*Suggestions*\n${now}${projectOff}`),
    accessory: { type: "button", action_id: SUGGESTIONS_ACTION, text: plainText(on ? "Turn off" : "Turn on"), value: JSON.stringify({ on: !on }) },
  };
}

const stateOf = (on: boolean | "some") => (on === "some" ? "partly on" : on ? "on" : "off");

// The open entries that `matches`, as cards: a task with all its open subtasks under it, and a
// subtask that matches whose parent doesn't under its parent, shown for it (`context`). A subtask
// whose parent isn't open has a card of its own.
function cards(open: TaskEntry[], matches: (entry: TaskEntry) => boolean): Row[] {
  const byTs = new Map(open.map((entry) => [entry.ts, entry]));
  const parentOf = (entry: TaskEntry) => (entry.task.parent ? byTs.get(entry.task.parent.ts) : undefined);
  const found = new Map<string, Row>();
  for (const entry of open) {
    if (parentOf(entry) || !matches(entry)) continue;
    found.set(entry.ts, { entry, subs: open.filter((other) => parentOf(other) === entry), context: false });
  }
  for (const entry of open) {
    const parent = parentOf(entry);
    if (!parent || !matches(entry) || found.get(parent.ts)?.context === false) continue;
    const row = found.get(parent.ts) ?? { entry: parent, subs: [], context: true };
    row.subs.push(entry);
    found.set(parent.ts, row);
  }
  return [...found.values()];
}

// What a card is sorted by: its task, or, shown for its subtasks, the most urgent of them.
const lead = (row: Row) => (row.context ? [...row.subs].sort(byUrgency)[0]! : row.entry);

// Cards most urgent first, each with its subtasks most urgent first.
function sorted(rows: Row[]) {
  for (const row of rows) row.subs.sort(byUrgency);
  return rows.sort((a, b) => byUrgency(lead(a), lead(b)));
}

// A task with no one on it. Only tasks are listed as unassigned, not subtasks: they are parts of a
// task, and whoever takes the task takes them, unless someone else is given one.
const unassignedTask = ({ task }: TaskEntry) => !task.parent && !(Object.keys(ROLES) as Role[]).some((role) => task.people[role].length);

// The Unassigned and All Tasks views: the open tasks as cards, most urgent
// first, with their subtasks under them. Unassigned ones have an Assign to me button there, and only there.
// All Tasks splits them into sections by status (see STAGES).
function listView(env: AppEnv, tab: string, top: SlackBlock[], tabRow: SlackBlock, open: TaskEntry[], today: string, user: string) {
  const unassigned = tab === "unassigned";
  const entries = sorted(cards(open, unassigned ? unassignedTask : () => true));
  const blocks: SlackBlock[] = [
    ...top,
    tabRow,
    { type: "header", text: plainText(unassigned ? "Unassigned tasks" : "All open tasks") },
    { type: "context", elements: [mrkdwn(`*${entries.length}* open`)] },
  ];
  if (!unassigned) return allView(env, blocks, entries, today, user);
  blocks.push(...divider(blocks));
  if (!entries.length) blocks.push({ type: "context", elements: [mrkdwn(`_${unassigned ? "Everything open has someone on it." : "Nothing is open."}_`)] });
  const shown = drawn(entries.slice(0, MAX_LISTED), { left: MAX_BLOCKS - blocks.length - LIST_AFTER }, (row, budget) => card(row, today, user, budget, { claim: unassigned }));
  blocks.push(...shown.blocks);
  if (entries.length > shown.count) {
    blocks.push({ type: "context", elements: [mrkdwn(`_…and ${entries.length - shown.count} more._`)] });
  }
  blocks.push(...divider(blocks));
  blocks.push({ type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// The All Tasks view, after `blocks`: the cards in a section for each stage, most urgent first.
function allView(env: AppEnv, blocks: SlackBlock[], rows: Row[], today: string, user: string) {
  const budget = { left: MAX_BLOCKS - blocks.length - ALL_AFTER };
  for (const stage of STAGES) {
    const inStage = rows.filter((row) => stage.statuses.includes(row.entry.task.status));
    blocks.push(...divider(blocks));
    blocks.push({ type: "header", text: { type: "plain_text", text: `${stage.emoji} ${stage.title} (${inStage.length})`, emoji: true } });
    if (!inStage.length) blocks.push({ type: "context", elements: [mrkdwn(`_${stage.empty}_`)] });
    const shown = drawn(inStage.slice(0, MAX_LISTED), budget, (row, room) => card(row, today, user, room));
    blocks.push(...shown.blocks);
    if (inStage.length > shown.count) blocks.push({ type: "context", elements: [mrkdwn(`_…and ${inStage.length - shown.count} more._`)] });
  }
  blocks.push(...divider(blocks));
  blocks.push({ type: "context", elements: [mrkdwn(`Updated ${formatTime(env, new Date())}`)] });
  return { type: "home", blocks };
}

// A section's tasks: those waiting on the person as cards, most urgent
// first, then the rest as small lines.
function list({ ready, later, empty }: { ready: Row[]; later: Row[]; empty: string }, today: string, user: string, budget: Budget, label: string) {
  const blocks: SlackBlock[] = [];
  if (!ready.length) blocks.push({ type: "context", elements: [mrkdwn(`_${empty}_`)] });
  const shown = drawn(ready.slice(0, MAX_READY), budget, (row, room) => card(row, today, user, room, { label }));
  blocks.push(...shown.blocks);
  if (ready.length > shown.count) {
    blocks.push({ type: "context", elements: [mrkdwn(`_…and ${ready.length - shown.count} more._`)] });
  }
  if (later.length) blocks.push({ type: "context", elements: [mrkdwn(`*Coming up*\n${smallLines(later.map((row) => ({ row, roles: [] }))).join("\n")}`)] });
  return blocks;
}

// The cards each section's role has handed over, each once, with every role it was the person's in,
// most urgent first.
function handedOver(sections: { role: Role; handed: Row[] }[]) {
  const found = new Map<string, { row: Row; roles: Role[] }>();
  for (const { role, handed } of sections) {
    for (const row of handed) {
      const key = row.entry.channel + row.entry.ts;
      const seen = found.get(key);
      if (seen) seen.roles.push(role);
      else found.set(key, { row, roles: [role] });
    }
  }
  return [...found.values()].sort((a, b) => byUrgency(lead(a.row), lead(b.row)));
}

// Cards as small lines, for Coming up and Worked on: each task, with the subtasks its card shows under
// it, its status, and, given any, the roles it was the person's in.
function smallLines(rows: { row: Row; roles: Role[] }[]) {
  const all = rows.flatMap(({ row, roles }) => [row.entry, ...row.subs].map((entry, i) => ({ entry, under: i > 0, roles: i ? [] : roles })));
  const lines = all.slice(0, MAX_LATER).map(({ entry: { task, link }, under, roles }) => {
    const as = roles.length ? `  ·  _${roles.map((role) => ROLES[role]).join(", ")}_` : "";
    return `${under ? ":arrow_right_hook: " : ""}<${link}|${escapeSlack(task.title)}>  ·  ${STATUSES[task.status]}${as}`;
  });
  if (all.length > MAX_LATER) lines.push(`_…and ${all.length - MAX_LATER} more._`);
  return lines;
}

// A divider, to push after `blocks`. A card ends with a blank line, as a gap before what follows it
// (see card): another card, Coming up or "…and more". Before a divider it would only leave room, so it goes.
function divider(blocks: SlackBlock[]): SlackBlock[] {
  const last = blocks.at(-1);
  const text = last?.type === "context" ? (last.elements as { text: string }[])[0]!.text : "";
  if (last && text.endsWith(GAP)) last.elements = [mrkdwn(text.slice(0, -GAP.length))];
  return [{ type: "divider" }];
}

// The cards of `rows` that fit in `budget`, drawn with `draw`, in order, stopping at the first that
// doesn't: their blocks, and how many were drawn.
function drawn(rows: Row[], budget: Budget, draw: (row: Row, budget: Budget) => SlackBlock[] | null) {
  const blocks: SlackBlock[] = [];
  let count = 0;
  for (const row of rows) {
    const card = draw(row, budget);
    if (!card) break;
    blocks.push(...card);
    count++;
  }
  return { blocks, count };
}

// A task as a card: its title, linking to its thread, then in the smaller type of a context block its
// priority, status and due date, and below them its owner, reviewers and testers (as on the task's
// message). Its subtasks follow, each a card of the same shape with ↪ before its title. A card shown
// only for its subtasks heads them with `label`; one with all its subtasks says how many are done. A
// subtask with a card of its own names its parent. The title has no button beside it, which would
// leave a gap under it. With `claim`, an Assign to me button follows the task.
//
// It takes its blocks from `budget`, as many subtasks as fit, the rest counted, or none at all, and
// gives null, when even the task doesn't fit.
function card({ entry, subs, context }: Row, today: string, viewer: string, budget: Budget, { claim = false, label = "" }: { claim?: boolean; label?: string } = {}) {
  const { task, channel } = entry;
  const closed = context ? 0 : task.subtaskCounts?.closed ?? 0;
  const own = [
    ...taskBlocks(entry, today, viewer, { lines: [task.parent && !subs.length && !context ? parentLine(task.parent) : "", context && subs.length ? `_${label}:_` : ""] }),
    ...(claim && !context ? [{ type: "actions", elements: [{ type: "button", action_id: `${CLAIM_ACTION}:${channel}:${entry.ts}`, text: plainText("Assign to me") }] }] : []),
  ];
  // A line after the subtasks, saying how many more there are and how many are done, when any.
  const after = (shown: number) => [subs.length > shown ? `_…and ${subs.length - shown} more subtasks._` : "", closed ? `_+${closed} done_` : ""].filter(Boolean);
  if (own.length + (after(0).length ? 1 : 0) > budget.left) return null;
  budget.left -= own.length;
  const blocks: SlackBlock[] = [...own];
  let shown = 0;
  for (const sub of subs.slice(0, MAX_SUBS)) {
    // Room for the line after, if one will follow.
    const after = subs.length > shown + 1 || closed ? 1 : 0;
    const subBlocks = taskBlocks(sub, today, viewer, { sub: true });
    if (subBlocks.length + after > budget.left) break;
    budget.left -= subBlocks.length;
    blocks.push(...subBlocks);
    shown++;
  }
  const footer = after(shown);
  if (footer.length) {
    budget.left -= 1;
    blocks.push({ type: "context", elements: [mrkdwn(footer.join("\n"))] });
  }
  // The blank last line (a braille blank, as Slack trims plain ones) puts a gap before the next card.
  const last = blocks.at(-1)!;
  if (last.type === "context") last.elements = [mrkdwn(`${(last.elements as { text: string }[])[0]!.text}${GAP}`)];
  return blocks;
}

// A task's own two blocks on a card: its title, led by ↪ for a subtask, then its details and people,
// with `lines` added under them, if any. The same three lines list the subtasks in their modal (see
// subtask.ts), where a task posted before it had a link has none.
export function taskBlocks({ task, link, incident }: Pick<TaskEntry, "task" | "incident"> & { link?: string }, today: string, viewer?: string, { sub = false, lines = [] }: { sub?: boolean; lines?: string[] } = {}): SlackBlock[] {
  const name = escapeSlack(task.title);
  const title = `${sub ? ":arrow_right_hook: " : ""}${incident ? "[Incident] " : ""}*${link ? `<${link}|${name}>` : name}*`;
  const details = [`${PRIORITIES[task.priority] ?? ""} ${task.priority}`.trim(), STATUSES[task.status], blockedLine(task), due(task, today)].filter(Boolean).join("  ·  ");
  const people = peopleLine({ people: shownPeople(task) }, viewer) || "_Unassigned_";
  const text = [lines[0], details, people, ...lines.slice(1)].filter(Boolean).join("\n");
  return [
    { type: "section", text: mrkdwn(title) },
    { type: "context", elements: [mrkdwn(text)] },
  ];
}

// The due date, marked when it has passed, or "" for none.
function due(task: Task, today: string) {
  return task.dueDate ? (isOverdue(task, today) ? `:warning: *Overdue* ${task.dueDate}` : `Due ${task.dueDate}`) : "";
}

// Whether the task's due date has passed. An incident, due Immediate, never
// has.
function isOverdue(task: Task, today: string) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(task.dueDate ?? "");
  return Boolean(match) && `${match![3]}-${match![2]}-${match![1]}` < today;
}
