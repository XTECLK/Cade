import aiSuggest from "./ai-suggest.ts";
import archive from "./archive.ts";
import assign from "./assign.ts";
import remove from "./delete.ts";
import replace from "./replace.ts";
import edit from "./edit.ts";
import { due, priority } from "./details.ts";
import home from "./home.ts";
import configure from "./configure.ts";
import menu from "./menu.ts";
import move from "./move.ts";
import pr from "./pr.ts";
import project from "./project.ts";
import release from "./release.ts";
import resync from "./resync.ts";
import retry from "./retry.ts";
import standup from "./standup.ts";
import status from "./status.ts";
import subtask from "./subtask.ts";
import suggest from "./suggest.ts";
import track, { incident } from "./track.ts";
import unassign from "./unassign.ts";
import { ADMINS_ONLY, isAdmin } from "../settings.ts";
import { respondLater } from "../slack.ts";
import type { Handler, Intent, PayloadHandler } from "../types.ts";

// To add a command, create a handler module and list it here. A handler is:
//   {
//     name, description,
//     usage?: how to send it as an `@Cade name` message, or a list of the
//             ways, the first shown when it's sent in the wrong place,
//     slashUsage?: how to send it as `/cade name`, or a list of the ways,
//     section: where help lists its `@Cade` form: "message" for a message's
//               thread, "task" for a task's thread; or "work" for those
//               with only a `/cade` form, listed with the slash commands,
//     aliases?: other names that run the same handler,
//     admin?: true for tidying-up commands, only for Cade's admins, with their
//               buttons and forms, and not in help,
//     slashAdmin?: true when only the `/cade name` form is for admins,
//     channel?: "channel", or [] for any channel: the channels in
//               PROJECTS it works in,
//     slashChannel?: like `channel`, for `/cade name` when it differs,
//     inThread?: true if it must be run from a thread reply,
//     run?(command, context) -> reply | undefined, for `@Cade name`,
//     slash?(command, context) -> reply | undefined, for `/cade name`; it has
//               the command's triggerId, so it can open a modal straight away,
//     views?: { [callbackId]: handler(payload, context) } for its modals,
//     actions?: { [actionId]: handler(payload, context) } for its buttons,
//     shortcuts?: { [callbackId]: handler(payload, context) } for its items
//               in a message's ⋯ → More actions (see slack/manifest.json),
//     reactions?: handler(event, context) for each emoji added to a message
//               in a channel Cade is in; it decides which ones it acts on,
//     intents?: plain messages it acts on, made with intent() (see intents.ts),
//   }
// A reply is plain text or a message body such as { text, blocks }.
// See parse.ts for the shape of `command`.
const handlers: Handler[] = [track, incident, assign, unassign, status, priority, due, pr, release, subtask, archive, remove, replace, move, resync, retry, standup];

export const commands: Record<string, Handler> = Object.fromEntries(
  handlers.flatMap((handler) =>
    [handler.name, ...(handler.aliases ?? [])].map((name) => [name, handler]),
  ),
);

// An admin command's buttons and forms check, as its command does (see dispatchSlash), that whoever
// uses them is an admin: they are sent only to admins, but a click is checked anyway. Someone else is
// told so, privately, and nothing happens.
function adminsOnly(handlers: Record<string, PayloadHandler> = {}): Record<string, PayloadHandler> {
  return Object.fromEntries(
    Object.entries(handlers).map(([id, handle]) => [
      id,
      async (payload, context) => {
        if (isAdmin(context.env, payload.user.id)) return handle(payload, context);
        console.warn("Not an admin", { id, user: payload.user.id });
        if (payload.response_url) await respondLater(payload.response_url, { text: ADMINS_ONLY }).catch(() => {});
        return payload.view ? { response_action: "clear" } : undefined;
      },
    ]),
  );
}
const guarded = (handler: Handler): Handler => (handler.admin ? { ...handler, actions: adminsOnly(handler.actions), views: adminsOnly(handler.views) } : handler);

// The Home tab's Refresh button, the task card's menu, its Edit form, and suggestions from people's own words only answer
// clicks and messages, so they aren't commands.
const interactive: Handler[] = [...handlers, home, configure, project, menu, edit, suggest, aiSuggest].map(guarded);

export const views: Record<string, PayloadHandler> = Object.assign(
  {},
  ...interactive.map((handler) => handler.views ?? {}),
);

export const intents: Intent[] = interactive.flatMap((handler) => handler.intents ?? []);

export const shortcuts: Record<string, PayloadHandler> = Object.assign(
  {},
  ...interactive.map((handler) => handler.shortcuts ?? {}),
);

export const reactions = interactive.flatMap((handler) => (handler.reactions ? [handler.reactions] : []));

export const actions: Record<string, PayloadHandler> = Object.assign(
  {},
  ...interactive.map((handler) => handler.actions ?? {}),
);
