import { dispatch, dispatchSlash } from "./commands/dispatch.ts";
import { parseMessage, parseSlashCommand } from "./commands/parse.ts";
import { actions, intents, reactions, shortcuts, views } from "./commands/registry.ts";
import { recordMessage } from "./export.ts";
import { publishHome } from "./home.ts";
import { findIntent, intentsOn, plainMessage } from "./intents.ts";
import { handleMcp } from "./mcp.ts";
import { retryUnposted } from "./retry.ts";
import { withSettings } from "./settings.ts";
import { OutdatedPayload } from "./payloads.ts";
import { callSlack, messageBody, mrkdwn, plainText, respondLater, verifySlackRequest } from "./slack.ts";
import { handleWeb } from "./web.ts";
import type { AppEnv } from "./env.ts";
import type { Acknowledgement, Context, PayloadHandler, SlackPayload } from "./types.ts";

type Route = (body: string, request: Request, context: Context) => Promise<Response>;

const ROUTES: Record<string, Route> = {
  "/slack/events": handleEvent,
  "/slack/interactions": handleInteraction,
  "/slack/commands": handleSlashCommand,
};

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    // The links Cade puts on cards are to this Worker, at the address this
    // request came by unless PUBLIC_URL says otherwise (see links.ts).
    env = env.PUBLIC_URL ? env : { ...env, PUBLIC_URL: new URL(request.url).origin };
    const path = new URL(request.url).pathname;
    // The projects kept in the database, and the settings changed in the project settings form,
    // are merged into the config's for everything below, the MCP endpoint and web pages too
    // (see settings.ts).
    env = await withSettings(env);
    // AI agents reach Cade's MCP endpoint with an API key of their own in a
    // header, not Slack's signature (see mcp.ts).
    if (path === "/mcp" || path === "/mcp/") return handleMcp(request, env);
    // People reach a task's thread and notes pages with a session of their
    // own, which the Home tab's Web pages button starts (see web.ts).
    if (/^\/(t|n|login|logout)(\/|$)/.test(path)) return handleWeb(request, env);
    const route = ROUTES[path];
    if (!route) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!env.SLACK_SIGNING_SECRET) {
      throw new Error("SLACK_SIGNING_SECRET is not configured");
    }

    const body = await request.text();
    if (!(await verifySlackRequest(request, body, env.SLACK_SIGNING_SECRET))) {
      console.warn("Rejected request with an invalid Slack signature");
      return new Response("Invalid signature", { status: 401 });
    }

    // Slack expects an answer within three seconds, so slow work is handed to
    // waitUntil and runs after the response has been sent.
    const context: Context = {
      env,
      // The Worker's address, for what has to tell people it (see commands/mcp.ts).
      origin: new URL(request.url).origin,
      waitUntil: (promise: Promise<unknown>) =>
        ctx.waitUntil(
          promise.catch((error) =>
            console.error("Background task failed", { error: error.message }),
          ),
        ),
    };
    return route(body, request, context);
  },

  // The cron in wrangler.toml, every minute; every fifth posts tasks Slack
  // refused.
  async scheduled(controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    env = await withSettings(env);
    if (new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0) ctx.waitUntil(retryUnposted(env));
  },
} satisfies ExportedHandler<AppEnv>;

// Messages in channels Cade is in: commands such as `@Cade assign @person` are
// run in the background and answered in the message's thread.
async function handleEvent(body: string, request: Request, context: Context) {
  const envelope = JSON.parse(body);
  if (envelope.type === "url_verification") {
    return Response.json({ challenge: envelope.challenge });
  }
  // Events are acknowledged before they are processed, so a retry means the
  // first delivery is already being handled.
  if (request.headers.has("x-slack-retry-num")) return respond();
  if (envelope.type !== "event_callback") return respond();
  const botUserId = envelope.authorizations?.[0]?.user_id;

  // An emoji added to a message can ask Cade to do something with it (see
  // the handlers' `reactions`). Cade's own reactions never do.
  if (envelope.event.type === "reaction_added") {
    const { event } = envelope;
    if (event.item?.type === "message" && event.user !== botUserId) {
      for (const handle of reactions) context.waitUntil(handle(event, context));
    }
    return respond();
  }
  // Opening Cade's Home tab draws it (see home.ts).
  if (envelope.event.type === "app_home_opened") {
    if (envelope.event.tab === "home") context.waitUntil(publishHome(context.env, envelope.event.user));
    return respond();
  }
  if (envelope.event.type !== "message") return respond();

  // A reply in a task's thread is kept in the database (see recordMessage).
  context.waitUntil(recordMessage(context.env, envelope.event).catch((error) => console.error("Could not keep a message", { error: error.message })));

  const command = parseMessage(envelope.event, botUserId);
  if (command) {
    context.waitUntil(
      (async () => {
        const reply = await dispatch(command, context);
        if (!reply) return;
        const post = (body: unknown) =>
          callSlack(context.env, "chat.postMessage", {
            channel: command.channel,
            thread_ts: command.threadTs ?? command.ts,
            ...messageBody(body as string | object),
          });
        // An acknowledgement (see acknowledge) reacts to the command instead.
        if ((reply as Acknowledgement).reaction) {
          await callSlack(context.env, "reactions.add", {
            channel: command.channel,
            timestamp: command.ts,
            name: (reply as Acknowledgement).reaction,
          });
          if ((reply as Acknowledgement).note) await post((reply as Acknowledgement).note);
          return;
        }
        await post(reply);
      })(),
    );
  } else {
    // Plain messages can still mean something: see intents.ts.
    const message = plainMessage(envelope.event, botUserId);
    // Kinds turned off in `taskChangeDetection`, for the message's group or every
    // group, aren't considered (see suggesting).
    const meant = message && findIntent(intentsOn(context.env, intents, message.channel), message);
    console.log("Plain message", {
      channel: envelope.event.channel,
      ts: envelope.event.ts,
      threadTs: envelope.event.thread_ts,
      subtype: envelope.event.subtype,
      botId: envelope.event.bot_id,
      text: envelope.event.text,
      acted: Boolean(message),
      inThread: message?.inThread,
      intent: meant?.name,
    });
    if (meant) {
      context.waitUntil(
        Promise.resolve(meant.handle(message!, context)).catch((error) =>
          console.error("Intent failed", { intent: meant.name, error: error.message }),
        ),
      );
    }
  }
  return respond();
}

// `/cade name …` slash commands. They run before Slack is answered, so that a
// modal can be opened with the command's trigger_id, which expires after
// three seconds. Replies are shown only to the person who sent the command.
async function handleSlashCommand(body: string, request: Request, context: Context) {
  const command = parseSlashCommand(new URLSearchParams(body));
  const reply = await dispatchSlash(command, context);
  return respond(reply && { response_type: "ephemeral", ...messageBody(reply) });
}

// Modal submissions, button clicks and message shortcuts (Cade's items in a
// message's ⋯ → More actions) go to the handler that registered the modal's
// callback_id, the button's action_id or the shortcut's callback_id.
async function handleInteraction(body: string, request: Request, context: Context) {
  const payload: SlackPayload = JSON.parse(new URLSearchParams(body).get("payload")!);
  let id: string | undefined;
  let handler: PayloadHandler | undefined;
  if (payload.type === "view_submission") {
    id = payload.view!.callback_id;
    handler = views[id];
  } else if (payload.type === "block_actions") {
    id = payload.actions?.[0]?.action_id;
    handler = actionFor(id!);
  } else if (payload.type === "message_action") {
    id = payload.callback_id;
    handler = shortcuts[id!];
  } else {
    return respond();
  }

  if (!handler) {
    console.warn("No handler for interaction", { type: payload.type, id });
    return respond();
  }
  // A button or form whose payload no longer fits (see payloads.ts) is told so, whether the handler
  // reads it at once or in the work it hands to waitUntil.
  const outdatedToo = (promise: Promise<unknown>) =>
    promise.catch((error) => {
      if (error instanceof OutdatedPayload) return outdated(context.env, payload, error);
      throw error;
    });
  try {
    return respond(await handler(payload, { ...context, waitUntil: (promise) => context.waitUntil(outdatedToo(promise)) }));
  } catch (error) {
    if (!(error instanceof OutdatedPayload)) throw error;
    await outdated(context.env, payload, error);
    // A form is answered in its own window, which says so in place of the form.
    return respond(payload.type === "view_submission" ? { response_action: "update", view: OUTDATED_VIEW } : undefined);
  }
}

const OUTDATED = "That's from an older message, and doesn't work anymore. Open the task again, or send the command again.";
const OUTDATED_VIEW = { type: "modal", title: plainText("Out of date"), close: plainText("Close"), blocks: [{ type: "section", text: mrkdwn(OUTDATED) }] };

// Tells whoever clicked an out-of-date button so, privately, where it was: through the click's
// response_url, or in its channel. A form says so in its window instead (see above); a button on the
// Home tab or in a form has neither, and is only logged.
async function outdated(env: AppEnv, payload: SlackPayload, error: OutdatedPayload) {
  console.warn("Out-of-date button or form", { type: payload.type, problem: error.message });
  if (payload.type === "view_submission") return;
  try {
    if (payload.response_url) await respondLater(payload.response_url, { text: OUTDATED, replace_original: false });
    else if (payload.channel?.id) await callSlack(env, "chat.postEphemeral", { channel: payload.channel.id, user: payload.user.id, text: OUTDATED });
  } catch (failure) {
    console.warn("Could not say the button is out of date", { error: failure.message });
  }
}

// The handler for an action id, or for the longest start of it up to a colon:
// a button repeated in a view has the item it acts on after its name.
function actionFor(id: string): PayloadHandler | undefined {
  for (let end = id.length; end > 0; end = id.lastIndexOf(":", end - 1)) {
    if (actions[id.slice(0, end)]) return actions[id.slice(0, end)];
  }
}

function respond(result?: unknown) {
  return result ? Response.json(result) : new Response(null, { status: 200 });
}
