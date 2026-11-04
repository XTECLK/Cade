import { projects } from "../channels.js";
import { addProject } from "../db.js";
import { publicUrl } from "../links.js";
import { isAdmin } from "../settings.js";
import { callSlack } from "../slack.js";
import { loginLink } from "../web.js";

// `/cade project init` makes the channel it's sent in a project, as one added to cade.config.json
// would be: its tasks are tracked there (see channels.js). The project is named after the channel,
// or by `/cade project init <name>`, and its name and channel can't be changed afterwards. In a
// channel that is a project already it only says so. `/cade project settings` gives the link to the
// projects page (see admin.js), where each project's settings are changed. `/cade project` tells
// which project the channel is. Only the admins listed in cade.config.json can use any of it.
export default {
  name: "project",
  description: "Make this channel a project, so its tasks are tracked here: `init` adds it, `settings` opens every project's settings. Admins only",
  slashUsage: ["/cade project init", "/cade project settings"],
  admin: true,
  section: "work",
  async slash(command, { env }) {
    if (!isAdmin(env, command.user)) return "Only an admin can use `/cade project`. Admins are listed under `admins` in cade.config.json.";
    const [action, ...rest] = command.text.trim().split(/\s+/);
    const existing = projects(env).find((project) => project.channel === command.channel);
    if (!action) {
      return existing
        ? `This channel is the project *${existing.name}*. \`/cade project settings\` opens its settings.`
        : "This channel isn't a project yet. Send `/cade project init` here to make it one.";
    }
    if (action.toLowerCase() === "settings") {
      return `:gear: <${publicUrl(env)}/admin|Project settings>, for every project. If it asks you to sign in, <${await loginLink(env, command.user)}|use this link> (it works once, for ten minutes), then open the settings again.`;
    }
    if (action.toLowerCase() !== "init") return "Send `/cade project init` in a channel to make it a project, `/cade project settings` for the projects' settings, or `/cade project` to see if this channel is one.";

    if (existing) {
      return `:warning: This channel is already the project *${existing.name}*, so there is nothing to add. \`/cade project settings\` opens its settings.`;
    }

    let info;
    try {
      ({ channel: info } = await callSlack(env, "conversations.info", { channel: command.channel }));
    } catch (error) {
      return `I can't see this channel (${error.message}). Invite me with \`/invite @Cade\` and try again.`;
    }
    if (info.is_im || info.is_mpim) return "A project is a channel, not a direct message. Send this in the project's channel.";
    if (!info.is_member) {
      if (info.is_private) return "I'm not in this private channel yet. Invite me with `/invite @Cade`, then send `/cade project init` again.";
      await callSlack(env, "conversations.join", { channel: command.channel });
    }

    const name = (rest.join(" ") || info.name || "").trim();
    if (!/^[\w][\w .-]{0,39}$/.test(name)) return "A project name is up to 40 letters, numbers, spaces, dashes or dots. Send `/cade project init <name>`.";
    if (projects(env).some((project) => project.name.toLowerCase() === name.toLowerCase())) {
      return `:warning: There is a project called *${name}* already. Send \`/cade project init <another name>\`.`;
    }
    await addProject(env, command.channel, name, command.user);
    console.log("Project added", { name, channel: command.channel, by: command.user });
    return `:white_check_mark: <#${command.channel}> is now the project *${name}*. Tasks made from messages can be tracked here with \`/cade task\`, and \`/cade project settings\` opens its settings.`;
  },
};
