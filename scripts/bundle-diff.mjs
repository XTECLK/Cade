#!/usr/bin/env node
// For a change that should do nothing when it runs, such as a refactor or added types: builds the
// Worker as it is now and as it was at a git ref (HEAD by default), as wrangler deploys it, and
// compares the two. The same code means the change can't have changed what the Worker does,
// tested or not.
//
//   npm run bundle-diff               against the last commit
//   npm run bundle-diff -- main~3     against any ref
//
// What can't change what runs is left out of the comparison: whitespace and line breaks, comments
// on lines of their own, the files' extensions (.js and .ts), "use strict", and the numbers esbuild adds to rename a local
// that shares a name with another (mentions2 and mentions4 are the same). Exits 0 when the code
// is the same, 1 when it differs, showing where.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

// The Worker's code from the source in `dir`, as `wrangler deploy` would upload it.
function build(dir, out) {
  run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out], dir);
  return readFileSync(join(out, "index.js"), "utf8");
}

// The code with what can't change what it does taken out, a statement or block per line, so
// a difference shows where it is.
export function normalize(code) {
  return code
    .split("\n")
    .filter((line) => !/sourceMappingURL|^\s*"use strict";\s*$|^\s*\/\//.test(line))
    .join("\n")
    // A dependency named by its path on disk, as the build at the ref, through a link, names it.
    .replace(/(?:\.\.\/)+[^"\s]*?\/node_modules\//g, "node_modules/")
    .replace(/\.(ts|js)\b/g, ".X")
    .replace(/\b([A-Za-z_$]+?)\d+\b/g, "$1N")
    .replace(/\s+/g, "")
    .replace(/([;{}])/g, "$1\n");
}

export function main(ref = "HEAD") {
  const scratch = mkdtempSync(join(tmpdir(), "cade-bundle-"));
  const before = join(scratch, "src");
  try {
    run("git", ["worktree", "add", "--detach", "--quiet", before, ref], ROOT);
    // The dependencies as installed now: a ref whose package.json differs may need its own.
    symlinkSync(join(ROOT, "node_modules"), join(before, "node_modules"));
    const [was, now] = [build(before, join(scratch, "was")), build(ROOT, join(scratch, "now"))].map(normalize);
    if (was === now) {
      console.log(`The Worker's code is the same as at ${ref}.`);
      return 0;
    }
    const wasLines = was.split("\n");
    const nowLines = now.split("\n");
    const first = wasLines.findIndex((line, i) => line !== nowLines[i]);
    console.log(`The Worker's code differs from ${ref}; the first difference, statement by statement:`);
    console.log(wasLines.slice(first, first + 5).map((line) => `- ${line}`).join("\n"));
    console.log(nowLines.slice(first, first + 5).map((line) => `+ ${line}`).join("\n"));
    return 1;
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", before], { cwd: ROOT });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
