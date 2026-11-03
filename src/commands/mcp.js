import { grantToken, revokeToken } from "../mcp.js";

// `/cade mcp grant` gives the person a token of their own for Cade's MCP
// endpoint (see mcp.js), as an address only they are shown, and `/cade mcp
// revoke` ends it. With it their AI agent, whichever they use, can read the
// threads they can read and write a task's summary as them. Granting again
// replaces the address, so it also ends the old one.
export default {
  name: "mcp",
  description: "Let your AI agent summarize threads into tasks: `grant` gives you a private address for it, `revoke` ends it",
  slashUsage: ["/cade mcp grant", "/cade mcp revoke"],
  section: "work",
  async slash(command, { env, origin }) {
    const action = command.text.trim().toLowerCase();
    if (action === "grant") return granted(await grantToken(env, origin, command.user));
    if (action === "revoke") {
      return (await revokeToken(env, command.user))
        ? "Done. Your address no longer works, so your AI agent can't use Cade until you send `/cade mcp grant` again."
        : "You have no address to revoke. Send `/cade mcp grant` to get one.";
    }
    return "Send `/cade mcp grant` to give your AI agent access to Cade, or `/cade mcp revoke` to take it away.";
  },
};

// The commands to run in each kind of AI agent to add Cade, for `url`.
export function setupSteps(url) {
  return [
    "*Claude Code:*",
    `\`\`\`claude mcp add --transport http cade ${url}\`\`\``,
    "*Gemini CLI:*",
    `\`\`\`gemini mcp add --transport http cade ${url}\`\`\``,
    "*Claude (claude.ai, Desktop):* Settings → Connectors → Add custom connector, and paste the address.",
    "*Gemini (web):* add it as a custom connected app, with the address.",
    "*Cursor, Codex and others:* add it as a remote MCP server (Streamable HTTP) with the address.",
  ].join("\n");
}

// What `/cade mcp grant` answers, for the person's new address.
function granted(url) {
  const text = [
    ":key: *Your address for Cade's tools.* Add it to your AI agent once:",
    `\`\`\`${url}\`\`\``,
    setupSteps(url),
    "It lets your agent read the threads you can read and write task summaries as you, so keep it to yourself. `/cade mcp revoke` ends it, and I can't show it again: `/cade mcp grant` makes a new one.",
  ].join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
