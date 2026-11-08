import type { AppEnv, FeatureSecret } from "./env.ts";

// A project as PROJECTS lists it, with what the settings form and the Add
// project button keep in the database merged in (see withSettings).
export interface Project {
  name: string;
  channel: string;
  // Whether it was added with the Add project button, not the config.
  added?: boolean;
  workDoc?: string;
  // true, false, or the kinds of suggestion to make (see intents.ts).
  taskChangeDetection?: boolean | string[];
  newTaskDetection?: boolean;
  activeTasksPinning?: boolean;
  summaryCanvas?: boolean;
  aiAgentSummary?: boolean;
  [key: string]: unknown;
}

// PROJECTS names each project's channel, where the team tracks its work,
// incidents included. Several projects can run side by side, such as the real
// channel and a test channel.
const ROLES = ["channel"] as const;
type ChannelRole = (typeof ROLES)[number];

// It is a Worker secret, so a JSON string; a list also works, as tests and
// [vars] in wrangler.toml give it.
export function projects(env: Pick<AppEnv, "PROJECTS">): Project[] {
  const raw = env.PROJECTS;
  // None in the config is fine: projects can be kept in the database (see settings.ts).
  if (raw === undefined) return [];
  const list = typeof raw === "string" ? parseProjects(raw) : raw;
  if (!Array.isArray(list) || list.some((project) => !project?.name || !project.channel)) {
    throw new Error("PROJECTS must list { name, channel } for each project");
  }
  return list;
}

function parseProjects(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("PROJECTS is not valid JSON");
  }
}

// Returns every channel ID with the given role: "channel".
export function channelsWithRole(env: Pick<AppEnv, "PROJECTS">, role: ChannelRole) {
  return projects(env)
    .map((project) => project[role])
    .filter(Boolean);
}

// Returns the project that `channel` belongs to, or undefined when it is in
// none.
export function findProject(env: Pick<AppEnv, "PROJECTS">, channel: string | undefined) {
  return projects(env).find((project) => ROLES.some((role) => project[role] === channel));
}

// Like findProject, for channels that must be in a project.
export function projectFor(env: Pick<AppEnv, "PROJECTS">, channel: string) {
  const project = findProject(env, channel);
  if (!project) throw new Error(`${channel} is not in PROJECTS`);
  return project;
}

// The project's own setting `key`, such as `taskChangeDetection`, for `channel`, or undefined
// when it has none, or `channel` is in no project, so the setting for every
// project applies (see suggesting in intents.ts and aiModel in ai.ts).
export function groupSetting<K extends string>(env: Pick<AppEnv, "PROJECTS">, channel: string | undefined | null, key: K): Project[K] | undefined {
  if (!channel) return undefined;
  try {
    return findProject(env, channel)?.[key];
  } catch {
    return undefined;
  }
}

// The project channel something started in `channel` is for, to choose on its form to begin with:
// `channel` itself if it is a project's, or the only project's; undefined when there's a choice to
// make.
export function knownProject(env: Pick<AppEnv, "PROJECTS">, channel: string) {
  if (roleOf(env, channel) === "channel") return channel;
  const all = projects(env);
  return all.length === 1 ? all[0]!.channel : undefined;
}

// Returns the role `channel` has in its project, or undefined when it is in none.
export function roleOf(env: Pick<AppEnv, "PROJECTS">, channel: string) {
  const project = findProject(env, channel);
  return project && ROLES.find((role) => project[role] === channel);
}


// Whether a feature that is off unless turned on is on for `channel`: the
// project's own `key` (true or false), or else the Worker secret `secret`
// ("on" turns it on) for every project. See `activeTasksPinning` and `summaryCanvas` in
// scripts/config.ts.
export function groupEnabled(env: Pick<AppEnv, "PROJECTS" | FeatureSecret>, channel: string | undefined | null, key: string, secret: FeatureSecret) {
  return (groupSetting(env, channel, key) ?? env[secret] === "on") as boolean;
}

// Like groupEnabled, for a feature that is on unless turned off: only "off"
// (or false) turns it off. See `newTaskDetection`.
export function groupDisabled(env: Pick<AppEnv, "PROJECTS" | FeatureSecret>, channel: string | undefined | null, key: string, secret: FeatureSecret) {
  return (groupSetting(env, channel, key) ?? env[secret] !== "off") === false;
}
