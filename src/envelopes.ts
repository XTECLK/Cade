// What Slack sends to the Worker, checked at the door (see index.ts) once its signature is: only the
// fields Cade's routing reads, so anything else Slack adds or leaves out never matters. A request
// that fails is answered 400 and logged, rather than failing halfway through a handler; one from
// Slack never should.
import { readPayload } from "./payloads.ts";
import { validate, type Schema } from "./validate.ts";
import type { SlackEvent, SlackPayload } from "./types.ts";

// Something Slack sent that Cade can't read.
export class BadEnvelope extends Error {}

const text = { type: "string" };
// An object with these properties required, others let through.
const object = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
});

// The Events API: url_verification, or event_callback with its event.
const EVENT_ENVELOPE = object({ type: text, challenge: text, event: object({ type: text }), authorizations: { type: "array" } }, ["type"]);
const EVENT_CALLBACK = object({ event: object({ type: text }) });

export interface EventEnvelope {
  type: string;
  challenge?: string;
  event?: SlackEvent;
  authorizations?: { user_id?: string }[];
}

export function readEvent(body: string): EventEnvelope {
  const envelope = parse<EventEnvelope>(EVENT_ENVELOPE, body, "event");
  if (envelope.type === "event_callback") check(EVENT_CALLBACK, envelope, "event_callback");
  return envelope;
}

// Interactions: their kind, and for the kinds Cade routes, who did it and what it routes them by.
const INTERACTION = object({ type: text });
const USER = object({ id: text });
const BY_TYPE: Record<string, Schema> = {
  view_submission: object({ user: USER, view: object({ callback_id: text }) }),
  block_actions: object({ user: USER, actions: { type: "array", minItems: 1, items: object({ action_id: text }) } }),
  message_action: object({ user: USER, callback_id: text }),
};

export function readInteraction(body: string): SlackPayload {
  const payload = parse<SlackPayload>(INTERACTION, new URLSearchParams(body).get("payload") ?? "", "interaction");
  const schema = BY_TYPE[payload.type];
  if (schema) check(schema, payload, payload.type);
  return payload;
}

// A slash command's form fields: who sent it, and where.
const SLASH_COMMAND = object({ user_id: text, channel_id: text });

export function checkSlashCommand(form: URLSearchParams) {
  check(SLASH_COMMAND, Object.fromEntries(form), "slash command");
}

function parse<T>(schema: Schema, json: string, what: string): T {
  try {
    return readPayload<T>(schema, json, what);
  } catch (error) {
    throw new BadEnvelope(error.message);
  }
}

function check(schema: Schema, value: unknown, what: string) {
  const problem = validate(schema, value);
  if (problem) throw new BadEnvelope(`${what}: ${problem}`);
}


