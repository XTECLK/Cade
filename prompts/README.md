# Prompts

Workflows Cade's MCP server offers to every connected agent (`prompts/list`, `prompts/get`), built on its tools.
A person picks one in their agent: in Claude Code, `/mcp__cade__task-summary C0123ABCD:1700000000.000100`.

## Adding or changing one

1. Add or edit a Markdown file here. Its name is the prompt's (`task-summary.md` is `task-summary`): lowercase
   words joined by `-`.
2. Run `npm run docs`. A Worker can't read files, so this puts the folder into `src/mcp-prompts.ts` (never edit
   that by hand). `npm run dev` and `npm run deploy` run it too, but commit the generated file with your change.
3. Run `npm run check`. It fails while `src/mcp-prompts.ts` is stale, or if the prompt names a tool or field
   Cade's tools don't have.

## A prompt's file

```markdown
---
description: One sentence a client shows next to the prompt.
arguments:
  task: What the person gives for it.
  period?: An argument they may leave out ends in ?.
---

# The prompt's title

The steps, naming the tools (`get_task`) and fields (`task_id`) it uses.
```

The agent is given the text from the title on, then the arguments the person gave. It already has Cade's
rules for every tool, so a prompt needn't repeat them. Still, any step that writes shows what it will write,
asks "Go ahead?" and stops, and continues "On a clear yes" (a test checks for both).

This file is not a prompt: the reader skips `README.md`.
