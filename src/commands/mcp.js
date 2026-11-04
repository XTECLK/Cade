import { hasMcpToken, mcpTokenCreated } from "../db.js";
import { endpointUrl, grantToken, mcpCatalog, mcpEnabled, revokeToken } from "../mcp.js";

// `/cade mcp init` gives the person an API key of their own for Cade's MCP
// endpoint (see mcp.js), as one only they are shown, and `/cade mcp
// revoke` ends it. With it their AI agent, whichever they use, can read the
// threads they can read and write a task's summary as them. The key can't
// be shown again, and `init` makes none while there is one: to change it,
// `revoke` it first, then `init` for a new one.
// How to connect an agent, and every tool it gets, is on Cade's website, the same for every workspace.
export const MCP_GUIDE = "https://xteclk.github.io/Cade/mcp.html#connect";

export default {
  name: "mcp",
  description: "Let your AI agent summarize threads into tasks: `init` gives you an API key for it, `revoke` ends it",
  slashUsage: ["/cade mcp init", "/cade mcp status", "/cade mcp revoke"],
  section: "work",
  async slash(command, { env }) {
    const action = command.text.trim().toLowerCase();
    if (action === "status" || action === "info") return status(env, command.user);
    if (action === "init") {
      if (!mcpEnabled(env)) return "AI agent access is turned off for this Cade, so there is no key to give. An admin turns it on with `mcp` in cade.config.json.";
      if (await hasMcpToken(env, command.user)) {
        return "You have an API key already, and I can't show it again. To get a new one, send `/cade mcp revoke` to end it, then `/cade mcp init`.";
      }
      return granted(endpointUrl(env), await grantToken(env, command.user));
    }
    if (action === "revoke") {
      return (await revokeToken(env, command.user))
        ? "Done. Your API key no longer works, so your AI agent can't use Cade until you send `/cade mcp init` again."
        : "You have no API key to revoke. Send `/cade mcp init` to get one.";
    }
    return "Send `/cade mcp init` to set up your AI agent access to Cade, `/cade mcp status` to see whether it is set up, or `/cade mcp revoke` to take it away.";
  },
};

// What `/cade mcp status` answers: whether MCP is configured (on) for this Cade, whether the person
// has a key (never the key itself), where the endpoint is, and a link to the page that guides the setup.
// `info` is its old name and still works.
async function status(env, user) {
  const { tools } = mcpCatalog();
  const on = mcpEnabled(env);
  const made = await mcpTokenCreated(env, user);
  const key = made
    ? `:white_check_mark: made ${made.slice(0, 10)}. I can't show it again; to change it, \`/cade mcp revoke\` then \`/cade mcp init\``
    : ":x: none yet. Send `/cade mcp init` to get one";
  const text = [
    ":information_source: *Cade's MCP connection*",
    `*Configured:* ${on ? ":white_check_mark: yes, MCP is on for this Cade" : ":x: no, an admin turned it off (`mcp` in cade.config.json), so keys don't work and `/cade mcp init` gives none"}`,
    on ? `*Your API key:* ${key}` : "",
    on ? `*Endpoint:* \`${endpointUrl(env)}\` (Streamable HTTP), with your API key in the header \`x-apikey\`` : "",
    on ? `*Offers:* ${tools.length} tools` : "",
    on ? `*Setup guide:* <${MCP_GUIDE}|How to connect your AI agent>` : "",
    "Everything runs as you, so your agent reads only what you can read. Changes and messages it makes are posted in the task's thread under your name, after you approve them.",
  ].filter(Boolean).join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

// What `/cade mcp init` answers: the endpoint and the API key, each in a code block (which has
// Slack's own copy button), and the guide for connecting an agent.
function granted(url, key) {
  const text = [
    ":key: *Your Cade MCP connection.*",
    "*Endpoint*",
    `\`\`\`${url}\`\`\``,
    "*API key*, sent with every request in the header `x-apikey`",
    `\`\`\`${key}\`\`\``,
    `*How to connect:* <${MCP_GUIDE}|Step by step guide>`,
    "Keep the key to yourself: your agent acts as you. `/cade mcp revoke` ends it, and I can't show it again: `/cade mcp init` makes a new one.",
  ].join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
