#!/usr/bin/env node
// Uploads cade.config.json, the settings you edit, as Worker secrets, after
// checking it the way Cade reads it. Edit the file, then run `npm run config`;
// changes take effect without a deploy. See GETTING_STARTED.md.
//
//   projects  each project: its Slack channel, Doc and        → PROJECTS
//             settings (below)
//   timezone  for times on the web pages and summaries        → TIMEZONE
//             (optional)
//   googleUrl the Google web app's address (optional), for     → GOOGLE_URL
//             every project's Doc
//   admins    the Slack user IDs of the people who can run        → ADMINS
//             project settings from Slack
//             (a Slack form); none without it
//   aiModel   the Workers AI text model AI suggestions use (optional): a   → AI_MODEL_NAME
//             name such as "@cf/google/gemma-4-26b-a4b-it"; the default
//             model without it. One model for every project
//   mcp       whether people can connect their AI agent to      → MCP
//             Cade's MCP endpoint (optional, on): false turns
//             it off, and the Home tab gives no keys
//
// Everything else is set on each project, not at the top of the file:
//   name, channel (an ID) required
//   workDoc       the project's Google Doc, for executive summaries (an
//                 address; without it create_executive_summary can't be used)
//   taskChangeDetection
//                 the proactive agent: Cade reading messages in the threads
//                 it manages and offering changes (optional, on): true, or
//                 false for commands only
//   newTaskDetection
//                 whether Cade asks about a message posted on its own in the
//                 channel: track it as a task, report it as an incident or
//                 move it to a task (optional, on); false to leave such
//                 messages alone
//   aiAgentSummary
//                 whether, after a task is made from a message, Cade offers
//                 a prompt for the person's AI agent to summarize the
//                 message's thread into it, through Cade's MCP endpoint
//                 (optional, on); false to skip it (see mcp.js)
//   activeTasksPinning
//                 whether open tasks are pinned in the channel (optional, off)
//   summaryCanvas whether the channel has a summary canvas of its tasks
//                 (optional, off)
// A project can also be added from the Home tab, which keeps it in the database.
//
// The real secrets (the bot token, the signing secret and GOOGLE_SECRET,
// which the web app's address is useless without) are set once with
// `wrangler secret put` and kept out of files.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projects } from "../src/channels.ts";
import { CONFIG_SCHEMA, PROJECT_SCHEMA } from "../src/config-schema.ts";
import { docId } from "../src/doc.ts";
import { validate } from "../src/validate.ts";
import "./cloudflare.ts";
import { HOME, ROOT } from "./paths.ts";

const FILE = `${HOME}cade.config.json`;

// Returns the Worker secrets `json` sets, or throws saying what's wrong.
export function readConfig(json) {
  let config;
  try {
    config = JSON.parse(json);
  } catch {
    throw new Error("cade.config.json is not valid JSON.");
  }
  const known = ["projects", "timezone", "googleUrl", "mcp", "admins", "aiModel"];
  const unknown = Object.keys(config).find((key) => !known.includes(key));
  if (PROJECT_SETTINGS.includes(unknown)) {
    throw new Error(`cade.config.json has "${unknown}" at the top; set it on each project instead: { "name": "acme", "channel": "C…", "${unknown}": … }.`);
  }
  if (unknown) throw new Error(`cade.config.json has "${unknown}"; it takes ${known.join(" and ")}.`);

  // None is allowed when the projects are kept in the database (the Add project button).
  const list = projects({ PROJECTS: config.projects ?? [] });
  const ids = list.map((project) => project.channel);
  const notId = ids.find((id) => !/^[CG][A-Z0-9]{8,}$/.test(id));
  if (notId) throw new Error(`"${notId}" doesn't look like a Slack channel ID (C… from the channel's About tab).`);
  const reused = ids.find((id, i) => ids.indexOf(id) !== i);
  if (reused) throw new Error(`${reused} is used twice; each channel belongs to one project.`);
  const badWorkDoc = list.find((project) => project.workDoc !== undefined && !docId(project.workDoc));
  if (badWorkDoc) throw new Error(`${badWorkDoc.name}'s workDoc should be a Google Doc's address: https://docs.google.com/document/d/…/edit.`);

  for (const project of list) {
    try {
      if (project.aiModel !== undefined) throw new Error("aiModel is set once at the top of the file, for every project, not on a project.");
      for (const key of SWITCHES) if (project[key] !== undefined) checkSwitch(key, project[key]);
    } catch (error) {
      throw new Error(`${project.name}'s ${error.message}`);
    }
  }

  // Each Worker secret it sets, by name.
  const secrets: Record<string, string> = { PROJECTS: JSON.stringify(list) };
  if (config.timezone !== undefined) secrets.TIMEZONE = checkZone(config.timezone);
  // Always set, so taking someone out of the file takes them out of the Worker.
  const admins = config.admins ?? [];
  if (!Array.isArray(admins) || admins.some((id) => !/^[UW][A-Z0-9]{2,}$/.test(String(id)))) {
    throw new Error("admins is a list of Slack user IDs, such as [\"U0123ABCD\"] (in Slack: click the person, then ⋯ → Copy member ID).");
  }
  secrets.ADMINS = JSON.stringify([...new Set(admins)]);
  // Always set, so taking it out of the file goes back to the default model.
  secrets.AI_MODEL_NAME = config.aiModel === undefined ? "" : checkAiModel(config.aiModel);
  if (config.mcp !== undefined) {
    if (typeof config.mcp !== "boolean") throw new Error("mcp is true or false.");
    // Both are set, so turning it back on replaces an earlier "off".
    secrets.MCP = config.mcp ? "on" : "off";
  }
  if (config.googleUrl !== undefined) {
    if (!/^https:\/\/script\.google\.com\/\S+\/exec$/.test(config.googleUrl)) {
      throw new Error("googleUrl should be the web app URL from Apps Script: https://script.google.com/…/exec.");
    }
    secrets.GOOGLE_URL = config.googleUrl;
  }

  // Then the schema, for the rest of what the file and each project may say, and nothing else: a
  // misspelt setting would otherwise be uploaded and do nothing.
  for (const project of list) {
    const problem = validate(PROJECT_SCHEMA, project);
    if (problem) throw new Error(`In cade.config.json, project ${project.name}: ${problem}`);
  }
  const problem = validate(CONFIG_SCHEMA, config);
  if (problem) throw new Error(`In cade.config.json: ${problem}`);
  return secrets;
}

// Features with `true` or `false`, set on each project: activeTasksPinning and summaryCanvas
// are off unless turned on; taskChangeDetection and
// newTaskDetection and aiAgentSummary are on unless turned off.
const SWITCHES = ["taskChangeDetection", "activeTasksPinning", "summaryCanvas", "newTaskDetection", "aiAgentSummary"];

// What a project can set, which used to be allowed at the top of the file.
const PROJECT_SETTINGS = SWITCHES;

function checkSwitch(key, value) {
  if (typeof value !== "boolean") throw new Error(`${key} is true or false.`);
  return value;
}

// `aiModel` if it's a Workers AI text model's name, else throws.
export function checkAiModel(model) {
  if (typeof model === "string" && /^@(cf|hf)\/\S+$/.test(model)) return model;
  throw new Error(`aiModel is a Workers AI text model's name, such as "@cf/google/gemma-4-26b-a4b-it".`);
}

// Returns `zone` if it's a time zone Intl knows (an IANA name), else throws.
export function checkZone(zone) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    throw new Error(`"${zone}" isn't a time zone; use an IANA name such as Asia/Colombo or Europe/London.`);
  }
}

// Checks cade.config.json and uploads it as Worker secrets. Throws, having
// uploaded nothing, if the file is missing or wrong.
export async function uploadConfig() {
  let json;
  try {
    json = await readFile(FILE, "utf8");
  } catch {
    throw new Error("No cade.config.json: copy cade.config.sample.json to cade.config.json and fill it in.");
  }
  const secrets = readConfig(json);
  for (const project of JSON.parse(secrets.PROJECTS)) {
    const own = ["taskChangeDetection", "newTaskDetection", "activeTasksPinning", "summaryCanvas"].filter((key) => project[key] !== undefined).map((key) => `, ${key} ${JSON.stringify(project[key])}`).join("");
    const workDoc = project.workDoc ? `, workDoc ${project.workDoc}` : "";
    console.log(`${project.name}: channel ${project.channel}${workDoc}${own}`);
  }
  if (secrets.TIMEZONE) console.log(`timezone: ${secrets.TIMEZONE}`);
  if (secrets.MCP) console.log(`mcp: ${secrets.MCP}`);
  console.log(`admins: ${JSON.parse(secrets.ADMINS).join(", ") || "none"}`);
  if (secrets.AI_MODEL_NAME) console.log(`aiModel: ${secrets.AI_MODEL_NAME}`);
  if (secrets.GOOGLE_URL) console.log(`googleUrl: ${secrets.GOOGLE_URL}`);

  // `wrangler secret bulk` reads them from a file; it's removed straight after.
  const dir = await mkdtemp(join(tmpdir(), "cade-config-"));
  try {
    const file = join(dir, "secrets.json");
    await writeFile(file, JSON.stringify(secrets));
    const code = await new Promise((resolve) => {
      spawn("npx", ["wrangler", "secret", "bulk", file], { cwd: ROOT, stdio: "inherit" }).on("exit", resolve);
    });
    if (code !== 0) throw new Error("wrangler secret bulk failed.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  uploadConfig().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
