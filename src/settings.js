import { aiModel } from "./ai.js";
import { ensureWorkDoc, workDocId } from "./doc.js";
import { groupDisabled, groupEnabled, groupSetting, projects } from "./channels.js";
import { addProject, addedProjects, clearProjectSetting, projectSettings, setProjectSetting } from "./db.js";

// The project settings that can be changed in the form `/cade project settings` opens (see commands/project.js), each on or off.
// A project's name, channel and aiModel stay in cade.config.json. A setting changed on the page
// is kept in the database and wins over the config until it's put back (project_settings).
export const SETTINGS = [
  { key: "taskStatusChangeDetection", label: "Task status change detection", about: "Cade reads messages in task threads and offers, privately, to link a PR, assign someone or move the status." },
  { key: "newMessageTaskDetection", label: "New message task detection", about: "Cade asks where a message posted on its own in the channel belongs." },
  { key: "aiSuggestions", label: "AI suggestions", about: "Cade reads messages with AI to make those offers; the model is set in cade.config.json." },
  { key: "activeTasksPinning", label: "Active tasks pinning", about: "A message listing the open tasks is pinned in the channel until they're done." },
  { key: "summaryCanvas", label: "Summary canvas", about: "Each task's summary is kept in a Slack canvas as well." },
  { key: "aiAgentSummary", label: "AI agent summary prompt", about: "A task made from a message offers a prompt for the person's AI agent to summarize it." },
];

// What else a project keeps in the database besides those: its AI model and work doc, which
// aren't changed in the form but come with the project when it's imported from the config.
const IMPORTED = ["aiModel", "workDoc"];
const STORED = [...SETTINGS.map((setting) => setting.key), ...IMPORTED];

// The env with the projects added with `/cade project init` and the settings changed on the admin
// page merged into its projects, so the code that reads them (projects, groupSetting, …) needs no
// change. `PROJECTS_BASE` keeps what the config said. If they can't be read, the config alone is used.
export async function withSettings(env) {
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
    return { ...env, PROJECTS_BASE: env.PROJECTS ?? env.CHANNEL_PAIRS, PROJECTS: merged };
  } catch (error) {
    console.error("Could not read the project settings", { error: error.message });
    return env;
  }
}

// Whether `user` is one of the admins cade.config.json lists (`admins`, the Worker secret ADMINS),
// who can run `/cade project …` and open the settings form. Without a list, no one is.
export function isAdmin(env, user) {
  try {
    const admins = typeof env.ADMINS === "string" ? JSON.parse(env.ADMINS) : env.ADMINS;
    return Array.isArray(admins) && admins.includes(user);
  } catch {
    return false;
  }
}

// Whether `key` is on for the project with `channel`: true, false, or "some" when
// taskStatusChangeDetection names only some kinds of suggestion.
export function settingOn(env, channel, key) {
  switch (key) {
    case "taskStatusChangeDetection": {
      let kinds = groupSetting(env, channel, key);
      if (kinds === undefined) {
        try {
          kinds = env.TASK_STATUS_CHANGE_DETECTION === undefined ? true : JSON.parse(env.TASK_STATUS_CHANGE_DETECTION);
        } catch {
          return true;
        }
      }
      return kinds === true ? true : Array.isArray(kinds) && kinds.length ? "some" : false;
    }
    case "newMessageTaskDetection":
      return !groupDisabled(env, channel, key, "NEW_MESSAGE_TASK_DETECTION");
    case "aiAgentSummary":
      return !groupDisabled(env, channel, key, "AI_AGENT_SUMMARY");
    case "aiSuggestions":
      return aiModel(env, channel) !== null;
    case "activeTasksPinning":
      return groupEnabled(env, channel, key, "ACTIVE_TASKS_PINNING");
    case "summaryCanvas":
      return groupEnabled(env, channel, key, "SUMMARY_CANVAS");
    default:
      throw new Error(`${key} is not a setting`);
  }
}

// The env as the config alone has it, without the added projects and the settings changed here.
export const configEnv = (env) => ("PROJECTS_BASE" in env ? { ...env, PROJECTS: env.PROJECTS_BASE, CHANNEL_PAIRS: undefined } : env);

// The choice made for each setting of the project with `channel` now: "config", "on" or "off".
export async function choicesOf(env, channel) {
  const kept = new Map((await projectSettings(env)).filter((row) => row.channel === channel).map((row) => [row.key, row.value]));
  return Object.fromEntries(SETTINGS.map(({ key }) => [key, kept.has(key) ? (JSON.parse(kept.get(key)) ? "on" : "off") : "config"]));
}

// Applies `choices` ({ key: "config" | "on" | "off" }) to the project with `channel`, for `user`:
// "config" goes back to the config. Returns how many settings changed.
export async function applySettings(env, channel, choices, user) {
  const project = projects(env).find((candidate) => candidate.channel === channel);
  if (!project) return 0;
  const before = await choicesOf(env, channel);
  let changed = 0;
  for (const { key } of SETTINGS) {
    const choice = choices[key];
    if (!["config", "on", "off"].includes(choice) || choice === before[key]) continue;
    if (choice === "config") await clearProjectSetting(env, channel, key);
    else await setProjectSetting(env, channel, key, choice === "on", user);
    changed++;
    console.log("Project setting changed", { project: project.name, key, to: choice, by: user });
  }
  return changed;
}

// Copies the projects in cade.config.json into the database: each one's name and channel, and the
// settings, AI model and work doc it sets. One already in the database is left as it is. Each project
// ends up with a Google Doc: one without is given one now. Returns { moved, kept, docs, failed }:
// the names of those copied, of those already there, of those given a doc, and of those whose doc
// couldn't be made. Once they're in, the config's `projects` can go (`npm run config` then sets none).
export async function importProjects(env, user) {
  const present = new Set((await addedProjects(env)).map((project) => project.channel));
  const stored = new Set((await projectSettings(env)).map((row) => `${row.channel}|${row.key}`));
  const moved = [];
  const kept = [];
  const docs = [];
  const failed = [];
  // What the database holds now for each project, so a doc made earlier isn't made again.
  const merged = new Map(projects(env).map((project) => [project.channel, project]));
  for (const project of projects(configEnv(env))) {
    if (present.has(project.channel)) {
      kept.push(project.name);
    } else {
      await addProject(env, project.channel, project.name, user);
      for (const key of STORED) {
        if (project[key] !== undefined && !stored.has(`${project.channel}|${key}`)) await setProjectSetting(env, project.channel, key, project[key], user);
      }
      moved.push(project.name);
      console.log("Project imported", { name: project.name, channel: project.channel, by: user });
    }
    const current = { ...project, ...merged.get(project.channel) };
    if (workDocId(current)) continue;
    try {
      await ensureWorkDoc(env, current, user);
      docs.push(project.name);
    } catch (error) {
      console.error("Could not make a work doc", { name: project.name, error: error.message });
      failed.push(project.name);
    }
  }
  return { moved, kept, docs, failed };
}
