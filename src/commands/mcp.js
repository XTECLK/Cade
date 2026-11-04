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
  const { tools, flows } = mcpCatalog();
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
    on ? `*Offers:* ${tools.length} tools and ${flows.length} flows` : "",
    on ? `*Setup guide:* <${MCP_GUIDE}|How to connect your AI agent>` : "",
    "Everything runs as you, so your agent reads only what you can read. Changes and messages it makes are posted in the task's thread under your name, after you approve them.",
  ].filter(Boolean).join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

// The commands to run in each kind of AI agent to add Cade, for the endpoint
// `url` and the API key `key`, sent as a header with every request.
export function setupSteps(url, key) {
  return [
    "*Claude Code:*",
    `\`\`\`claude mcp add --transport http cade ${url} --header "x-apikey: ${key}"\`\`\``,
    "*Gemini CLI:*",
    `\`\`\`gemini mcp add --transport http cade ${url} --header "x-apikey: ${key}"\`\`\``,
    "*Cursor, Codex and any other client that takes a remote MCP server:* the URL above (Streamable HTTP), and the header `x-apikey` with your API key as its value.",
  ].join("\n");
}

// What `/cade mcp init` answers, for the person's new API key.
function granted(url, key) {
  const text = [
    ":key: *Your Cade MCP connection.* Add it to your AI agent once, as a remote MCP server:",
    "*Endpoint*",
    `\`\`\`${url}\`\`\``,
    "*API key*, sent with every request in the header `x-apikey`",
    `\`\`\`${key}\`\`\``,
    setupSteps(url, key),
    `Step by step: <${MCP_GUIDE}|how to connect your AI agent>.`,
    "It lets your agent read the threads you can read, and change tasks and post in their threads as you, so keep the key to yourself. `/cade mcp revoke` ends it, and I can't show it again: `/cade mcp init` makes a new one.",
  ].join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
