import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePrompt, promptProblems, promptsSql, readPrompts } from "../scripts/prompts.ts";
import { fakeD1 } from "./d1.ts";
import { EXAMPLE } from "./helpers.ts";

// A deployment's prompts are Markdown files in its deploy repo's prompts/ folder, which `npm run prompts`
// checks against Cade's tools and saves to the database, for the MCP server to offer (see
// scripts/prompts.ts). The cade-deploy template starts the folder with examples.

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
  // Saved on Windows, it reads the same.
  assert.deepEqual(parsePrompt("crlf", "---\r\ndescription: x\r\n---\r\n# T\r\nSteps.\r\n").title, "T");
  // A file that isn't one says which and why, rather than saving something half read.
  assert.throws(() => parsePrompt("Bad_Name", "---\ndescription: x\n---\n# T\nx"), /prompts\/Bad_Name\.md: its name/);
  assert.throws(() => parsePrompt("no-title", "---\ndescription: x\n---\nSteps."), /no-title\.md: it starts with/);
  assert.throws(() => parsePrompt("no-description", "---\narguments:\n  task: x\n---\n# T\nx"), /has a description/);
  assert.throws(() => parsePrompt("bad-argument", "---\ndescription: x\narguments:\n  Task x\n---\n# T\nx"), /"Task x" isn't an argument/);
});

test("the prompts in a folder are its Markdown files but the README, by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "cade-prompts-test-"));
  writeFileSync(join(dir, "task-summary.md"), EXAMPLE);
  writeFileSync(join(dir, "a-report.md"), "---\ndescription: A report.\n---\n# Report\nSteps.");
  writeFileSync(join(dir, "README.md"), "# How to write a prompt\nNot a prompt.");
  writeFileSync(join(dir, "notes.txt"), "Not a prompt either.");
  assert.deepEqual(readPrompts(dir).map((prompt) => prompt.name), ["a-report", "task-summary"]);
});

test("a prompt may name only the tools and fields this Cade has, and prompts that are there", () => {
  const example = parsePrompt("task-summary", EXAMPLE);
  assert.deepEqual(promptProblems([example]), []);
  // A tool a newer Cade renamed or removed, and a prompt that isn't in the folder.
  const stale = parsePrompt("report", "---\ndescription: x\n---\n# Report\n\n`get_executive_summary` with `task_id`, then the **summary-v2** prompt.\n");
  assert.deepEqual(promptProblems([example, stale]), [
    "report: names get_executive_summary, which no tool of this Cade has",
    "report: names the prompt summary-v2, which isn't in prompts/",
  ]);
});

test("saving prompts makes the table exactly them, and leaves an unchanged one as it was", async () => {
  const DB = fakeD1();
  const rows = async () => (await DB.prepare("SELECT name, title, arguments, hash, updated_at FROM prompts ORDER BY name").all<any>()).results;
  const summary = parsePrompt("task-summary", EXAMPLE);
  const report = parsePrompt("report", "---\ndescription: It's a report.\n---\n# Client's report\nSteps.");
  await DB.exec(promptsSql([summary, report]));
  const first = await rows();
  assert.deepEqual(first.map((row) => [row.name, row.title]), [["report", "Client's report"], ["task-summary", "Summarize a task"]]);
  assert.deepEqual(JSON.parse(first[1].arguments), [{ name: "task", description: "The task: its ID, a link to its card, or its title.", required: true }]);

  // Unchanged, a prompt keeps its row; changed, its hash changes; taken out of the folder, it goes.
  await DB.prepare("UPDATE prompts SET updated_at = '2000-01-01 00:00:00'").run();
  await DB.exec(promptsSql([{ ...summary, description: "Changed." }]));
  const second = await rows();
  assert.deepEqual(second.map((row) => row.name), ["task-summary"]);
  assert.notEqual(second[0].hash, first[1].hash);
  assert.notEqual(second[0].updated_at, "2000-01-01 00:00:00");
  await DB.prepare("UPDATE prompts SET updated_at = '2000-01-01 00:00:00'").run();
  await DB.exec(promptsSql([{ ...summary, description: "Changed." }]));
  assert.equal((await rows())[0].updated_at, "2000-01-01 00:00:00");

  // An empty folder means no prompts.
  await DB.exec(promptsSql([]));
  assert.deepEqual(await rows(), []);
});

test("only `npm run prompts` writes the prompts: the Worker's code reads them and nothing more", () => {
  // A prompt is instructions every connected agent follows, so nothing from Slack or an agent may change one.
  const files = (dir: URL): URL[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(new URL(`${entry.name}/`, dir)) : [new URL(entry.name, dir)]));
  for (const file of files(new URL("../src/", import.meta.url))) {
    const code = readFileSync(file, "utf8");
    assert.doesNotMatch(code, /(INSERT|REPLACE)\s+(OR\s+\w+\s+)?INTO\s+prompts\b|UPDATE\s+prompts\b|DELETE\s+FROM\s+prompts\b/i, file.pathname);
  }
});
