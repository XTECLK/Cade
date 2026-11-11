import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TOOL_DEFS } from "../src/mcp-tools.ts";
import { PROMPTS } from "../src/mcp-prompts.ts";
import { parsePrompt, promptsModule, readPrompts } from "../scripts/prompts.ts";

// The prompts in prompts/ are workflows for a person's own agent, built on Cade's MCP tools and served by
// its MCP server (see scripts/prompts.ts). They name tools, arguments and result fields, so they are
// checked against the tool definitions here: a tool or field renamed or removed fails this until the
// prompt says the same.
const prompts = readPrompts();

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

test("the server's prompts are the ones in prompts/", () => {
  const generated = readFileSync(new URL("../src/mcp-prompts.ts", import.meta.url), "utf8");
  assert.equal(generated, promptsModule(), "src/mcp-prompts.ts is stale: run npm run docs");
  assert.deepEqual(
    PROMPTS.map(({ name }) => name),
    ["executive-summary", "executive-summary-after-call", "task-summary"],
  );
});

test("a prompt's file gives its title, description and arguments", () => {
  const prompt = parsePrompt("a-prompt", "---\ndescription: Does a thing.\narguments:\n  task: The task.\n  period?: When.\n---\n\n# Do a thing\n\nSteps.\n");
  assert.deepEqual(prompt, {
    name: "a-prompt",
    title: "Do a thing",
    description: "Does a thing.",
    arguments: [
      { name: "task", description: "The task.", required: true },
      { name: "period", description: "When.", required: false },
    ],
    text: "# Do a thing\n\nSteps.\n",
  });
  assert.deepEqual(parsePrompt("plain", "---\ndescription: No arguments.\n---\n# Plain\nSteps.").arguments, []);
  // A file that isn't one says which and why, rather than serving something half read.
  assert.throws(() => parsePrompt("Bad_Name", "---\ndescription: x\n---\n# T\nx"), /prompts\/Bad_Name\.md: its name/);
  assert.throws(() => parsePrompt("no-title", "---\ndescription: x\n---\nSteps."), /no-title\.md: it starts with/);
  assert.throws(() => parsePrompt("no-description", "---\narguments:\n  task: x\n---\n# T\nx"), /has a description/);
  assert.throws(() => parsePrompt("bad-argument", "---\ndescription: x\narguments:\n  Task x\n---\n# T\nx"), /"Task x" isn't an argument/);
});

test("the prompts name only tools, arguments and fields Cade's MCP server has, and only prompts that exist", () => {
  for (const { name, text } of prompts) {
    // `get_task`, `task_id`, `original_thread.thread_id`: each part with an underscore is a tool or a field.
    const named = [...text.matchAll(/`([a-z_.]+)/g)].flatMap(([, code]) => code!.split(".")).filter((part) => part.includes("_"));
    assert.ok(named.length, name);
    for (const part of named) assert.ok(KNOWN.has(part), `${name} names ${part}, which no tool has`);
    for (const [, other] of text.matchAll(/\*\*([a-z0-9-]+)\*\* prompt/g)) assert.ok(prompts.some((prompt) => prompt.name === other), `${name} names the prompt ${other}`);
  }
});

test("every prompt that changes something asks for approval first, as the guardrails do", () => {
  for (const { name, text } of prompts) {
    assert.match(text, /"Go ahead\?" and stop/, name);
    assert.match(text, /On a clear yes/, name);
  }
});
