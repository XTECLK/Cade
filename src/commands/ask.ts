import { CLOSE_ALL, callSlack, dismiss, escapeSlack, mrkdwn, plainText, respondLater, sentBy } from "../slack.ts";
import type { AppEnv } from "../env.ts";
import type { Context, Handler, RichText, SlackPayload } from "../types.ts";
import { ASK_BUTTON, ASK_FORM, readPayload, type AskButton, type AskForm, type TaskRef } from "../payloads.ts";

const SEND_ACTION = "ask:send";
const EDIT_ACTION = "ask:edit";
const SKIP_ACTION = "ask:skip";
const EDIT_VIEW = "ask:edit";
const MESSAGE_BLOCK = "message";
// A section's text can be no longer.
const MAX_MESSAGE = 3000;

// What a change asks of people, "@rex, could you pick this up?" (see changeRequests in notify.ts), isn't
// posted on its own: the thread hears the change log, and whoever made the change is shown the asks as a
// draft, privately, with Send, Edit and Not now. Often the person knows better: they have started
// testing already, or want to say more than Cade would. Send posts it in the task's thread, led by who
// it's from, as an AI agent's message is (see sentBy); Edit opens it in a form to change first; Not now, or leaving it, sends nothing.
//
// A change made through someone's AI agent isn't offered here: the agent is given the draft and asks
// them (see updateTask in mcp.ts).

// Shows `user` the draft of `lines` about the task at `task`, privately. In the task's thread, unless
// `at` says where they are instead, such as the channel of `/cade standup`: then it links the task, by
// `at.link`, its root message's.
export async function offerAsk(env: AppEnv, task: TaskRef, user: string, lines: string[], at?: { channel: string; threadTs?: string; link?: string }) {
  if (!lines.length) return;
  const text = lines.join("\n");
  const link = at && at.threadTs !== task.ts ? at.link : "";
  const lead = `Send this in ${link ? `<${link}|the task's thread>` : "the task's thread"}? Only you can see this.`;
  const value = JSON.stringify({ ...task, text });
  await callSlack(env, "chat.postEphemeral", {
    channel: at?.channel ?? task.channel,
    thread_ts: at ? at.threadTs : task.ts,
    user,
    text: `${lead}\n${text}`,
    blocks: [
      { type: "section", text: mrkdwn(lead) },
      { type: "section", text: mrkdwn(quoted(text)) },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: SEND_ACTION, style: "primary", text: plainText("Send"), value },
          { type: "button", action_id: EDIT_ACTION, text: plainText("Edit"), value },
          { type: "button", action_id: SKIP_ACTION, text: plainText("Not now"), value },
        ],
      },
    ],
  });
}

function quoted(text: string) {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

// Posts `text` in the task's thread for `user`: Cade posts it, so it says whose it is.
export async function sendAsk(env: AppEnv, { channel, ts }: TaskRef, user: string, text: string) {
  await callSlack(env, "chat.postMessage", { channel, thread_ts: ts, text: sentBy(user, text) });
}

// The form for changing a draft before it's sent, in a rich text box, so people show as people and more
// can be mentioned.
function editForm({ channel, ts, text }: AskButton, responseUrl: string) {
  return {
    type: "modal",
    callback_id: EDIT_VIEW,
    private_metadata: JSON.stringify({ channel, ts, responseUrl }),
    title: plainText("Edit message"),
    submit: plainText("Send"),
    close: plainText("Cancel"),
    blocks: [
      {
        type: "input",
        block_id: MESSAGE_BLOCK,
        label: plainText("Posted in the task's thread"),
        element: { type: "rich_text_input", action_id: "value", initial_value: toRichText(text) },
      },
    ],
  };
}

// The draft, in mrkdwn with <@ID> mentions, as a rich text box's value.
export function toRichText(text: string): RichText {
  const elements: RichText[] = [];
  let last = 0;
  for (const match of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (match.index > last) elements.push({ type: "text", text: unescape(text.slice(last, match.index)) });
    elements.push({ type: "user", user_id: match[1]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) elements.push({ type: "text", text: unescape(text.slice(last)) });
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements }] };
}

function unescape(text: string) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// A rich text box's value as the mrkdwn it is posted as. @channel, @here and @everyone are kept as
// words, not sent as mentions, as for an AI agent's messages.
export function fromRichText(value: RichText | undefined): string {
  const blocks = (value?.elements ?? []).map((block) => {
    const inline = (section: RichText) => (section.elements ?? []).map(element).join("");
    if (block.type === "rich_text_list") return (block.elements ?? []).map((item) => `• ${inline(item)}`).join("\n");
    if (block.type === "rich_text_quote") return quoted(inline(block));
    if (block.type === "rich_text_preformatted") return `\`\`\`${inline(block)}\`\`\``;
    return inline(block);
  });
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function element(part: RichText): string {
  switch (part.type) {
    case "text": {
      const style = part.style ?? {};
      const mark = (style.code ? "`" : "") + (style.bold ? "*" : "") + (style.italic ? "_" : "") + (style.strike ? "~" : "");
      const text = escapeSlack(part.text ?? "");
      // Marks go around the words, not the spaces at either end, or Slack won't show them.
      const [, before = "", words = "", after = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];
      return mark && words ? `${before}${mark}${words}${[...mark].reverse().join("")}${after}` : text;
    }
    case "user":
      return `<@${part.user_id}>`;
    case "usergroup":
      return `<!subteam^${part.usergroup_id}>`;
    case "channel":
      return `<#${part.channel_id}>`;
    case "link":
      return part.text ? `<${part.url}|${escapeSlack(part.text)}>` : `<${part.url}>`;
    case "emoji":
      return `:${part.name}:`;
    case "broadcast":
      return `@${part.range}`;
    default:
      return "";
  }
}

// The form sent: posts what it holds, and removes the draft it came from.
function sendEdited(payload: SlackPayload, context: Context) {
  const { channel, ts, responseUrl } = readPayload<AskForm>(ASK_FORM, payload.view.private_metadata, "ask's Edit form");
  const text = fromRichText(payload.view.state.values[MESSAGE_BLOCK]?.value.rich_text_value);
  if (!text) return { response_action: "errors", errors: { [MESSAGE_BLOCK]: "Write the message, or cancel." } };
  if (text.length > MAX_MESSAGE) return { response_action: "errors", errors: { [MESSAGE_BLOCK]: `Keep it to ${MAX_MESSAGE} characters or fewer.` } };
  context.waitUntil(
    (async () => {
      await sendAsk(context.env, { channel, ts }, payload.user.id, text);
      await dismiss(responseUrl);
    })(),
  );
  return CLOSE_ALL;
}

const draftOf = (payload: SlackPayload, what: string) => readPayload<AskButton>(ASK_BUTTON, payload.actions[0].value, what);

export default {
  actions: {
    [SEND_ACTION]: async (payload, context) => {
      const draft = draftOf(payload, "ask's Send button");
      context.waitUntil(
        (async () => {
          await sendAsk(context.env, draft, payload.user.id, draft.text);
          await respondLater(payload.response_url, { delete_original: true });
        })(),
      );
    },
    // Opening a form must happen within Slack's three seconds of the click.
    [EDIT_ACTION]: async (payload, { env }) => {
      const draft = draftOf(payload, "ask's Edit button");
      await callSlack(env, "views.open", { trigger_id: payload.trigger_id, view: editForm(draft, payload.response_url) });
    },
    [SKIP_ACTION]: async (payload) => {
      await respondLater(payload.response_url, { delete_original: true });
    },
  },
  views: { [EDIT_VIEW]: sendEdited },
} satisfies Handler;
