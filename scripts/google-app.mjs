#!/usr/bin/env node
// Creates the Google web app Cade keeps each group's executive summaries in a
// Google Doc with (google/Code.gs and Doc.gs), or updates its script,
// using clasp (Google's Apps Script command line). See GETTING_STARTED.md.
//
//   npm run google:create [-- --title "Cade_Acme"]
//   npm run google:update
//
// Both need `npx clasp login`, and the Apps Script API turned on for your
// Google account (https://script.google.com/home/usersettings).
//
// Creating makes a standalone script, in no doc, generates
// the shared secret into google/Secret.gs (not committed), deploys the web
// app, then gives the Worker its address (googleUrl in cade.config.json,
// uploaded with npm run config) and the secret (GOOGLE_SECRET). The script's
// IDs are saved to .cade/google-app.json, so updates redeploy to the same
// address. Each group's doc is made with npm run group.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callWebApp, secretIn } from "./google-call.mjs";
import { HOME, ROOT } from "./paths.mjs";
import { askHidden } from "./prompt.mjs";
import "./cloudflare.mjs";

const DIR = `${ROOT}google`;
// Kept in HOME for `npm run group` to call the web app with. It is pushed with
// the script only to make a new web app, or to move an old one's secret into
// its script properties (see update).
const SECRET_FILE = `${HOME}google/Secret.gs`;
const SCRIPT_SECRET_FILE = `${DIR}/Secret.gs`;
const MANIFEST_FILE = `${DIR}/appsscript.json`;
const APP_FILE = `${HOME}.cade/google-app.json`;
const CONFIG_FILE = `${HOME}cade.config.json`;
const SLACK_APP_FILE = `${HOME}.cade/slack-app.json`;

// The script's title: Cade_ and the Slack workspace's name, with anything
// Apps Script wouldn't want in a name turned to -. Without a workspace,
// plain "Cade".
export function scriptTitle(workspace) {
  const clean = String(workspace ?? "").replace(/[^\p{L}\p{N} _.-]+/gu, "-").trim();
  return clean ? `Cade_${clean}` : "Cade";
}

// The Slack workspace's name: saved by slack:create, else read with the bot
// token (SLACK_BOT_TOKEN, or asked for, hidden), else none.
async function workspaceName() {
  let page = "https://api.slack.com/apps (open Cade → OAuth & Permissions)";
  try {
    const { team, appId } = JSON.parse(await readFile(SLACK_APP_FILE, "utf8"));
    if (team) return team;
    if (appId) page = `https://api.slack.com/apps/${appId}/oauth`;
  } catch {}
  let token = process.env.SLACK_BOT_TOKEN;
  if (!token && process.stdin.isTTY) {
    console.log(`\nTo name the script after your Slack workspace, paste Cade's bot token: the Bot User OAuth Token (xoxb-…) at\n  ${page}`);
    token = await askHidden("Slack bot token (hidden), or Enter to name it just Cade: ");
  }
  if (!token) return undefined;
  const result = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  return result.ok ? result.team : undefined;
}

// Secret.gs, defining the SECRET Code.gs checks requests against.
export function secretFile(secret) {
  if (!/^[0-9a-f]{32,}$/.test(secret)) throw new Error("The secret should be long and hex.");
  return `// Made by npm run google:create. Not committed: it must match the Worker's GOOGLE_SECRET.\nconst SECRET = "${secret}";\n`;
}

// The web app's address, from the deployment clasp made.
export function webAppUrl(deploymentId) {
  return `https://script.google.com/macros/s/${deploymentId}/exec`;
}

// The deployment ID in what `clasp create-deployment` printed. A project's
// HEAD deployment, which serves the latest code without a version, isn't the
// one wanted.
export function deploymentIdIn(output) {
  const ids = [...output.matchAll(/\b(AKfy[\w-]{20,})\b(?!\s*@HEAD)/g)].map(([, id]) => id);
  return ids.at(-1);
}

// cade.config.json with `googleUrl` set, keeping everything else in it.
export function withGoogleUrl(configJson, url) {
  const config = JSON.parse(configJson);
  return `${JSON.stringify({ ...config, googleUrl: url }, null, 2)}\n`;
}

// Runs a command in `cwd`, showing its output, and returns that output.
function run(command, args, { cwd = ROOT, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output += chunk;
        (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
      });
    }
    if (input !== undefined) child.stdin.end(input);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve(output);
      const hint = /Apps Script API/i.test(output)
        ? "\nTurn on the Apps Script API at https://script.google.com/home/usersettings, then try again."
        : /login|credential|unauthenticated/i.test(output)
          ? "\nLog in first: npx clasp login"
          : "";
      reject(new Error(`${command} ${args.join(" ")} failed.${hint}`));
    });
  });
}

const clasp = (...args) => run("npx", ["clasp", ...args], { cwd: DIR });

async function exists(file) {
  return access(file).then(
    () => true,
    () => false,
  );
}

// clasp may replace appsscript.json with Google's default; this keeps ours,
// which makes the script a web app anyone can reach, running as you.
async function pushScript(manifest, { withSecret }) {
  await writeFile(MANIFEST_FILE, manifest);
  const same = SECRET_FILE === SCRIPT_SECRET_FILE; // working in Cade's own folder
  if (withSecret) {
    if (!same) await copyFile(SECRET_FILE, SCRIPT_SECRET_FILE);
    return clasp("push", "--force");
  }
  // clasp removes from the script what it isn't given, so leaving the file out takes it off.
  const aside = `${SCRIPT_SECRET_FILE}.off`;
  if (await exists(SCRIPT_SECRET_FILE)) await rename(SCRIPT_SECRET_FILE, aside);
  try {
    await clasp("push", "--force");
  } finally {
    if (same && (await exists(aside))) await rename(aside, SCRIPT_SECRET_FILE);
    else await rm(aside, { force: true });
  }
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

export async function create(args) {
  if (await exists(APP_FILE)) {
    throw new Error("The Google web app is already set up (.cade/google-app.json). Use npm run google:update to change its script.");
  }
  const title = option(args, "title") ?? scriptTitle(await workspaceName());
  const manifest = await readFile(MANIFEST_FILE, "utf8");

  console.log(`Creating the script "${title}"…`);
  await clasp("create-script", "--type", "standalone", "--title", title, "--rootDir", ".");
  const project = JSON.parse(await readFile(`${DIR}/.clasp.json`, "utf8"));

  const secret = randomBytes(32).toString("hex");
  await mkdir(dirname(SECRET_FILE), { recursive: true });
  await writeFile(SECRET_FILE, secretFile(secret));
  // A new script has no authorization yet, so it can't store the secret itself:
  // it comes as Secret.gs, and the script moves it into its properties on its first request.
  await pushScript(manifest, { withSecret: true });

  console.log("Deploying the web app…");
  const deployment = await clasp("create-deployment", "--description", "Cade");
  const deploymentId = deploymentIdIn(deployment);
  if (!deploymentId) throw new Error("Couldn't find the deployment ID in clasp's output; see npx clasp list-deployments.");
  const url = webAppUrl(deploymentId);
  const app = { scriptId: project.scriptId, deploymentId, url };
  await mkdir(`${HOME}.cade`, { recursive: true });
  await writeFile(APP_FILE, `${JSON.stringify(app, null, 2)}\n`);

  console.log("Giving the Worker the secret and the address…");
  await run("npx", ["wrangler", "secret", "put", "GOOGLE_SECRET"], { input: secret });
  if (await exists(CONFIG_FILE)) {
    await writeFile(CONFIG_FILE, withGoogleUrl(await readFile(CONFIG_FILE, "utf8"), url));
    await run("node", ["scripts/config.mjs"]);
  } else {
    await copyFile(`${ROOT}cade.config.sample.json`, CONFIG_FILE);
    await writeFile(CONFIG_FILE, withGoogleUrl(await readFile(CONFIG_FILE, "utf8"), url));
    console.log("Made cade.config.json with googleUrl; fill in your projects, then run npm run config.");
  }

  console.log(`
Done. One step is left, which only you can do: approve the script's access
to your Google Docs (documents, drive). Open the script, choose the "authorize"
function, click Run, and allow it:
  https://script.google.com/d/${app.scriptId}/edit
Open it signed in as the Google account that made the script (the one you logged in to clasp
with). If Google says "Sorry, unable to open the file at this time", you're signed in as another
account: open the link in an incognito (private) window and sign in as that account there.

Then have each group's doc made with npm run group:
  npm run group -- --name <group> --workDoc new
`);
}

// Redeploys the script without Secret.gs: the secret lives in the script's
// properties, so an update never touches it. A script that still has its secret
// in Secret.gs is moved over first, by one push that keeps the file, and a request
// that makes the new Code.gs store it. `--skip-check` leaves out that check
// when the secret isn't to hand (google/Secret.gs is gone) but the script is
// known to hold it.
export async function update(args = []) {
  let app;
  try {
    app = JSON.parse(await readFile(APP_FILE, "utf8"));
  } catch {
    throw new Error("No .cade/google-app.json here: create the web app with npm run google:create first.");
  }
  const manifest = await readFile(MANIFEST_FILE, "utf8");
  // clasp's own project file is only the script's ID, which .cade/google-app.json
  // has, so it's made again here when this copy of the folder lacks it.
  const claspFile = `${DIR}/.clasp.json`;
  if (!(await exists(claspFile))) await writeFile(claspFile, `${JSON.stringify({ scriptId: app.scriptId, rootDir: "" }, null, 2)}\n`);
  const deploy = () => clasp("update-deployment", app.deploymentId, "--description", "Cade"); // same deployment, so the address doesn't change

  if (!args.includes("--skip-check")) {
    const secret = secretIn(await readFile(SECRET_FILE, "utf8").catch(() => ""));
    if (!secret) {
      throw new Error(
        "google/Secret.gs is missing, so I can't check the script has its secret stored.\n" +
          "Put it back, or if the script's SECRET property is set (Apps Script → Project Settings → Script Properties), run with --skip-check.",
      );
    }
    const stored = async () => (await callWebApp(app.url, secret, "secret.status").catch(() => ({}))).stored === true;
    if (!(await stored())) {
      console.log("Moving the script's secret into its properties first…");
      await pushScript(manifest, { withSecret: true });
      await deploy();
      if (!(await stored())) {
        throw new Error("The script didn't store its secret. Has it been approved (open it, choose authorize, Run)? Then try again.");
      }
    }
  }
  await pushScript(manifest, { withSecret: false });
  await deploy();
  console.log(`Updated the script at ${app.url}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [action, ...args] = process.argv.slice(2);
  const actions = { create, update };
  if (!actions[action]) {
    console.error('Use: node scripts/google-app.mjs create [--title "Cade"] | update [--skip-check]');
    process.exit(1);
  }
  actions[action](args).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
