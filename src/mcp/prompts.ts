// The deployment's prompts as tools: get_prompts and get_prompt (the protocol's prompts/list and prompts/get
// are in mcp.ts).
import { promptByName, prompts, type PromptRow } from "../db.ts";
import type { GetPromptArgs, GetPromptsArgs } from "../mcp-args.ts";
import type { AppEnv } from "../env.ts";
import { ToolError } from "./common.ts";

// A prompt's arguments, as saved (JSON, written by scripts/prompts.ts).
export const argumentsOf = (prompt: Pick<PromptRow, "arguments">): PromptArgument[] => JSON.parse(prompt.arguments);
type PromptArgument = { name: string; description: string; required: boolean };

// A prompt's instructions with the arguments `given` after them, or the problem with them.
export function promptWith(prompt: PromptRow, given: unknown): { text: string; problem?: undefined } | { text?: undefined; problem: string } {
  if (typeof given !== "object" || given === null || Array.isArray(given)) return { problem: "arguments is an object of strings" };
  const args = argumentsOf(prompt);
  const values = new Map(Object.entries(given).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""));
  const missing = args.filter((arg) => arg.required && !values.has(arg.name));
  if (missing.length) return { problem: `The prompt ${prompt.name} needs ${missing.map((arg) => arg.name).join(" and ")}` };
  const lines = args.flatMap((arg) => {
    const value = values.get(arg.name);
    return value ? [`- ${arg.name}: ${value.trim()}`] : [];
  });
  return { text: lines.length ? `${prompt.text}\n## Given\n\n${lines.join("\n")}\n` : prompt.text };
}

// The same prompt as a tool: an agent can't pick a prompt itself, but a tool's result can name one for it to
// read (see getTaskSummary). Only the deployment's own prompts, which `npm run prompts` saves, are given.
export async function getPromptTool(env: AppEnv, _user: string, args: GetPromptArgs) {
  const prompt = await promptByName(env, args.name);
  if (!prompt) {
    const names = (await prompts(env)).map((one) => one.name);
    throw new ToolError(`There is no prompt called "${args.name}".${names.length ? ` They are: ${names.join(", ")}.` : " This deployment has none."}`);
  }
  const filled = promptWith(prompt, args.arguments ?? {});
  if (filled.problem !== undefined) throw new ToolError(`${filled.problem}.`);
  return { text: filled.text, data: { name: prompt.name, description: prompt.description, text: filled.text } };
}

// The deployment's prompts, as prompts/list gives them to the person's client, for the agent itself: the
// guardrails tell it to check them, as it never sees that list.
export async function getPromptsTool(env: AppEnv, _user: string, _args: GetPromptsArgs) {
  const all = (await prompts(env)).map((prompt) => ({ name: prompt.name, description: prompt.description, arguments: argumentsOf(prompt) }));
  if (!all.length) return { text: "This deployment has no prompts: work with the tools as usual.", data: { total: 0, prompts: [] } };
  const lines = all.map((prompt) => {
    const args = prompt.arguments.map((arg) => (arg.required ? arg.name : `${arg.name}?`)).join(", ");
    return `- ${prompt.name}${args ? ` (${args})` : ""}: ${prompt.description}`;
  });
  return { text: [`${all.length} prompt${all.length === 1 ? "" : "s"}, read one with get_prompt:`, ...lines].join("\n"), data: { total: all.length, prompts: all } };
}

// The prompt with the team's steps for a task's summary, when the deployment has one.
export const SUMMARY_PROMPT = "task-summary";
