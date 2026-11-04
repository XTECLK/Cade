import { aiModel } from "./ai.js";
import { groupDisabled, groupEnabled, groupSetting, projects } from "./channels.js";
import { addedProjects, projectSettings } from "./db.js";

// The project settings that can be changed on the admin page (see admin.js), each on or off.
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

// The env with the projects added with `/cade project init` and the settings changed on the admin
// page merged into its projects, so the code that reads them (projects, groupSetting, …) needs no
// change. `PROJECTS_BASE` keeps what the config said. If they can't be read, the config alone is used.
export async function withSettings(env) {
  try {
    const [rows, added] = await Promise.all([projectSettings(env), addedProjects(env)]);
    if (!rows.length && !added.length) return env;
    const keys = SETTINGS.map((setting) => setting.key);
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
// who can run `/cade project …` and open the projects page. Without a list, no one is.
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
