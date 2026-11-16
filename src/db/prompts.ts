// The deployment's prompts, saved by `npm run prompts` (see scripts/prompts.ts).
import type { DbEnv } from "./common.ts";

// The deployment's prompts, which `npm run prompts` saves (see scripts/prompts.ts); the Worker only reads
// them. `arguments` is JSON: [{ name, description, required }].
export type PromptRow = { name: string; title: string; description: string; arguments: string; text: string };

export async function prompts(env: DbEnv) {
  return (
    await env.DB.prepare("SELECT name, title, description, arguments, text FROM prompts ORDER BY name").all<PromptRow>()
  ).results;
}

export async function promptByName(env: DbEnv, name: string) {
  return env.DB.prepare("SELECT name, title, description, arguments, text FROM prompts WHERE name = ?")
    .bind(name)
    .first<PromptRow>();
}

// Each prompt's name and hash, which change with the prompt: what the MCP server's version is made from.
export async function promptHashes(env: DbEnv) {
  const rows = (
    await env.DB.prepare("SELECT name, hash FROM prompts ORDER BY name").all<{ name: string; hash: string }>()
  ).results;
  return rows.map((row) => `${row.name}:${row.hash}`).join(",");
}
