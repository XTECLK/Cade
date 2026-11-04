// Writes the website's MCP pages from the tool definitions in src/mcp-tools.js, so the site and
// the server can't disagree: docs/mcp.html (how to connect an agent, which `/cade mcp status` links to, and every tool, its
// arguments and its result) and the
// list of tools in docs/index.html, between its mcp-tools markers. `npm run docs` writes them;
// test/docs.test.js checks they are up to date.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FLOWS } from "../src/flows.js";
import { TOOL_DEFS } from "../src/mcp-tools.js";

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const code = (text) => `<code>${escape(text)}</code>`;

// The rows of a schema's properties, nested ones with a dotted name: [{ name, type, required, note }].
export function rows(schema, prefix = "", required = new Set(schema.required ?? [])) {
  return Object.entries(schema.properties ?? {}).flatMap(([key, property]) => {
    const name = prefix + key;
    const nested = property.type === "array" ? property.items : property;
    const kind = [property.type].flat().join(" or ");
    const type = property.enum ? `${kind}: ${property.enum.join(" | ")}` : property.type === "array" ? `${[nested.type].flat().join(" or ")}[]${nested.enum ? `: ${nested.enum.join(" | ")}` : ""}` : kind;
    const limits = [property.minimum !== undefined && `min ${property.minimum}`, property.maximum !== undefined && `max ${property.maximum}`].filter(Boolean).join(", ");
    const note = [property.description, nested !== property ? nested.description : "", limits].filter(Boolean).join(" · ");
    const own = { name, type, required: required.has(key), note };
    return nested.properties ? [own, ...rows(nested, `${name}${property.type === "array" ? "[]." : "."}`, new Set(nested.required ?? []))] : [own];
  });
}

// "one of task_id, link" for a schema's anyOf of required alternatives, or "".
function oneOf(schema) {
  const names = (schema.anyOf ?? []).map((option) => option.required?.[0]).filter(Boolean);
  return names.length ? `Give one of ${names.map(code).join(" or ")}.` : "";
}

function table(schema, empty) {
  const list = rows(schema);
  if (!list.length) return `<p class="none">${empty}</p>`;
  const body = list
    .map((row) => `<tr><td>${code(row.name)}</td><td>${escape(row.type)}</td><td>${row.required ? "yes" : ""}</td><td>${escape(row.note)}</td></tr>`)
    .join("\n");
  return `<div class="tablewrap"><table>\n<thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Notes</th></tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`;
}

// A short "name(args) → results" line for the home page.
function summary(tool) {
  const args = Object.keys(tool.inputSchema.properties ?? {});
  const gives = Object.keys(tool.outputSchema.properties ?? {});
  return `<li><a href="mcp.html#${tool.name}"><code>${tool.name}</code></a>${args.length ? ` (${escape(args.join(", "))})` : ""} → ${gives.slice(0, 4).map(code).join(", ")}${gives.length > 4 ? ", …" : ""}</li>`;
}

export function toolList() {
  return `<div class="feature"><div class="bar"></div><h3>Tools, from the server's own definitions</h3>
        <ul class="tools">
          ${TOOL_DEFS.map(summary).join("\n          ")}
        </ul>
        <p><a href="mcp.html">Every argument and result →</a></p></div>`;
}

export function mcpPage() {
  const flowItems = FLOWS.map((flow) => `      <li><code>${escape(flow.name)}</code>: ${escape(flow.description)}.</li>`).join("\n");
  const sections = TOOL_DEFS.map(
    (tool) => `<section class="tool" id="${tool.name}">
  <div class="wrap">
    <h2>${code(tool.name)}</h2>
    <p>${escape(tool.description)}</p>
    ${oneOf(tool.inputSchema) ? `<p>${oneOf(tool.inputSchema)}</p>` : ""}
    <h3>Arguments <small>inputSchema</small></h3>
    ${table(tool.inputSchema, "None.")}
    <h3>Result <small>outputSchema, in structuredContent</small></h3>
    ${table(tool.outputSchema, "Text only.")}
  </div>
</section>`,
  ).join("\n\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cade · MCP tools</title>
<meta name="description" content="Every tool Cade's MCP server offers: its arguments, and the structured result it gives back.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="style.css">
</head>
<body>

<nav>
  <div class="wrap">
    <a class="brand" href="index.html"><span class="logo">C</span>Cade</a>
    <ul>
      <li><a href="index.html#how">How it works</a></li>
      <li><a href="index.html#mcp">AI agents</a></li>
      <li><a href="commands.html">Commands</a></li>
    </ul>
    <div class="nav-right">
      <a class="btn primary nav-cta" href="setup.html">Set up</a>
      <button class="theme" id="theme" type="button" aria-label="Toggle dark mode">◐</button>
    </div>
  </div>
</nav>

<header class="guide-head">
  <div class="wrap">
    <div class="eyebrow">MCP reference</div>
    <h1>Every tool, what it takes and what it gives back.</h1>
    <p class="lede">How to connect your own AI agent to Cade, and every tool it gets, generated from the server's own tool definitions, so it is always what an agent sees in <code>tools/list</code>. A result is text and, matching its schema, <code>structuredContent</code>, so an agent can pass one tool's IDs to the next.</p>
  </div>
</header>

<section class="tool" id="connect">
  <div class="wrap">
    <h2>Connect your agent</h2>
    <p><b>1.</b> In Slack send <code>/cade mcp init</code>. Cade shows the key to you only, once, with this Cade's MCP endpoint (<code>/cade mcp status</code> shows the endpoint again, and whether you have a key). <code>/cade mcp revoke</code> ends the key.</p>
    <p><b>2.</b> Add Cade to your agent as a remote MCP server (Streamable HTTP), with the key in the header <code>x-apikey</code>. Replace the two placeholders with the endpoint and key from step 1:</p>
    <h3>Claude Code</h3>
    <pre class="term"><code>claude mcp add --transport http cade https://YOUR-CADE-WORKER/mcp --header "x-apikey: YOUR_API_KEY"</code></pre>
    <h3>Gemini CLI</h3>
    <pre class="term"><code>gemini mcp add --transport http cade https://YOUR-CADE-WORKER/mcp --header "x-apikey: YOUR_API_KEY"</code></pre>
    <h3>Cursor, Codex and other clients</h3>
    <p>Add a remote MCP server with the endpoint and the header <code>x-apikey</code> set to your key. The Claude.ai and Gemini web apps can't send a custom header, so they can't connect yet.</p>
    <p><b>3.</b> Ask your agent something like "list my Cade tasks". Everything runs as you, so it reads only what you can read, and anything that changes a task or posts a message is shown to you first.</p>
    <h3>Flows</h3>
    <p>Step-by-step jobs your agent follows with <code>get_flow</code>, which Claude Code also lists as slash commands:</p>
    <ul>
${flowItems}
    </ul>
  </div>
</section>

${sections}

<footer>
  <div class="wrap">
    <span>Cade: from any message to shipped, in Slack.</span>
    <a href="index.html">Home →</a>
  </div>
</footer>

<script>
  (() => {
    const root = document.documentElement;
    try {
      const saved = localStorage.getItem("cade-theme");
      if (saved) root.dataset.theme = saved;
    } catch {}
    document.getElementById("theme").addEventListener("click", () => {
      const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = dark ? "light" : "dark";
      try { localStorage.setItem("cade-theme", root.dataset.theme); } catch {}
    });
  })();
</script>
</body>
</html>
`;
}

// docs/index.html with the list between its markers made from the definitions.
export function indexPage(html) {
  const pattern = /(<!-- mcp-tools:start -->)[\s\S]*?(<!-- mcp-tools:end -->)/;
  if (!pattern.test(html)) throw new Error("docs/index.html has no mcp-tools markers");
  return html.replace(pattern, `$1\n      ${toolList()}\n      $2`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const docs = new URL("../docs/", import.meta.url);
  writeFileSync(new URL("mcp.html", docs), mcpPage());
  const index = new URL("index.html", docs);
  writeFileSync(index, indexPage(readFileSync(index, "utf8")));
  console.log("Wrote docs/mcp.html and the tool list in docs/index.html");
}
