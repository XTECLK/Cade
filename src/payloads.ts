// What Cade's own buttons, menus and forms carry, as JSON in a button's value, a block's block_id or
// a form's private_metadata, and get back when they are used. Cade writes these, and people can't
// change them in Slack, but a message stays in Slack for good: a button can come back months later,
// from a message posted by an older Cade that wrote them differently. So each is read with
// readPayload, against its schema here. A schema asks only for what the reader uses, and leaves
// anything else alone, so older messages that still work keep working; one that doesn't fit is
// refused with OutdatedPayload, and whoever clicked it is told it's out of date (see index.ts),
// rather than the handler failing halfway through.
import { validate, type Schema } from "./validate.ts";
import type { Changes, Status } from "./types.ts";

// A payload that doesn't fit its schema, or isn't JSON at all.
export class OutdatedPayload extends Error {}

// Parses `text` and checks it against `schema`, or throws OutdatedPayload saying what is wrong. `what`
// names it for the log.
export function readPayload<T>(schema: Schema, text: string | undefined, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    throw new OutdatedPayload(`${what} isn't JSON`);
  }
  const problem = validate(schema, value);
  if (problem) throw new OutdatedPayload(`${what}: ${problem}`);
  return value as T;
}

// ---- Building blocks ----

const text = { type: "string" };
const texts = { type: "array", items: text };
// An object with these properties, of which `required` must be there. Others are let through.
const object = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
});

// A task's root message: its channel and ts.
const TASK_REF = { channel: text, ts: text };
export type TaskRef = { channel: string; ts: string };

// ---- The payloads ----

// Turn off or Turn on, for the person's own suggestions, in the Home tab's Settings (home.ts).
export const SUGGESTIONS_BUTTON = object({ on: { type: "boolean" } });
export type SuggestionsButton = { on: boolean };

// A button about a task: Ask for approval (status.ts), Send PRs for approval (release.ts), the move
// picker's Move (move.ts).
export const TASK_BUTTON = object(TASK_REF);

// A button about a message, for starting a task from it or moving it (move.ts).
export const MESSAGE_BUTTON = object({ ...TASK_REF, title: text }, ["channel", "ts"]);
export type MessageButton = TaskRef & { title?: string };

// A form about a task, with the private message to remove once it's sent (status.ts, release.ts).
export const TASK_FORM = object({ ...TASK_REF, responseUrl: text }, ["channel", "ts"]);
export type TaskForm = TaskRef & { responseUrl?: string };

// Approve and Not approve on a task in Client review (status.ts).
export const TASK_APPROVAL = object({ ...TASK_REF, text: text, approver: { type: ["string", "null"] } }, ["channel", "ts"]);
export type TaskApproval = TaskRef & { text?: string; approver?: string | null };

// Approve and Not approve on a release (release.ts). Buttons from before an approver was picked have
// none, and anyone may click them.
export const RELEASE_APPROVAL = object({ ...TASK_REF, id: { type: "integer" }, approver: { type: ["string", "null"] } }, ["channel", "ts", "id"]);
export type ReleaseApproval = TaskRef & { id: number; approver?: string | null };

// Delete on `/cade remove`'s question (delete.ts).
export const DELETE_BUTTON = object({ ...TASK_REF, kind: { type: "string", enum: ["task", "message", "thread"] } });
export type DeleteButton = TaskRef & { kind: "task" | "message" | "thread" };

// Changes as changes.ts takes them, in a suggestion's buttons (ai-suggest.ts).
const PEOPLE_CHANGE = object({ add: texts, remove: texts }, []);
const CHANGES = object(
  {
    people: object({ owner: PEOPLE_CHANGE, reviewer: PEOPLE_CHANGE, tester: PEOPLE_CHANGE }, []),
    status: text,
    priority: text,
    dueDate: text,
    prs: object({ add: texts, remove: texts }, []),
    subtasks: { type: "boolean" },
    blocked: object({ on: { type: "boolean" }, reason: text }, ["on"]),
  },
  [],
);

// Change and Edit on a suggestion (ai-suggest.ts): the task, the changes, the status it was suggested
// at, and who the message mentioned.
export const SUGGESTION = object({ ...TASK_REF, changes: CHANGES, from: text, told: texts }, ["channel", "ts", "changes"]);
export type Suggestion = TaskRef & { changes: Changes; from?: Status; told?: string[] };

// Link on an older pull request question (pr.ts): the task, the PRs, who the message mentioned, and
// the reviewers it suggested.
export const PR_SUGGESTION = object({ ...TASK_REF, urls: texts, mentioned: texts, reviewers: texts }, ["channel", "ts"]);
export type PrSuggestion = TaskRef & { urls?: string[]; mentioned?: string[]; reviewers?: string[] };

// The reviewer picker's block_id (pr.ts): the PRs it asks about. It may have been cut short to fit,
// and then it isn't read.
export const PR_LIST = texts;

// The Edit form (edit.ts).
export const EDIT_FORM = object({ ...TASK_REF, details: { type: "boolean" }, responseUrl: text, told: texts }, ["channel", "ts"]);
export type EditForm = TaskRef & { details?: boolean; responseUrl?: string; told?: string[] };

// The New task and New incident forms (track.ts): where the task goes, which the form may ask for, its
// title to start with, and the message to move into its thread.
export const TRACK_FORM = object({ channel: text, title: text, move: object({ ...TASK_REF, away: { type: "boolean" } }, ["channel", "ts"]) }, []);
export type TrackForm = { channel?: string; title?: string; move?: TaskRef & { away?: boolean } };

// Move to existing's form (move.ts): the message, the private question to remove, and the project's
// channel and the message's title, when known.
export const MOVE_FORM = object({ from: object(TASK_REF), responseUrl: text, channel: text, title: text }, ["from"]);

// `/cade standup`'s walk (standup.ts), in its Back and Next buttons, and, with the task (c, t), in
// each task's menu.
const WALK_PROPERTIES = {
  m: { type: "string", enum: ["people", "unassigned"] },
  g: text,
  l: text,
  i: { type: "integer", minimum: 0 },
};
export const STANDUP_WALK = object(WALK_PROPERTIES);
export const STANDUP_TASK = object({ ...WALK_PROPERTIES, c: text, t: text });
