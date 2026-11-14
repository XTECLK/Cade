import { groupDisabled, groupEnabled, groupSetting, projects } from "./channels.ts";
import { addedProjects, clearProjectSetting, projectSettings, setProjectSetting } from "./db.ts";
import type { AppEnv } from "./env.ts";

export type SettingKey = "taskChangeDetection" | "newTaskDetection" | "summaryCanvas";
export type SettingChoice = "config" | "on" | "off";

// The project settings that can be changed in the form Edit opens, under Projects in Settings on the Home tab (see commands/project.ts), each on or off.
// A project's name and channel stay as they were set, and the AI model is `aiModel` in cade.config.json. A setting changed on the page
// is kept in the database and wins over the config until it's put back (project_settings).
export const SETTINGS: { key: SettingKey; label: string; about: string }[] = [
  { key: "taskChangeDetection", label: "Task change detection", about: "Cade reads messages in task threads with AI, links pasted PRs, and offers, privately, to assign someone, move the status or mark it blocked." },
  { key: "newTaskDetection", label: "New task detection", about: "Cade asks where a message posted on its own in the channel belongs." },
  { key: "summaryCanvas", label: "Summary canvas", about: "The channel's canvas holds a table of its tasks, kept up to date." },
];

// What a project keeps in the database. Who works on a project isn't kept: it is whoever is in its
// channel (see channelMembers in access.ts).
const STORED: string[] = SETTINGS.map((setting) => setting.key);

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

// What someone who isn't an admin is told when they try an admin's command.
export const ADMINS_ONLY = "Only Cade's admins can do that.";

// Whether `user` is one of the admins cade.config.json lists (`admins`, the Worker secret ADMINS),
// who can add projects, open the settings form and use the admin commands. Without a list, no one is.
// The one check for all of these.
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
