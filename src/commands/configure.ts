import { deleteWebTokensOf, hasMcpToken, mcpTokenCreated, webSessionsOf } from "../db.ts";
import { endpointUrl, grantToken, mcpCatalog, mcpEnabled, revokeToken } from "../mcp.ts";
import { callSlack, mrkdwn, plainText } from "../slack.ts";
import { loginLink } from "../web.ts";
import type { AppEnv } from "../env.ts";
import type { Handler, SlackBlock, SlackPayload } from "../types.ts";

// The setup buttons along the top of the Home tab (see home.ts), each opening a modal only the
// person sees:
//   Web pages  signs them in to the Worker's thread and notes pages that task cards link to (see
//              web.ts), or out of every browser: a link that works once for ten minutes, and keeps
//              them signed in for thirty days.
//   AI agent   whether Cade's MCP endpoint (see mcp.ts) is on, the endpoint, and their own API
//              key for it: made here, shown once, and ended here. With it their AI agent, whichever
//              they use, reads the threads they can read and writes a task's summary as them. A
//              key can't be shown again, and none is made while there is one: to change it,
//              revoke it first.
// A key or a sign-in link is only ever shown in a modal, which goes when it is closed, never on
// the Home tab itself, which stays drawn until the next refresh.
// How to connect an agent, and every tool it gets, is on Cade's website, the same for every workspace.
export const MCP_GUIDE = "https://xteclk.github.io/Cade/mcp.html#connect";

export const WEB_ACTION = "home:web";
export const MCP_ACTION = "home:mcp";
const WEB_LOGIN_ACTION = "home:web:login";
const WEB_LOGOUT_ACTION = "home:web:logout";
const MCP_CREATE_ACTION = "home:mcp:create";
const MCP_REVOKE_ACTION = "home:mcp:revoke";

const section = (text: string): SlackBlock => ({ type: "section", text: mrkdwn(text) });
const button = (action_id: string, text: string, extra: SlackBlock = {}) => ({ type: "button", action_id, text: plainText(text), ...extra });
const modal = (title: string, blocks: SlackBlock[]) => ({ type: "modal", title: plainText(title), close: plainText("Close"), blocks });

// Whether the person is signed in to the web pages, for the Configure part of the Home tab and the modal.
export async function webLine(env: AppEnv, user: string) {
  const browsers = await webSessionsOf(env, user);
  return browsers ? `:white_check_mark: Signed in on ${browsers} browser${browsers === 1 ? "" : "s"}` : ":x: Not signed in on any browser";
}

// The web pages modal, with how things stand and what the last button said above its buttons.
export async function webView(env: AppEnv, user: string, result?: string) {
  return modal("Cade web pages", [
    section(`Task cards link to *Full history* and *Extra notes* pages that Cade hosts. Sign in once in each browser to read the ones for channels you can read.\n*Now:* ${await webLine(env, user)}`),
    ...(result ? [section(result)] : []),
    {
      type: "actions",
      elements: [
        button(WEB_LOGIN_ACTION, "Get a sign-in link", { style: "primary" }),
        button(WEB_LOGOUT_ACTION, "Sign out of every browser", {
          confirm: {
            title: plainText("Sign out?"),
            text: plainText("This ends every browser session of yours and any sign-in link you haven't used."),
            confirm: plainText("Sign out"),
            deny: plainText("Cancel"),
          },
        }),
      ],
    },
  ]);
}

// Whether MCP is on for this Cade and the person has a key, for the Configure part of the Home tab.
export async function mcpLine(env: AppEnv, user: string) {
  if (!mcpEnabled(env)) return ":x: Turned off by an admin";
  const made = await mcpTokenCreated(env, user);
  return made ? `:white_check_mark: Configured · key made ${made.slice(0, 10)} · ${mcpCatalog().tools.length} tools` : ":x: No key yet";
}

// The AI agent modal: whether MCP is configured (on) for this Cade, whether the person has a key (never the key
// itself), where the endpoint is and the setup guide, then the button for what they can do now.
// `result` is what the last button said, such as the new key.
export async function mcpView(env: AppEnv, user: string, result?: string) {
  const on = mcpEnabled(env);
  const made = on ? await mcpTokenCreated(env, user) : null;
  const key = made ? `:white_check_mark: made ${made.slice(0, 10)}. I can't show it again; to change it, revoke it and make a new one` : ":x: none yet";
  const lines = [
    `*Configured:* ${on ? ":white_check_mark: yes, MCP is on for this Cade" : ":x: no, an admin turned it off (`mcp` in cade.config.json), so keys don't work"}`,
    on ? `*Your API key:* ${key}` : "",
    on ? `*Endpoint:* \`${endpointUrl(env)}\` (Streamable HTTP), with your API key in the header \`x-apikey\`` : "",
    on ? `*Offers:* ${mcpCatalog().tools.length} tools` : "",
    on ? `*Setup guide:* <${MCP_GUIDE}|How to connect your AI agent>` : "",
    "Everything runs as you, so your agent reads only what you can read. Changes and messages it makes are posted in the task's thread under your name, after you approve them.",
  ].filter(Boolean);
  const blocks = [section(lines.join("\n"))];
  if (result) blocks.unshift(section(result));
  if (on) {
    blocks.push({
      type: "actions",
      elements: [
        made
          ? button(MCP_REVOKE_ACTION, "Revoke key", {
              style: "danger",
              confirm: {
                title: plainText("Revoke your key?"),
                text: plainText("Your AI agent can't use Cade until you make a new key."),
                confirm: plainText("Revoke"),
                deny: plainText("Cancel"),
              },
            })
          : button(MCP_CREATE_ACTION, "Create key", { style: "primary" }),
      ],
    });
  }
  return modal("AI agent", blocks);
}

// The endpoint and the API key, each in a code block (which has Slack's own copy button), and the guide for connecting an agent.
function granted(url: string, key: string) {
  return [
    ":key: *Your Cade MCP connection.*",
    "*Endpoint*",
    `\`\`\`${url}\`\`\``,
    "*API key*, sent with every request in the header `x-apikey`",
    `\`\`\`${key}\`\`\``,
    `*How to connect:* <${MCP_GUIDE}|Step by step guide>`,
    "Keep the key to yourself: your agent acts as you. I can't show it again; revoke it here and make a new one to change it.",
  ].join("\n");
}

// Opening a modal must happen within Slack's three seconds of the click. Its buttons change it in place.
const update = (env: AppEnv, payload: SlackPayload, view: SlackBlock) => callSlack(env, "views.update", { view_id: payload.view!.id, view });

export default {
  actions: {
    [WEB_ACTION]: async (payload, { env }) => {
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: await webView(env, payload.user.id) });
    },
    [WEB_LOGIN_ACTION]: async (payload, { env }) => {
      const link = await loginLink(env, payload.user.id);
      await update(env, payload, await webView(env, payload.user.id, `:key: <${link}|Sign in to Cade's pages>. The link works once, for ten minutes, and keeps you signed in on that browser for thirty days.`));
    },
    [WEB_LOGOUT_ACTION]: async (payload, { env }) => {
      const sessions = await deleteWebTokensOf(env, payload.user.id);
      await update(
        env,
        payload,
        await webView(
          env,
          payload.user.id,
          sessions
            ? `:wave: Signed out of ${sessions} browser session${sessions === 1 ? "" : "s"}.`
            : "You weren't signed in to Cade's pages in any browser. Any sign-in link you hadn't used is cancelled too.",
        ),
      );
    },
    [MCP_ACTION]: async (payload, { env }) => {
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: await mcpView(env, payload.user.id) });
    },
    [MCP_CREATE_ACTION]: async (payload, { env }) => {
      const user = payload.user.id;
      if (!mcpEnabled(env)) return update(env, payload, await mcpView(env, user));
      if (await hasMcpToken(env, user)) return update(env, payload, await mcpView(env, user, "You have an API key already, and I can't show it again."));
      await update(env, payload, await mcpView(env, user, granted(endpointUrl(env), await grantToken(env, user))));
    },
    [MCP_REVOKE_ACTION]: async (payload, { env }) => {
      const user = payload.user.id;
      const done = await revokeToken(env, user);
      await update(
        env,
        payload,
        await mcpView(env, user, done ? "Done. Your API key no longer works, so your AI agent can't use Cade until you make a new one." : "You have no API key to revoke."),
      );
    },
  },
} satisfies Handler;
