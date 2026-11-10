import type { AppEnv } from "./env.ts";
import type { SlackMessage } from "./types.ts";

// Slack rejects requests whose signature timestamp is older than five minutes,
// which stops captured requests from being replayed later.
const SIGNATURE_MAX_AGE_SECONDS = 60 * 5;

const encoder = new TextEncoder();

export async function verifySlackRequest(request: Request, body: string, signingSecret: string) {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature") ?? "";
  const match = /^v0=([0-9a-f]{64})$/.exec(signature);
  if (!timestamp || !match) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const expected = new Uint8Array(
    match[1]!.match(/../g)!.map((byte) => parseInt(byte, 16)),
  );
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    encoder.encode(`v0:${timestamp}:${body}`),
  );
}

// Cade's messages link to other messages, such as "tracked this as a task:
// <link>".
// Slack would preview each link as a copy of the linked message, repeating
// the task card, so previews are turned off for everything Cade posts.
const NO_PREVIEWS = { unfurl_links: false, unfurl_media: false };
const POSTING_METHODS = ["chat.postMessage", "chat.update"];

// A page of a method that pages its answer: the cursor of the next, if any.
type Paged = { response_metadata?: { next_cursor?: string } };

// A Slack user, as users.info and users.list give them: only what Cade reads.
export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  tz?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
    phone?: string;
    title?: string;
    status_text?: string;
    // When the status ends, in seconds since 1970; 0 for never.
    status_expiration?: number;
  };
}

// A channel, as conversations.info and users.conversations give them: only what Cade reads.
export interface SlackChannel {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_member?: boolean;
  properties?: { canvas?: { file_id?: string } };
}

// What Cade reads of each Web API method's answer: only those fields, not all Slack gives. Every
// method Cade calls is listed, so calling a new one means saying here what is read of it; one whose
// answer isn't read answers {}.
export interface SlackAnswers {
  "auth.test": { url: string; user_id: string };
  "canvases.access.set": {};
  "canvases.edit": {};
  "chat.delete": {};
  "chat.getPermalink": { permalink: string };
  "chat.postEphemeral": {};
  "chat.postMessage": { channel: string; ts: string };
  "chat.update": {};
  "conversations.canvases.create": { canvas_id: string };
  "conversations.history": Paged & { messages?: SlackMessage[] };
  "conversations.info": { channel: SlackChannel };
  "conversations.join": {};
  "conversations.members": Paged & { members?: string[] };
  "conversations.replies": Paged & { messages?: SlackMessage[] };
  "reactions.add": {};
  "users.conversations": Paged & { channels?: SlackChannel[] };
  "users.getPresence": { presence?: string };
  "users.info": { user: SlackUser };
  "users.list": Paged & { members?: SlackUser[] };
  "views.open": {};
  "views.publish": {};
  "views.update": {};
}
export type SlackMethod = keyof SlackAnswers;

// Read methods such as conversations.replies do not accept JSON bodies, so
// every call is form-encoded with object arguments sent as JSON strings.
export async function callSlack<M extends SlackMethod>(env: Pick<AppEnv, "SLACK_BOT_TOKEN">, method: M, args: Record<string, unknown>): Promise<SlackAnswers[M]> {
  if (!env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is not configured");
  }

  const form = new URLSearchParams();
  const fields = POSTING_METHODS.includes(method) ? { ...NO_PREVIEWS, ...args } : args;
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    form.set(name, typeof value === "string" ? value : JSON.stringify(value));
  }

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Slack ${method} returned HTTP ${response.status}`);
  }
  const data = await response.json<{ ok: boolean; error?: string }>();
  if (!data.ok) {
    throw new Error(`Slack ${method} failed: ${data.error}`);
  }
  // Slack's answer for the method: SlackAnswers says which of its fields Cade reads.
  return data as unknown as SlackAnswers[M];
}

export function escapeSlack(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Answers a slash command after the fact, through the response_url Slack
// sent with it, which works for 30 minutes. An ephemeral answer is shown only
// to the person who sent the command.
export async function respondLater(responseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", ...body }),
  });
  if (!response.ok) throw new Error(`Slack response_url returned HTTP ${response.status}`);
  // Slack can refuse a message, such as one with invalid blocks, with an OK
  // status and { ok: false } as the reply.
  if (response.headers.get("content-type")?.includes("json")) {
    const result = await response.json<{ ok?: boolean; error?: string }>();
    if (result.ok === false) throw new Error(`Slack response_url refused the message: ${result.error}`);
  }
}

// Removes a private message whose button opened a form, once the form is
// sent, through the click's response_url. That lasts half an hour, so a form
// kept open longer leaves the message behind, which is harmless.
export async function dismiss(responseUrl: string | undefined | null) {
  if (!responseUrl) return;
  await respondLater(responseUrl, { delete_original: true }).catch((error: Error) => {
    console.warn("Could not remove the private message", { error: error.message });
  });
}

// A reply that acknowledges a command with a ✅ on its message rather than a
// message of its own, for commands whose effect is plain to see. `note`, if
// any, is posted as well: what the command did elsewhere.
export function acknowledge(note?: unknown) {
  return { reaction: "white_check_mark", note };
}

// Replies are either plain text or a message body such as { text, blocks }.
export function messageBody<T extends object>(reply: string | T) {
  return typeof reply === "string" ? { text: reply } : reply;
}

export function plainText(text: string) {
  return { type: "plain_text" as const, text };
}

export function mrkdwn(text: string) {
  return { type: "mrkdwn" as const, text };
}

// What Cade posts for someone's AI agent ends with this footer, in small grey text, as Slack's own
// MCP connector marks what it posts for someone ("Sent using Claude"). Its block_id finds it again
// when the message is replaced (see review in commands/status.ts).
export const AGENT_FOOTER_ID = "cade_agent_footer";
export const AGENT_FOOTER = "Sent using AI agent";
export function agentFooter() {
  return { type: "context", block_id: AGENT_FOOTER_ID, elements: [mrkdwn("*Sent using* AI agent")] };
}

// A message of `text` posted for someone's AI agent, with the footer. The footer is in its text
// too, for notifications and the thread's history, which keep only the text.
export function viaAgent(text: string) {
  return { text: `${text}\n${AGENT_FOOTER}`, blocks: [{ type: "section", text: mrkdwn(text) }, agentFooter()] };
}

export function mentions(users: string[]) {
  return users.map((id) => `<@${id}>`).join(", ");
}

// A message's link, from Copy link: …/archives/<channel>/p<ts without its
// dot>, with ?thread_ts=… when the message is a reply.
const MESSAGE_LINK = /https?:\/\/[^/\s<>|]+\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(\?[^\s<>|]*)?/;

// The channel and thread root of the first Slack message link in `text`, or
// null if there is none. A link to a reply stands for its thread.
export function linkedThread(text: string) {
  const link = linkedMessage(text);
  return link && { channel: link.channel, ts: link.threadTs ?? link.ts };
}

// The first Slack message link in `text` as { channel, ts, threadTs }, or
// null if there is none. `threadTs` is set only for a link to a reply.
export function linkedMessage(text: string) {
  const match = MESSAGE_LINK.exec(text.replace(/&amp;/g, "&"));
  if (!match) return null;
  const ts = `${match[2]}.${match[3]}`;
  const threadTs = new URLSearchParams(match[4] ?? "").get("thread_ts");
  return { channel: match[1]!, ts, threadTs: threadTs && threadTs !== ts ? threadTs : null };
}

// A form's answer that closes it and any forms under it, such as the task
// card menu's More panel (see menu.ts) that opened it.
export const CLOSE_ALL = { response_action: "clear" };
