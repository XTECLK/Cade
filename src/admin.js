import { projects } from "./channels.js";
import { clearProjectSetting, projectSettings, setProjectSetting } from "./db.js";
import { SETTINGS, isAdmin, settingOn } from "./settings.js";
import { SIGN_IN, currentUser, escapeHtml, methodNotAllowed, page } from "./web.js";

// The admin page, `/admin` on the Worker: the projects from cade.config.json with their name and
// channel, which can't be changed here, and the settings that can (see settings.js), each of which
// follows the config, or is turned on or off here. Only the admins cade.config.json lists can see it,
// signed in as for the other pages (`/cade login`). A change takes effect on the next message, and
// "Use the config" removes it again.
export const NOT_ADMIN = "<p>Only the admins listed under <code>admins</code> in cade.config.json can change project settings.</p>";

export async function handleAdmin(request, env) {
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed("GET, POST");
  const user = await currentUser(request, env);
  if (!user) return page(401, "Sign in", SIGN_IN);
  if (!isAdmin(env, user)) return page(403, "Admins only", NOT_ADMIN);
  if (request.method === "POST") {
    // A form on another site can't send the cookie (SameSite=Lax), and the request must say it comes from this one.
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return page(403, "Forbidden", "<p>That request came from another site.</p>");
    const changes = await save(env, await request.formData(), user);
    return form(env, { saved: changes });
  }
  return form(env, {});
}

// The config's projects: the Worker's env as the config alone has it, without what was changed here.
const configEnv = (env) => (env.PROJECTS_BASE ? { ...env, PROJECTS: env.PROJECTS_BASE, CHANNEL_PAIRS: undefined } : env);

// Applies the form: for each project and setting, "" goes back to the config, "on" or "off" is kept.
// Returns how many settings changed.
async function save(env, data, user) {
  const kept = new Map((await projectSettings(env)).map((row) => [`${row.channel}|${row.key}`, row.value]));
  let changed = 0;
  for (const project of projects(env)) {
    for (const { key } of SETTINGS) {
      const choice = data.get(`${project.channel}|${key}`);
      if (choice === null) continue;
      const before = kept.get(`${project.channel}|${key}`);
      if (choice === "") {
        if (before === undefined) continue;
        await clearProjectSetting(env, project.channel, key);
      } else if (choice === "on" || choice === "off") {
        if (before === String(choice === "on")) continue;
        await setProjectSetting(env, project.channel, key, choice === "on", user);
      } else continue;
      changed++;
      console.log("Project setting changed", { project: project.name, key, to: choice || "config", by: user });
    }
  }
  return changed;
}

const state = (on) => (on === "some" ? "partly on" : on ? "on" : "off");

async function form(env, { saved }) {
  const config = configEnv(env);
  const kept = new Map((await projectSettings(env)).map((row) => [`${row.channel}|${row.key}`, JSON.parse(row.value)]));
  const cards = projects(env).map((project) => {
    const rows = SETTINGS.map(({ key, label, about }) => {
      const mine = kept.get(`${project.channel}|${key}`);
      const choice = mine === undefined ? "" : mine ? "on" : "off";
      const option = (value, text) => `<option value="${value}"${choice === value ? " selected" : ""}>${escapeHtml(text)}</option>`;
      return `<div class="setting"><label for="${escapeHtml(project.channel)}-${key}"><strong>${escapeHtml(label)}</strong></label>
<p class="meta">${escapeHtml(about)} Now ${state(settingOn(env, project.channel, key))}.</p>
<select id="${escapeHtml(project.channel)}-${key}" name="${escapeHtml(project.channel)}|${key}">${option("", `Use the ${project.added ? "default" : "config"} (${state(settingOn(config, project.channel, key))})`)}${option("on", "On")}${option("off", "Off")}</select></div>`;
    }).join("\n");
    return `<section class="project"><h2>${escapeHtml(project.name)}</h2><p class="meta">Channel <code>${escapeHtml(project.channel)}</code> · ${project.added ? "added with /cade project init" : "name and channel are set in cade.config.json"}</p>\n${rows}</section>`;
  });
  const note = saved === undefined ? "" : `<p class="ok">${saved ? `Saved: ${saved} setting${saved === 1 ? "" : "s"} changed.` : "Nothing changed."}</p>`;
  return page(
    200,
    "Projects",
    `<p class="meta">Settings changed here win over cade.config.json until you choose "Use the config". They take effect on the next message.</p>${note}
<form method="post">${cards.join("\n")}<button type="submit">Save</button></form>`,
  );
}
