// cade.config.json as a JSON Schema: every setting it takes, and what each must be. `npm run config`
// (scripts/config.ts) checks the file against it before uploading anything, after its own checks for
// the common mistakes, which say more; this catches the rest, such as a misspelt setting, which would
// otherwise be uploaded and do nothing. Settings are described in scripts/config.ts and
// GETTING_STARTED.md.
import type { Schema } from "./validate.ts";

const SWITCH = { type: "boolean" };

// One project in `projects`. A project can also be added from the Home tab, which keeps it in the
// database instead.
export const PROJECT_SCHEMA: Schema = {
  type: "object",
  required: ["name", "channel"],
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    channel: { type: "string", pattern: "^[CG][A-Z0-9]{8,}$", description: "a Slack channel ID, such as C0123ABCD" },
    workDoc: { type: "string" },
    taskChangeDetection: SWITCH,
    newTaskDetection: SWITCH,
    aiAgentSummary: SWITCH,
    activeTasksPinning: SWITCH,
    summaryCanvas: SWITCH,
  },
};

// The whole file. Each project is checked with PROJECT_SCHEMA on its own, so a problem is named by
// its project.
export const CONFIG_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    projects: { type: "array", items: { type: "object" } },
    timezone: { type: "string" },
    googleUrl: { type: "string" },
    mcp: { type: "boolean" },
    admins: { type: "array", items: { type: "string", pattern: "^[UW][A-Z0-9]{2,}$", description: "a Slack user ID, such as U0123ABCD" } },
    aiModel: { type: "string" },
  },
};
