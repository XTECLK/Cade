#!/usr/bin/env node
// Takes you through GETTING_STARTED.md in one command: Cloudflare login, the
// Worker, the Slack app, the first admin, and, optionally, a GitHub token. It runs the same npm scripts the guide names, so each can also be
// run alone, and it skips what's already done: run it again to carry on.
//
//   npm run setup
//
// Tokens and secrets are asked for by those scripts, hidden, never here.
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HOME, ROOT } from "./paths.ts";
import { ask, choose, confirm, intro, log, note, openUrl, outro, pause } from "./prompt.ts";

const SLACK_APP = `${HOME}.cade/slack-app.json`;

// The Worker's URL in what `wrangler deploy` printed.
export function workerUrlIn(output) {
  return /https:\/\/[\w.-]+\.workers\.dev/.exec(output)?.[0];
}

// The accounts in what `wrangler whoami` printed: a table of rows like
// "│ Acme's Account │ 0123…cdef │". The name is the row's other cell; a row
// without one is named by its ID.
export function accountsIn(output: string): { id: string; name: string }[] {
  const accounts = new Map<string, string>();
  for (const line of output.split("\n")) {
    const id = /\b[0-9a-f]{32}\b/.exec(line)?.[0];
    if (!id || accounts.has(id)) continue;
    const cells = /[│|]/.test(line) ? line.split(/[│|]/).map((cell) => cell.trim()) : [];
    const name = cells.find((cell) => cell && cell !== id);
    accounts.set(id, name ?? id);
  }
  return [...accounts].map(([id, name]) => ({ id, name }));
}

async function exists(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}

// Runs a command in this folder, showing its output (and taking input), and
// returns { code, output }.
function run(command: string, args: string[], { env = process.env } = {}) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
        (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
      });
    }
    child.on("error", (error) => resolve({ code: 1, output: String(error) }));
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

// Like run, but with the terminal itself, for logins and hidden prompts.
function runLive(command, args) {
  return new Promise((resolve) => {
    const done = resolve;
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code ?? 1));
  });
}

const STEPS = 5;
let stepNumber = 0;
const outcomes = [];
async function step(title, work) {
  stepNumber++;
  log.step(`[${stepNumber}/${STEPS}] ${title}`);
  const note = await work();
  outcomes.push(`${note?.startsWith("skipped") ? "–" : "✓"} ${title}${note ? ` (${note})` : ""}`);
}

async function main() {
  intro("Cade setup");
  // Shows an address and opens it once the person presses Enter.
  const openPage = async (url, message) => {
    console.log(`${message}\n  ${url}`);
    if (await confirm("Open it in your browser?")) openUrl(url);
  };
  const fail = (message) => {
    console.error(`\n${message}\nRun npm run setup again to carry on from here.`);
    process.exit(1);
  };

  log.info("Each step is skipped if it's done already, so you can stop and run this again.");

  await step("Cloudflare", async () => {
    let who = await run("npx", ["wrangler", "whoami"]);
    if (who.code !== 0 || /not authenticated/i.test(who.output)) {
      console.log("Logging in to Cloudflare; approve access in the browser…");
      if ((await runLive("npx", ["wrangler", "login"])) !== 0) fail("Cloudflare login failed.");
      who = await run("npx", ["wrangler", "whoami"]);
    }
    const accounts = accountsIn(who.output);
    if (accounts.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID && !(await exists(`${HOME}.cade/cloudflare.json`))) {
      process.env.CLOUDFLARE_ACCOUNT_ID = await choose(
        "Several Cloudflare accounts are listed. Which one is Cade deployed to?",
        accounts.map(({ id, name }) => ({ label: name, value: id, hint: id })),
      );
      await import("./cloudflare.ts"); // saves it for every script
    }
  });

  let workerUrl;
  await step("Worker", async () => {
    console.log("Deploying; Wrangler may ask to confirm creating the database tables.");
    const deployed = await run("npm", ["run", "deploy"]);
    if (deployed.code !== 0) fail("The deploy failed. If only the tables step failed, npm run db:migrate retries it.");
    workerUrl = workerUrlIn(deployed.output);
    if (!workerUrl) workerUrl = await ask("Couldn't find the Worker URL. Paste it (https://….workers.dev): ");
  });

  await step("Slack app", async () => {
    if (await exists(SLACK_APP)) {
      console.log("The Slack app is already created (.cade/slack-app.json).");
      return "skipped, already created";
    }
    await openPage(
      "https://api.slack.com/apps",
      `Slack needs an app configuration token: scroll to "Your App Configuration Tokens" and Generate Token for your workspace.
You'll be asked for it, then to install the app and give its bot token; both hidden.`,
    );
    await pause("Press Enter once it's generated…");
    if ((await runLive("node", ["scripts/slack-app.ts", "create", workerUrl])) !== 0) fail("Creating the Slack app failed.");
  });

  await step("Admin", async () => {
    // Only an admin can add a project from the Home tab; without any, no one can.
    const file = `${HOME}cade.config.json`;
    let config: { admins?: string[] } = {};
    try {
      config = JSON.parse(await readFile(file, "utf8"));
    } catch {}
    const real = (config.admins ?? []).filter((id) => id !== "U0000000001");
    if (real.length) {
      console.log(`Admins are set already (${real.join(", ")}).`);
      return "skipped, already set";
    }
    console.log("An admin can add projects from Cade's Home tab. In Slack, click your name or picture, then ⋯ → Copy member ID (it starts with U).");
    const ids = (await ask("Slack member ID of the first admin (more later in cade.config.json): ")).split(/[\s,]+/).filter(Boolean);
    if (!ids.length || !ids.every((id) => /^[UW][A-Z0-9]{6,}$/.test(id))) fail("That isn't a Slack member ID, such as U0123ABCD.");
    await writeFile(file, `${JSON.stringify({ ...config, admins: ids }, null, 2)}\n`);
    if ((await runLive("node", ["scripts/config.ts"])) !== 0) fail("Uploading cade.config.json failed. npm run config retries it.");
    return `admin ${ids.join(", ")}`;
  });

  await step("GitHub (optional)", async () => {
    // Pull requests' states, for the task cards (see src/github.ts); without a token, all count as open.
    const hasToken = async () => /"GITHUB_TOKEN"/.test((await run("npx", ["wrangler", "secret", "list"])).output);
    if (await hasToken()) {
      console.log("A GitHub token is set already. npm run github replaces it.");
      return "skipped, already set";
    }
    if ((await runLive("node", ["scripts/github.ts"])) !== 0) fail("Storing the GitHub token failed. npm run github retries it.");
    return (await hasToken()) ? "token stored" : "skipped, pull requests count as open";
  });

  note(outcomes.join("\n"), "Summary");
  note(
    [
      "1. In Slack, create a channel for your first project (a team channel where tasks and incidents are tracked).",
      "2. Invite Cade to it: /invite @Cade",
      "3. Open Cade's Home tab (Apps → Cade → Home).",
      "4. Click Add project and pick the channel.",
      "5. Try /cade help in the channel.",
    ].join("\n"),
    "Try it in Slack",
  );
  outro("Setup finished.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
