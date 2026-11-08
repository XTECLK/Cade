import { projects } from "../channels.ts";
import { addProject, setHomeProject } from "../db.ts";
import { ensureWorkDoc } from "../doc.ts";
import { googleEnabled } from "../google.ts";
import { ADD_PROJECT_ACTION, SETTINGS_ACTION, publishHome } from "../home.ts";
import { channelMembers } from "../access.ts";
import { SETTINGS, applySettings, choicesOf, configEnv, isAdmin, settingOn, withSettings } from "../settings.ts";
import { callSlack, escapeSlack, mrkdwn, plainText } from "../slack.ts";
import type { Handler } from "../types.ts";
import type { AppEnv } from "../env.ts";
import type { Context, SlackPayload } from "../types.ts";


const SETTINGS_VIEW = "project:settings";
const ADD_VIEW = "project:add";

// Admins manage projects from Settings on the Home tab (see home.ts), not with commands:
//   Add project       opens a form: a channel, a name (the channel's own by default) and each switch (see
//                     settings.ts). Who works on it is whoever is in the channel. Submitting checks them, and then makes the project
//                     as one added to cade.config.json would be: its tasks are tracked in that channel (see
//                     channels.ts). Every project has a Google Doc for its executive summaries, made first
//                     (so Google must be set up): without it nothing is added. The form turns into
//                     "Adding…", then says whether it worked, and why not. The name and channel can't be
//                     changed afterwards.
//   Project settings  opens a form with the switches of the project picked on the Home tab, each following
//                     the config or turned on or off.
// Only the admins listed in cade.config.json can use either.
export default {
  views: { [SETTINGS_VIEW]: saveSettings, [ADD_VIEW]: addProjectSubmit },
  actions: { [SETTINGS_ACTION]: openSettings, [ADD_PROJECT_ACTION]: openAddProject },
} satisfies Handler;

const NO_GOOGLE = "Every project keeps its executive summaries in a Google Doc, and the Google web app isn't set up yet: run `npm run google:create` (see GETTING_STARTED.md), then try again.";

const CHOICES = { config: "Use the config", on: "On", off: "Off" };
const state = (on: boolean | "some") => (on === "some" ? "partly on" : on ? "on" : "off");

// The form for the project with `channel` (the first project if it is none): its name, and a choice
// for each setting. Name and channel stay as they were set.
async function settingsView(env: AppEnv, channel: string) {
  const list = projects(env);
  // The button that opens it is only shown with a project, so there is one.
  const project = (list.find((candidate) => candidate.channel === channel) ?? list[0])!;
  const config = configEnv(env);
  const choices = await choicesOf(env, project.channel);
  const option = (text: string, value: string) => ({ text: plainText(text.slice(0, 75)), value });
  return {
    type: "modal",
    callback_id: SETTINGS_VIEW,
    private_metadata: project.channel,
    title: plainText("Project settings"),
    submit: plainText("Save"),
    close: plainText("Cancel"),
    blocks: [
      { type: "section", text: mrkdwn(`*${escapeSlack(project.name)}*`) },
      { type: "context", elements: [mrkdwn(`<#${project.channel}> · ${project.added ? "kept in Cade's database, with its name and channel" : "its name and channel are set in cade.config.json"}. To change another project, pick it on the Home tab.`)] },
      ...(await peopleBlocks(env, project.channel)),
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

// Edit, under Projects in Settings on the Home tab: opens the form for the project it carries.
async function openSettings(payload: SlackPayload, { env }: Context) {
  if (!isAdmin(env, payload.user.id)) return;
  await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: await settingsView(env, payload.actions[0].value) });
}

// The form saved: each setting goes back to the config or is kept on or off.
async function saveSettings(payload: SlackPayload, context: Context) {
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


// Who works on the project: everyone in its channel, as Cade keeps no list of its own. People are added
// and removed in the channel itself, and who can reach the project's tasks with Cade goes by it too.
const MAX_SHOWN = 40;
async function peopleBlocks(env: AppEnv, channel: string) {
  let text;
  try {
    const ids = await channelMembers(env, channel);
    const more = ids.length > MAX_SHOWN ? ` and ${ids.length - MAX_SHOWN} more` : "";
    text = ids.length ? `${ids.slice(0, MAX_SHOWN).map((id) => `<@${id}>`).join(", ")}${more}` : "_No one yet._";
  } catch (error) {
    console.warn("Could not read the channel's members", { channel, error: error.message });
    text = "_I couldn't read who is in the channel just now._";
  }
  return [
    { type: "section", text: mrkdwn(`*People*\n${text}`) },
    { type: "context", elements: [mrkdwn(`Everyone in <#${channel}> works on this project. Add or remove people in the channel itself.`)] },
  ];
}

// ---- Add project ----

const NAME = /^[\w][\w .-]{0,39}$/;
const DEFAULT_CHOICES = { config: "Use the default", on: "On", off: "Off" };

// The Add project form, with each switch as the default is now.
function addView(env: AppEnv) {
  const config = configEnv(env);
  const option = (text: string, value: string) => ({ text: plainText(text), value });
  return {
    type: "modal",
    callback_id: ADD_VIEW,
    title: plainText("Add project"),
    submit: plainText("Add project"),
    close: plainText("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: "channel",
        label: plainText("Channel"),
        hint: plainText("Where the team tracks this project's tasks. Cade must be in it (invite it with /invite @Cade in a private channel)."),
        element: {
          type: "conversations_select",
          action_id: "value",
          placeholder: plainText("Pick a channel"),
          filter: { include: ["public", "private"], exclude_bot_users: true, exclude_external_shared_channels: true },
        },
      },
      {
        type: "input",
        block_id: "name",
        optional: true,
        label: plainText("Name"),
        hint: plainText("Up to 40 letters, numbers, spaces, dashes or dots. Left empty, the channel's name. It can't be changed later."),
        element: { type: "plain_text_input", action_id: "value", max_length: 40 },
      },
      ...SETTINGS.map(({ key, label, about }) => {
        const options = Object.entries(DEFAULT_CHOICES).map(([value, text]) => option(value === "config" ? `${text} (${state(settingOn(config, undefined, key))})` : text, value));
        return {
          type: "input",
          block_id: `s_${key}`,
          label: plainText(label),
          hint: plainText(about.slice(0, 2000)),
          element: { type: "static_select", action_id: "value", initial_option: options[0], options },
        };
      }),
    ],
  };
}

// A plain window with a message and a Close button: while adding, and what it came to.
const notice = (title: string, text: string) => ({ type: "modal", title: plainText(title), close: plainText("Close"), blocks: [{ type: "section", text: mrkdwn(text) }] });

// The Add project button: opens the form, within Slack's three seconds of the click.
async function openAddProject(payload: SlackPayload, { env }: Context) {
  if (!isAdmin(env, payload.user.id)) return;
  await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: addView(env) });
}

// The form submitted: what can be checked quickly is, and a problem is shown on its field. Then the form
// turns into "Adding…" and the rest follows, as making the Google Doc can take longer than Slack waits.
async function addProjectSubmit(payload: SlackPayload, context: Context) {
  const { env } = context;
  const user = payload.user.id;
  if (!isAdmin(env, user)) return { response_action: "clear" };
  const values = payload.view.state.values;
  const channel = values.channel?.value?.selected_conversation;
  const typed = (values.name?.value?.value ?? "").trim();
  const choices = Object.fromEntries(SETTINGS.map(({ key }) => [key, values[`s_${key}`]?.value?.selected_option?.value]));

  const existing = projects(env).find((project) => project.channel === channel);
  if (existing) return { response_action: "errors", errors: { channel: `This channel is the project ${existing.name} already.` } };
  if (!googleEnabled(env)) return { response_action: "errors", errors: { channel: NO_GOOGLE } };
  let info;
  try {
    ({ channel: info } = await callSlack(env, "conversations.info", { channel }));
  } catch (error) {
    return { response_action: "errors", errors: { channel: `I can't see this channel (${error.message}). Invite me with /invite @Cade and try again.` } };
  }
  if (!info.is_member && info.is_private) return { response_action: "errors", errors: { channel: "I'm not in this private channel yet. Invite me with /invite @Cade, then add it." } };
  const name = typed || info.name || "";
  if (!NAME.test(name)) return { response_action: "errors", errors: { name: "A name is up to 40 letters, numbers, spaces, dashes or dots." } };
  if (projects(env).some((project) => project.name.toLowerCase() === name.toLowerCase())) {
    return { response_action: "errors", errors: { name: `There is a project called ${name} already.` } };
  }

  context.waitUntil(createProject(env, { channel: channel!, name, choices, joined: info.is_member }, user, payload.view.id));
  return { response_action: "update", view: notice("Add project", `:hourglass_flowing_sand: Adding *${name}*… This takes a few seconds, as its Google Doc is made first.`) };
}

// Makes the project and says how it went in the form, which Slack keeps showing until it's closed. If it
// was closed already, the same goes to the person in a message from Cade. The Home tab is drawn again on
// the new project.
async function createProject(
  env: AppEnv,
  { channel, name, choices, joined }: { channel: string; name: string; choices: Record<string, string | undefined>; joined?: boolean },
  user: string,
  viewId: string,
) {
  let text;
  try {
    if (!joined) await callSlack(env, "conversations.join", { channel });
    // Its Google Doc, for executive summaries, is made first: without it the project isn't added.
    let doc;
    try {
      doc = await ensureWorkDoc(env, { name, channel }, user);
    } catch (error) {
      console.error("Could not make a work doc", { name, error: error.message });
      throw new Error(`I couldn't make the project's Google Doc just now (${error.message})`);
    }
    await addProject(env, channel, name, user);
    // The project is known to the rest of the code once the database says so.
    const added = await withSettings(env);
    await applySettings(added, channel, choices, user);
    await setHomeProject(env, user, name);
    console.log("Project added", { name, channel, by: user });
    text = `:white_check_mark: <#${channel}> is now the project *${name}*. Tasks made from messages can be tracked there with \`/cade task\`. Its executive summaries go in <https://docs.google.com/document/d/${doc}/edit|a Google Doc> I made for it (anyone with the link can view it; share it as Editor with whoever goes through the summaries).`;
  } catch (error) {
    console.error("Could not add the project", { name, channel, error: error.message });
    text = `:x: I couldn't add *${name}*: ${error.message}. Nothing was added, so you can try again.`;
  }
  try {
    await callSlack(env, "views.update", { view_id: viewId, view: notice("Add project", text) });
  } catch {
    await callSlack(env, "chat.postMessage", { channel: user, text }).catch((error) => console.error("Could not tell the admin", { error: error.message }));
  }
  await publishHome(env, user).catch((error) => console.error("Could not redraw the Home tab", { error: error.message }));
}
