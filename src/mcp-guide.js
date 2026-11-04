import { publicUrl } from "./links.js";
import { FLOWS } from "./flows.js";
import { TOOL_DEFS } from "./mcp-tools.js";
import { endpointUrl, mcpEnabled } from "./mcp.js";
import { escapeHtml, page } from "./web.js";

// The page `/cade mcp status` links to, `/mcp/guide` on the Worker: how a person connects their own AI
// agent to Cade. It holds nothing secret (the key is shown only by `/cade mcp init`, in Slack), so
// anyone with the link can read it; it names this Cade's endpoint and lists its tools and flows
// from the same definitions the server uses.
export function guideUrl(env) {
  return `${publicUrl(env)}/mcp/guide`;
}

export function handleMcpGuide(request, env) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });
  if (!mcpEnabled(env)) return page(404, "AI agent access is off", "<p>An admin has turned AI agent access (MCP) off for this Cade, so there is nothing to set up. It is turned on with <code>mcp</code> in <code>cade.config.json</code>.</p>");
  const url = escapeHtml(endpointUrl(env));
  const code = (text) => `<pre><code>${escapeHtml(text)}</code></pre>`;
  const key = "YOUR_API_KEY";
  const tools = TOOL_DEFS.map((tool) => {
    const sentence = tool.description.split(/(?<=[.!?])\s/)[0];
    const writes = tool.annotations?.readOnlyHint === false;
    return `<tr><td><code>${escapeHtml(tool.name)}</code></td><td>${escapeHtml(sentence)}</td><td>${writes ? "changes things, after you approve" : "read only"}</td></tr>`;
  }).join("");
  const flows = FLOWS.map((flow) => `<li><code>${escapeHtml(flow.name)}</code>: ${escapeHtml(flow.description)}.</li>`).join("");
  return page(
    200,
    "Connect your AI agent to Cade",
    `<p class="meta">Your own agent (Claude Code, Gemini CLI, Cursor, Codex, …) reads your tasks and threads and, after you approve, changes a task or posts in its thread, as you. It uses the model and subscription you already have.</p>
<h2>1. Get your API key</h2>
<p>In Slack send <code>/cade mcp init</code>. Cade shows the key to you only, once. Keep it to yourself; <code>/cade mcp revoke</code> ends it and <code>/cade mcp init</code> makes a new one.</p>
<h2>2. Add Cade to your agent</h2>
<p>Cade's MCP endpoint is <code>${url}</code> (Streamable HTTP). Your key goes in the header <code>x-apikey</code>.</p>
<h3>Claude Code</h3>${code(`claude mcp add --transport http cade ${endpointUrl(env)} --header "x-apikey: ${key}"`)}
<h3>Gemini CLI</h3>${code(`gemini mcp add --transport http cade ${endpointUrl(env)} --header "x-apikey: ${key}"`)}
<h3>Cursor, Codex and other clients</h3>
<p>Add a remote MCP server with the URL above and the header <code>x-apikey</code> set to your key.</p>
<p>Replace <code>${key}</code> with your key. The Claude.ai and Gemini web apps can't send a custom header, so they can't connect yet.</p>
<h2>3. Check it</h2>
<p>Send <code>/cade mcp status</code> in Slack to see whether it is on and whether you have a key. Then ask your agent something like "list my Cade tasks".</p>
<h2>What your agent can do</h2>
<table><thead><tr><th>Tool</th><th>What it does</th><th></th></tr></thead><tbody>${tools}</tbody></table>
<h3>Flows</h3>
<p>Step-by-step jobs your agent can follow with <code>get_flow</code>, and that Claude Code lists as slash commands:</p><ul>${flows}</ul>
<p class="meta">Everything runs as you, so your agent reads only what you can read. Anything that changes a task or posts a message is shown to you first.</p>`,
  );
}
