import { projects } from "../channels.js";
import { ensureWorkDoc } from "../doc.js";
import { googleEnabled } from "../google.js";
import { addProject } from "../db.js";
import { SETTINGS, applySettings, choicesOf, configEnv, isAdmin, settingOn } from "../settings.js";
import { callSlack, mrkdwn, plainText } from "../slack.js";

const SETTINGS_VIEW = "project:settings";
const PICK_ACTION = "project:pick";

// `/cade project init` makes the channel it's sent in a project, as one added to cade.config.json
// would be: its tasks are tracked there (see channels.js). The project is named after the channel,
// or by `/cade project init <name>`, and its name and channel can't be changed afterwards. In a
// channel that is a project already it only warns. Every project has a Google Doc for its executive
// summaries, made by `init` (so Google must be set up first). `/cade project settings` opens a form in Slack
// with a project's switches (see settings.js), each following the config or turned on or off, and a
// list to pick the project from. `/cade project` tells which project the channel is. Only the
// admins listed in cade.config.json can use any of it.
export default {
  name: "project",
  description: "Make this channel a project, so its tasks are tracked here: `init` adds it, `settings` opens the projects' settings. Admins only",
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
      await callSlack(env, "views.open", { trigger_id: command.triggerId, view: await settingsView(env, command.channel) });
      return undefined;
    }
    if (action.toLowerCase() !== "init") return "Send `/cade project init` in a channel to make it a project, `/cade project settings` for the projects' settings or `/cade project` to see if this channel is one.";

    if (existing) {
      return `:warning: This channel is already the project *${existing.name}*, so there is nothing to add. \`/cade project settings\` opens its settings.`;
    }
    if (!googleEnabled(env)) return NO_GOOGLE;
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
    // Its Google Doc, for executive summaries, is made first: without it the project isn't added.
    let doc;
    try {
      doc = await ensureWorkDoc(env, { name, channel: command.channel }, command.user);
    } catch (error) {
      console.error("Could not make a work doc", { name, error: error.message });
      return `I couldn't make the project's Google Doc just now (${error.message}), so I haven't added it. Could you try again?`;
    }
    await addProject(env, command.channel, name, command.user);
    console.log("Project added", { name, channel: command.channel, by: command.user });
    return `:white_check_mark: <#${command.channel}> is now the project *${name}*. Tasks made from messages can be tracked here with \`/cade task\`, and \`/cade project settings\` opens its settings. Its executive summaries go in <https://docs.google.com/document/d/${doc}/edit|a Google Doc> I made for it (anyone with the link can view it; share it as Editor with whoever goes through the summaries).`;
  },
  views: { [SETTINGS_VIEW]: saveSettings },
  actions: { [PICK_ACTION]: pickProject },
};

const NO_GOOGLE = "Every project keeps its executive summaries in a Google Doc, and the Google web app isn't set up yet: run `npm run google:create` (see GETTING_STARTED.md), then try again.";

const CHOICES = { config: "Use the config", on: "On", off: "Off" };
const state = (on) => (on === "some" ? "partly on" : on ? "on" : "off");

// The form for the project with `channel` (the first project if it is none): a list of projects to
// switch between, and a choice for each setting. Name, channel and aiModel stay in the config.
async function settingsView(env, channel) {
  const list = projects(env);
  const project = list.find((candidate) => candidate.channel === channel) ?? list[0];
  const config = configEnv(env);
  const choices = await choicesOf(env, project.channel);
  const option = (text, value) => ({ text: plainText(text.slice(0, 75)), value });
  const picks = list.slice(0, 100).map((candidate) => option(candidate.name, candidate.channel));
  return {
    type: "modal",
    callback_id: SETTINGS_VIEW,
    private_metadata: project.channel,
    title: plainText("Project settings"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [
      {
        type: "section",
        text: mrkdwn("*Project*"),
        accessory: { type: "static_select", action_id: PICK_ACTION, initial_option: picks.find((pick) => pick.value === project.channel), options: picks },
      },
      { type: "context", elements: [mrkdwn(`<#${project.channel}> · ${project.added ? "kept in Cade's database, with its name, channel and AI model" : "its name, channel and AI model are set in cade.config.json"}. Picking another project drops changes you haven't saved.`)] },
      ...SETTINGS.map(({ key, label, about }) => {
        const options = Object.entries(CHOICES).map(([value, text]) => option(value === "config" ? `${project.added ? "Use the default" : text} (${state(settingOn(config, project.channel, key))})` : text, value));
        return {
          type: "input",
          block_id: `s_${key}`,
          label: plainText(label),
          hint: plainText(`${about} Now ${state(settingOn(env, project.channel, key))}.`.slice(0, 2000)),
          element: { type: "static_select", action_id: "value", initial_option: options.find((choice) => choice.value === choices[key]), options },
        };
      }),
    ],
  };
}

// Another project picked in the form: show its settings in its place.
async function pickProject(payload, { env }) {
  if (!isAdmin(env, payload.user.id)) return;
  await callSlack(env, "views.update", {
    view_id: payload.view.id,
    hash: payload.view.hash,
    view: await settingsView(env, payload.actions[0].selected_option.value),
  });
}

// The form saved: each setting goes back to the config or is kept on or off.
async function saveSettings(payload, context) {
  const { env } = context;
  if (!isAdmin(env, payload.user.id)) return { response_action: "clear" };
  const channel = payload.view.private_metadata;
  const choices = Object.fromEntries(SETTINGS.map(({ key }) => [key, payload.view.state.values[`s_${key}`]?.value?.selected_option?.value]));
  context.waitUntil(
    (async () => {
      const changed = await applySettings(env, channel, choices, payload.user.id);
      const name = projects(env).find((project) => project.channel === channel)?.name ?? channel;
      await callSlack(env, "chat.postEphemeral", {
        channel,
        user: payload.user.id,
        text: changed ? `Saved ${changed} setting${changed === 1 ? "" : "s"} for the project *${name}*. They apply from the next message.` : `Nothing changed for the project *${name}*.`,
      });
    })(),
  );
  return { response_action: "clear" };
}
