#!/usr/bin/env node
// Takes you through GETTING_STARTED.md in one command: Cloudflare login, the
// Worker, the Slack app, optionally a Google Doc for executive summaries, then your first
// group. It runs the same npm scripts the guide names, so each can also be
// run alone, and it skips what's already done: run it again to carry on.
//
//   npm run setup
//
// Tokens and secrets are asked for by those scripts, hidden, never here.
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ask, askHidden, choose, confirm, intro, log, note, outro, pause } from "./prompt.mjs";

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

// A Gmail name for a Google account made just for Cade: cade., the Slack
// workspace's name (lowercase letters and digits only, cut so the whole name
// fits Gmail's 30 characters), ., and six random letters a-z, such as
// cade.acme.qwhzme@gmail.com. Without a workspace, cade.qwhzme@gmail.com.
export function cadeGmail(workspace, random = randomInt) {
  const letters = Array.from({ length: 6 }, () => String.fromCharCode(97 + random(26))).join("");
  const name = String(workspace ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 30 - "cade..".length - letters.length);
  return `cade.${name ? `${name}.` : ""}${letters}@gmail.com`;
}

// Google's sign-up page, with the Gmail name filled in when Google honours it
// (if the field comes up empty, type the name).
export function googleSignupUrl(gmail) {
  const query = new URLSearchParams({ flowName: "GlifWebSignIn", flowEntry: "SignUp", Email: gmail.replace(/@gmail\.com$/, "") });
  return `https://accounts.google.com/signup/v2/createaccount?${query}`;
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
    const done = resolve;
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("exit", (code) => done(code ?? 1));
  });
}

// The Slack workspace's name, for the Gmail name and the script's title: saved
// by slack:create when it was given the bot token, else read with the token
// (asked for here, hidden) and saved to .cade/slack-app.json. None if skipped.
async function workspaceName() {
  let app = {};
  try {
    app = JSON.parse(await readFile(SLACK_APP, "utf8"));
  } catch {}
  if (app.team || !process.stdin.isTTY) return app.team;
  const page = app.appId ? `https://api.slack.com/apps/${app.appId}/oauth` : "https://api.slack.com/apps (open Cade → OAuth & Permissions)";
  console.log(`\nTo put your Slack workspace's name in Cade's Gmail name and script, paste Cade's bot token: the Bot User OAuth Token (xoxb-…) at\n  ${page}`);
  const token = process.env.SLACK_BOT_TOKEN || (await askHidden("Slack bot token (hidden), or Enter to skip: "));
  if (!token) return undefined;
  process.env.SLACK_BOT_TOKEN ??= token; // the group step won't ask for it again
  try {
    const result = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    if (!result.ok) throw new Error(result.error);
    await writeFile(SLACK_APP, `${JSON.stringify({ ...app, team: result.team }, null, 2)}\n`);
    return result.team;
  } catch (error) {
    console.log(`Couldn't read the workspace's name (${error.message}); carrying on without it.`);
    return undefined;
  }
}

// Opens a page in the person's browser (best effort; the address is always printed too).
function openUrl(url) {
  const [command, ...args] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  try {
    spawn(command, [...args, url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {}
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
  const yes = (question, fallback = true) => confirm(question, fallback);
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
    const accounts = accountIdsIn(who.output);
    if (accounts.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID && !(await exists(`${ROOT}.cade/cloudflare.json`))) {
      const id = await choose("Several Cloudflare accounts are listed. Which one is Cade deployed to?", accounts.map((account) => ({ label: account, value: account })));
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
      return "skipped, already created";
    }
    await openPage(
      "https://api.slack.com/apps",
      `Slack needs an app configuration token: scroll to "Your App Configuration Tokens" and Generate Token for your workspace.
You'll be asked for it, then to install the app and give its bot token; both hidden.`,
    );
    await pause("Press Enter once it's generated…");
    if ((await runLive("node", ["scripts/slack-app.mjs", "create", workerUrl])) !== 0) fail("Creating the Slack app failed.");
  });

  await step("Google Doc for executive summaries", async () => {
    if (await exists(GOOGLE_APP)) {
      console.log("The Google web app is already created (.cade/google-app.json).");
      return "skipped, already created";
    }
    console.log(`
Every project keeps its executive summaries in a Google Doc, which Cade makes for it when it's added.
Cade's script and Docs are best owned by a Google account of their
own, so Cade can only reach what it makes, not your personal Drive.`);
    if (await yes("Create a separate Google account for Cade? (No: use an existing account.)")) {
      // slack:create saves the workspace's name when it was given the bot token; without it, none.
      const team = await workspaceName();
      const gmail = cadeGmail(team);
      console.log(`\nCreate it here, with the username ${gmail.replace("@gmail.com", "")} (${gmail}):\n  ${googleSignupUrl(gmail)}`);
      await pause("Press Enter when the account exists… ");
      console.log("Sign in as that account when the browser opens for the login, and in the next step.");
    } else {
      console.log("Sign in as the account to use when the browser opens for the login.");
    }
    await openPage(
      "https://script.google.com/home/usersettings",
      `\nAs that account, turn on the Apps Script API (clasp then asks you to log in to Google).`,
    );
    await pause("Press Enter when the API is on… ");
    if ((await runLive("npx", ["clasp", "login"])) !== 0) fail("The Google login failed.");
    if ((await runLive("node", ["scripts/google-app.mjs", "create"])) !== 0) fail("Creating the Google web app failed.");
    await pause("Open the script link above, choose authorize, click Run and allow it. Press Enter when done… ");
  });

  await step("First group", async () => {
    if (!(await yes("Set up a group (its Slack channel, and its Doc) now?"))) {
      console.log("Later, with npm run group.");
      return "skipped, later with npm run group";
    }
    // runLive pauses our prompt while group.mjs uses the terminal, then resumes it.
    if ((await runLive("node", ["scripts/group.mjs"])) !== 0) process.exit(1);
  });

  note(outcomes.join("\n"), "Summary");
  outro("Setup finished. In Slack, invite Cade to the channel with /invite @Cade, then try /cade help.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
