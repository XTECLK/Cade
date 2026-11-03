import { hasMcpToken } from "../db.js";
import { endpointUrl, grantToken, revokeToken } from "../mcp.js";

// `/cade mcp init` gives the person an API key of their own for Cade's MCP
// endpoint (see mcp.js), as one only they are shown, and `/cade mcp
// revoke` ends it. With it their AI agent, whichever they use, can read the
// threads they can read and write a task's summary as them. The key can't
// be shown again, and `init` makes none while there is one: to change it,
// `revoke` it first, then `init` for a new one.
export default {
  name: "mcp",
  description: "Let your AI agent summarize threads into tasks: `init` gives you an API key for it, `revoke` ends it",
  slashUsage: ["/cade mcp init", "/cade mcp revoke"],
  section: "work",
  async slash(command, { env }) {
    const action = command.text.trim().toLowerCase();
    if (action === "init") {
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
    return "Send `/cade mcp init` to set up your AI agent access to Cade, or `/cade mcp revoke` to take it away.";
  },
};

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
    "It lets your agent read the threads you can read and write task summaries as you, so keep the key to yourself. `/cade mcp revoke` ends it, and I can't show it again: `/cade mcp init` makes a new one.",
  ].join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
