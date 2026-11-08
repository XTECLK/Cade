import { groupDisabled, groupEnabled, groupSetting, projects } from "./channels.ts";
import { addedProjects, clearProjectSetting, projectSettings, setProjectSetting } from "./db.ts";
import type { AppEnv } from "./env.ts";

export type SettingKey = "taskChangeDetection" | "newTaskDetection" | "activeTasksPinning" | "summaryCanvas" | "aiAgentSummary";
export type SettingChoice = "config" | "on" | "off";

// The project settings that can be changed in the form Edit opens, under Projects in Settings on the Home tab (see commands/project.ts), each on or off.
// A project's name and channel stay as they were set, and the AI model is `aiModel` in cade.config.json. A setting changed on the page
// is kept in the database and wins over the config until it's put back (project_settings).
export const SETTINGS: { key: SettingKey; label: string; about: string }[] = [
  { key: "taskChangeDetection", label: "Task change detection", about: "Cade reads messages in task threads with AI and offers, privately, to link a PR, assign someone, move the status or mark it blocked." },
  { key: "newTaskDetection", label: "New task detection", about: "Cade asks where a message posted on its own in the channel belongs." },
  { key: "activeTasksPinning", label: "Active tasks pinning", about: "A message listing the open tasks is pinned in the channel until they're done." },
  { key: "summaryCanvas", label: "Summary canvas", about: "Each task's summary is kept in a Slack canvas as well." },
  { key: "aiAgentSummary", label: "AI agent summary prompt", about: "A task made from a message offers a prompt for the person's AI agent to summarize it." },
];

// What else a project keeps in the database besides those: its work doc, which isn't changed in the
// form (the Add project button makes it).
const STORED: string[] = [...SETTINGS.map((setting) => setting.key), "workDoc", "members"];

// The people who work on a project, as Slack user IDs: picked in the settings form, or listed as `members` in
// cade.config.json. Empty means none were picked, and availability then looks at the whole workspace.
export function projectMembers(env: AppEnv, channel: string): string[] {
  const members = projects(env).find((project) => project.channel === channel)?.members;
  return Array.isArray(members) ? members.filter((id) => typeof id === "string") : [];
}

// Keeps `members` as the people of the project with `channel` (none puts it back to the config). Returns whether it changed.
export async function applyMembers(env: AppEnv, channel: string, members: unknown, user: string) {
  const project = projects(env).find((candidate) => candidate.channel === channel);
  if (!project || !Array.isArray(members)) return false;
  const next = [...new Set(members)].sort();
  if (next.join() === [...projectMembers(env, channel)].sort().join()) return false;
  if (next.length) await setProjectSetting(env, channel, "members", next, user);
  else await clearProjectSetting(env, channel, "members");
  console.log("Project members changed", { project: project.name, count: next.length, by: user });
  return true;
}

// The env with the projects added with the Add project button and the settings changed on the admin
// page merged into its projects, so the code that reads them (projects, groupSetting, …) needs no
// change. `PROJECTS_BASE` keeps what the config said. If they can't be read, the config alone is used.
export async function withSettings(env: AppEnv): Promise<AppEnv> {
  try {
    const [rows, added] = await Promise.all([projectSettings(env), addedProjects(env)]);
    if (!rows.length && !added.length) return env;
    const keys = STORED;
    const configured = projects(env);
    const known = new Set(configured.map((project) => project.channel));
    const merged = [...configured, ...added.filter((project) => !known.has(project.channel)).map((project) => ({ ...project, added: true }))].map((project) => ({
      ...project,
      ...Object.fromEntries(rows.filter((row) => row.channel === project.channel && keys.includes(row.key)).map((row) => [row.key, JSON.parse(row.value)])),
    }));
    return { ...env, PROJECTS_BASE: env.PROJECTS, PROJECTS: merged };
  } catch (error) {
    console.error("Could not read the project settings", { error: error.message });
    return env;
  }
}

// Whether `user` is one of the admins cade.config.json lists (`admins`, the Worker secret ADMINS),
// who can add projects and open the settings form. Without a list, no one is.
export function isAdmin(env: AppEnv, user: string) {
  try {
    const admins = typeof env.ADMINS === "string" ? JSON.parse(env.ADMINS) : env.ADMINS;
    return Array.isArray(admins) && admins.includes(user);
  } catch {
    return false;
  }
}

// Whether `key` is on for the project with `channel`: true, false, or "some" when
// taskChangeDetection names only some kinds of suggestion.
export function settingOn(env: AppEnv, channel: string | undefined, key: SettingKey): boolean | "some" {
  switch (key) {
    case "taskChangeDetection": {
      let kinds = groupSetting(env, channel, key);
      if (kinds === undefined) {
        try {
          kinds = env.TASK_CHANGE_DETECTION === undefined ? true : JSON.parse(env.TASK_CHANGE_DETECTION);
        } catch {
          return true;
        }
      }
      return kinds === true ? true : Array.isArray(kinds) && kinds.length ? "some" : false;
    }
    case "newTaskDetection":
      return !groupDisabled(env, channel, key, "NEW_TASK_DETECTION");
    case "aiAgentSummary":
      return !groupDisabled(env, channel, key, "AI_AGENT_SUMMARY");
    case "activeTasksPinning":
      return groupEnabled(env, channel, key, "ACTIVE_TASKS_PINNING");
    case "summaryCanvas":
      return groupEnabled(env, channel, key, "SUMMARY_CANVAS");
    default:
      throw new Error(`${key} is not a setting`);
  }
}

// The env as the config alone has it, without the added projects and the settings changed here.
export const configEnv = (env: AppEnv): AppEnv => ("PROJECTS_BASE" in env ? { ...env, PROJECTS: env.PROJECTS_BASE } : env);

// The choice made for each setting of the project with `channel` now: "config", "on" or "off".
export async function choicesOf(env: AppEnv, channel: string): Promise<Record<SettingKey, SettingChoice>> {
  const kept = new Map((await projectSettings(env)).filter((row) => row.channel === channel).map((row) => [row.key, row.value]));
  return Object.fromEntries(SETTINGS.map(({ key }) => [key, kept.has(key) ? (JSON.parse(kept.get(key)!) ? "on" : "off") : "config"])) as Record<SettingKey, SettingChoice>;
}

// Applies `choices` ({ key: "config" | "on" | "off" }) to the project with `channel`, for `user`:
// "config" goes back to the config. Returns how many settings changed.
export async function applySettings(env: AppEnv, channel: string, choices: Record<string, string | undefined>, user: string) {
  const project = projects(env).find((candidate) => candidate.channel === channel);
  if (!project) return 0;
  const before = await choicesOf(env, channel);
  let changed = 0;
  for (const { key } of SETTINGS) {
    const choice = choices[key];
    if (!["config", "on", "off"].includes(choice!) || choice === before[key]) continue;
    if (choice === "config") await clearProjectSetting(env, channel, key);
    else await setProjectSetting(env, channel, key, choice === "on", user);
    changed++;
    console.log("Project setting changed", { project: project.name, key, to: choice, by: user });
  }
  return changed;
}
