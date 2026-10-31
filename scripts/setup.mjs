#!/usr/bin/env node
// Takes you through GETTING_STARTED.md in one command: Cloudflare login, the
// Worker, the Slack app, optionally Google Sheets and Docs, then your first
// group. It runs the same npm scripts the guide names, so each can also be
// run alone, and it skips what's already done: run it again to carry on.
//
//   npm run setup
//
// Tokens and secrets are asked for by those scripts, hidden, never here.
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SLACK_APP = `${ROOT}.cade/slack-app.json`;
const GOOGLE_APP = `${ROOT}.cade/google-app.json`;
const WRANGLER_TOML = `${ROOT}wrangler.toml`;

// The Worker's URL in what `wrangler deploy` printed.
export function workerUrlIn(output) {
  return /https:\/\/[\w.-]+\.workers\.dev/.exec(output)?.[0];
}

// wrangler.toml with the Worker named `name`.
export function withWorkerName(toml, name) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("A Worker name is lowercase letters, digits and -, such as cade.");
  return toml.replace(/^name = ".*"$/m, `name = "${name}"`);
}

// The account IDs in what `wrangler whoami` printed.
export function accountIdsIn(output) {
  return [...new Set(output.match(/\b[0-9a-f]{32}\b/g) ?? [])];
}

async function exists(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}

// Runs a command in this folder, showing its output (and taking input), and
// returns { code, output }.
function run(command, args, { env = process.env } = {}) {
  return new Promise((resolve) => {
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
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function step(title, work) {
  console.log(`\n=== ${title} ===`);
  await work();
}

async function main() {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question, fallback = "") => (await prompt.question(question)).trim() || fallback;
  const yes = async (question, fallback = true) => {
    const answer = (await ask(`${question} (${fallback ? "Y/n" : "y/N"}): `)).toLowerCase();
    return answer ? answer.startsWith("y") : fallback;
  };
  const fail = (message) => {
    prompt.close();
    console.error(`\n${message}\nRun npm run setup again to carry on from here.`);
    process.exit(1);
  };

  console.log("Cade setup. Each step is skipped if it's done already, so you can stop and run this again.");

  await step("Cloudflare", async () => {
    let who = await run("npx", ["wrangler", "whoami"]);
    if (who.code !== 0 || /not authenticated/i.test(who.output)) {
      console.log("Logging in to Cloudflare; approve access in the browser…");
      if ((await runLive("npx", ["wrangler", "login"])) !== 0) fail("Cloudflare login failed.");
      who = await run("npx", ["wrangler", "whoami"]);
    }
    const accounts = accountIdsIn(who.output);
    if (accounts.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID && !(await exists(`${ROOT}.cade/cloudflare.json`))) {
      const id = await ask("\nSeveral accounts are listed. The account ID Cade is deployed to: ");
      if (!accounts.includes(id)) fail("That isn't one of the listed account IDs.");
      process.env.CLOUDFLARE_ACCOUNT_ID = id;
      await import("./cloudflare.mjs"); // saves it for every script
    }
  });

  let workerUrl;
  await step("Worker", async () => {
    const toml = await readFile(WRANGLER_TOML, "utf8");
    const current = /^name = "(.*)"$/m.exec(toml)?.[1] ?? "cade";
    if (!(await exists(SLACK_APP))) {
      const name = await ask(`Worker name, unique in your Cloudflare account [${current}]: `, current);
      await writeFile(WRANGLER_TOML, withWorkerName(toml, name));
    }
    console.log("Deploying; Wrangler may ask to confirm creating the database tables.");
    const deployed = await run("npm", ["run", "deploy"]);
    if (deployed.code !== 0) fail("The deploy failed. If only the tables step failed, npm run db:migrate retries it.");
    workerUrl = workerUrlIn(deployed.output);
    if (!workerUrl) workerUrl = await ask("Couldn't find the Worker URL. Paste it (https://….workers.dev): ");
  });

  await step("Slack app", async () => {
    if (await exists(SLACK_APP)) {
      console.log("The Slack app is already created (.cade/slack-app.json).");
      return;
    }
    console.log(`Slack needs an app configuration token: open https://api.slack.com/apps, scroll to
"Your App Configuration Tokens", and Generate Token for your workspace.
You'll be asked for it, then to install the app and give its bot token; both hidden.\n`);
    await ask("Press Enter when you're ready… ");
    if ((await runLive("node", ["scripts/slack-app.mjs", "create", workerUrl])) !== 0) fail("Creating the Slack app failed.");
  });

  await step("Google Sheets and Docs (optional)", async () => {
    if (await exists(GOOGLE_APP)) {
      console.log("The Google web app is already created (.cade/google-app.json).");
      return;
    }
    if (!(await yes("Keep each group's tasks in a Google Sheet, and executive summaries in a Google Doc?", false))) {
      console.log("Skipped. Add them later with npm run google:create.");
      return;
    }
    console.log(`\nA person has to do two things in a browser: log in to Google when clasp asks,
and turn on the Apps Script API at https://script.google.com/home/usersettings.`);
    await ask("Press Enter when the API is on… ");
    if ((await runLive("npx", ["clasp", "login"])) !== 0) fail("The Google login failed.");
    if ((await runLive("node", ["scripts/google-app.mjs", "create"])) !== 0) fail("Creating the Google web app failed.");
    await ask("\nOpen the script link above, choose authorize, click Run and allow it. Press Enter when done… ");
  });

  await step("First group", async () => {
    if (!(await yes("Set up a group (its Slack channel, and its Sheet and Doc) now?"))) {
      console.log("Later, with npm run group.");
      return;
    }
    prompt.close();
    if ((await runLive("node", ["scripts/group.mjs"])) !== 0) process.exit(1);
  });

  prompt.close();
  console.log("\nSetup finished. In Slack, invite Cade to the channel with /invite @Cade, then try /cade help.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
