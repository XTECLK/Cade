#!/usr/bin/env node
// Saves a deployment's prompts to its database, for Cade's MCP server to offer (prompts/list and
// prompts/get): workflows built on its tools that a person picks in their agent. They are the
// deployment's own, Markdown files in the prompts/ folder of its deploy repo (the cade-deploy template
// starts it with examples). `npm run prompts` reads them, checks each against the tools of this version
// of Cade (nothing is saved while one is wrong), and replaces the prompts in the database with them;
// `npm run deploy` does too, checking them before it deploys, so an upgrade whose tools a prompt no longer
// matches stops there. `-- --local` saves them to `npm run dev`'s database; `-- --check` only checks.
//
// A prompt's file (see prompts/README.md in the template):
//
//   ---
//   description: One sentence a client shows next to the prompt.
//   arguments:
//     task: What the person gives for it.
//     period?: An argument they may leave out ends in ?.
//   ---
//
//   # The prompt's title
//
//   The instructions, which the agent is given with the arguments after them.
//
// Its name is the file's (task-summary.md is task-summary). A README.md in the folder isn't a prompt.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DEFS } from "../src/mcp-tools.ts";
import { HOME, ROOT } from "./paths.ts";

export type Prompt = {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  text: string;
};

export const PROMPTS_DIR = `${HOME}prompts/`;

// The prompts in `dir`, by name; a file that isn't one throws, saying which and why.
export function readPrompts(dir = PROMPTS_DIR): Prompt[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .map((file) => parsePrompt(file.slice(0, -".md".length), readFileSync(join(dir, file), "utf8")))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function parsePrompt(name: string, source: string): Prompt {
  const wrong = (problem: string) => new Error(`prompts/${name}.md: ${problem}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw wrong("its name is lowercase words joined by -");
  const parts = /^---\n([\s\S]*?)\n---\n+# (.+)\n+([\s\S]+)$/.exec(source.replace(/\r\n/g, "\n"));
  if (!parts) throw wrong("it starts with --- frontmatter ---, then a # title, then the instructions");
  // The three groups always match when the whole does.
  const [, front = "", title = "", body = ""] = parts;
  const description = /^description: (.+)$/m.exec(front)?.[1]?.trim();
  if (!description) throw wrong("its frontmatter has a description");
  const args = /^arguments:\n((?: {2}.+\n?)+)/m.exec(front)?.[1] ?? "";
  const argumentList = args
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const arg = /^ {2}([a-z_]+)(\??): (.+)$/.exec(line);
      if (!arg) throw wrong(`"${line.trim()}" isn't an argument (name: what it is)`);
      return { name: arg[1]!, description: arg[3]!.trim(), required: !arg[2] };
    });
  return { name, title: title.trim(), description, arguments: argumentList, text: `# ${title.trim()}\n\n${body.trim()}\n` };
}

// Every name a tool has: the tools', and every property of their arguments and results, at any depth.
function namesIn(schema: unknown, names: Set<string>) {
  if (!schema || typeof schema !== "object") return;
  const { properties } = schema as { properties?: Record<string, unknown> };
  for (const name of Object.keys(properties ?? {})) names.add(name);
  for (const value of Object.values(schema)) namesIn(value, names);
}
const KNOWN = new Set(TOOL_DEFS.map((tool) => tool.name));
for (const tool of TOOL_DEFS) {
  namesIn(tool.inputSchema, KNOWN);
  namesIn(tool.outputSchema, KNOWN);
}

// What is wrong with the prompts against this version of Cade's tools, one line each: a tool or field
// they name that no tool has (in backticks: `get_task`, `original_thread.thread_id`), or a prompt they
// name (**task-summary** prompt) that isn't one of them.
export function promptProblems(prompts: Prompt[]) {
  return prompts.flatMap(({ name, text }) => {
    const named = [...text.matchAll(/`([a-z_.]+)/g)].flatMap(([, code]) => code!.split(".")).filter((part) => part.includes("_"));
    const tools = [...new Set(named)].filter((part) => !KNOWN.has(part)).map((part) => `${name}: names ${part}, which no tool of this Cade has`);
    const others = [...text.matchAll(/\*\*([a-z0-9-]+)\*\* prompt/g)].map(([, other]) => other!).filter((other) => !prompts.some((prompt) => prompt.name === other));
    return [...tools, ...others.map((other) => `${name}: names the prompt ${other}, which isn't in prompts/`)];
  });
}

// A short hash of a prompt as saved, which the server's version is made from (see toolsetVersion in mcp.ts).
const hashOf = (prompt: Prompt) => createHash("sha256").update(JSON.stringify(prompt)).digest("hex").slice(0, 12);

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

// The SQL that makes the prompts table exactly these prompts. A prompt that is unchanged keeps its row,
// so its updated_at says when it last changed.
export function promptsSql(prompts: Prompt[]) {
  const keep = prompts.map((prompt) => quote(prompt.name)).join(", ");
  const rows = prompts.map((prompt) => {
    const values = [prompt.name, prompt.title, prompt.description, JSON.stringify(prompt.arguments), prompt.text, hashOf(prompt)].map(quote).join(", ");
    return `INSERT INTO prompts (name, title, description, arguments, text, hash) VALUES (${values})
  ON CONFLICT (name) DO UPDATE SET title = excluded.title, description = excluded.description, arguments = excluded.arguments,
  text = excluded.text, hash = excluded.hash, updated_at = CURRENT_TIMESTAMP WHERE prompts.hash <> excluded.hash;`;
  });
  return [`DELETE FROM prompts${prompts.length ? ` WHERE name NOT IN (${keep})` : ""};`, ...rows].join("\n");
}

export async function savePrompts({ local = false, check = false } = {}) {
  if (!existsSync(PROMPTS_DIR)) {
    console.log(`No prompts/ folder in ${HOME}: no prompts saved, and those saved before are kept.`);
    return;
  }
  const prompts = readPrompts();
  const problems = promptProblems(prompts);
  if (problems.length) throw new Error(`The prompts don't match this version of Cade's tools; nothing was saved.\n${problems.map((line) => `  ${line}`).join("\n")}`);
  for (const prompt of prompts) {
    const args = prompt.arguments.map((arg) => (arg.required ? arg.name : `${arg.name}?`)).join(", ");
    console.log(`${prompt.name}${args ? ` (${args})` : ""}: ${prompt.title}`);
  }
  if (check) {
    console.log(`The ${prompts.length} prompt${prompts.length === 1 ? "" : "s"} in prompts/ match this version of Cade's tools.`);
    return;
  }
  if (!prompts.length) console.log("prompts/ has no prompts: the database's are removed.");

  // `wrangler d1 execute --file` runs them as one; the file is removed straight after.
  const dir = await mkdtemp(join(tmpdir(), "cade-prompts-"));
  try {
    const file = join(dir, "prompts.sql");
    await writeFile(file, promptsSql(prompts));
    const code = await new Promise((resolve) => {
      spawn("node", ["scripts/wrangler.ts", "d1", "execute", "DB", local ? "--local" : "--remote", "--file", file], { cwd: ROOT, stdio: "inherit" }).on("exit", resolve);
    });
    if (code !== 0) throw new Error("Saving the prompts failed (wrangler d1 execute).");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(`Saved ${prompts.length} prompt${prompts.length === 1 ? "" : "s"}. Agents connected now are told to reconnect to load them.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  savePrompts({ local: process.argv.includes("--local"), check: process.argv.includes("--check") }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
