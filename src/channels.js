// PROJECTS names each project's channel, where the team tracks its work,
// incidents included. Several projects can run side by side, such as the real
// channel and a test channel.
const ROLES = ["channel"];

// It is a Worker secret, so a JSON string; a list also works, as tests and
// [vars] in wrangler.toml give it.
export function projects(env) {
  const raw = env.PROJECTS;
  // None in the config is fine: projects can be kept in the database (see settings.js).
  if (raw === undefined) return [];
  const list = typeof raw === "string" ? parseProjects(raw) : raw;
  if (!Array.isArray(list) || list.some((project) => !project?.name || !project.channel)) {
    throw new Error("PROJECTS must list { name, channel } for each project");
  }
  return list;
}

function parseProjects(json) {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("PROJECTS is not valid JSON");
  }
}

// Returns every channel ID with the given role: "channel".
export function channelsWithRole(env, role) {
  return projects(env)
    .map((project) => project[role])
    .filter(Boolean);
}

// Returns the project that `channel` belongs to, or undefined when it is in
// none.
export function findProject(env, channel) {
  return projects(env).find((project) => ROLES.some((role) => project[role] === channel));
}

// Like findProject, for channels that must be in a project.
export function projectFor(env, channel) {
  const project = findProject(env, channel);
  if (!project) throw new Error(`${channel} is not in PROJECTS`);
  return project;
}

// The project's own setting `key`, such as `taskChangeDetection`, for `channel`, or undefined
// when it has none, or `channel` is in no project, so the setting for every
// project applies (see suggesting in intents.js and aiModel in ai.js).
export function groupSetting(env, channel, key) {
  if (!channel) return undefined;
  try {
    return findProject(env, channel)?.[key];
  } catch {
    return undefined;
  }
}

// Returns the role `channel` has in its project, or undefined when it is in none.
export function roleOf(env, channel) {
  const project = findProject(env, channel);
  return project && ROLES.find((role) => project[role] === channel);
}


// Whether a feature that is off unless turned on is on for `channel`: the
// project's own `key` (true or false), or else the Worker secret `secret`
// ("on" turns it on) for every project. See `activeTasksPinning` and `summaryCanvas` in
// scripts/config.mjs.
export function groupEnabled(env, channel, key, secret) {
  return groupSetting(env, channel, key) ?? env[secret] === "on";
}

// Like groupEnabled, for a feature that is on unless turned off: only "off"
// (or false) turns it off. See `newTaskDetection`.
export function groupDisabled(env, channel, key, secret) {
  return (groupSetting(env, channel, key) ?? env[secret] !== "off") === false;
}
