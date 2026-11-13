// The shapes Cade's modules pass to each other. Rows as D1 stores them are in
// db.ts; these are what the rest of the code sees.

export type Priority = "Urgent" | "High" | "Medium" | "Low";
export type Status = "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "IN_TESTING" | "CLIENT_REVIEW" | "DONE";
// Who works on a task: the owner does the work, whatever it is.
export type Role = "owner" | "reviewer" | "tester";
export type People = Record<Role, string[]>;
// Where a pull request stands on GitHub (see github.ts): OPEN, drafts too, MERGED, or CLOSED without merging.
export type PrState = "OPEN" | "MERGED" | "CLOSED";
// A pull request whose state changed, as setPrStates in db.ts saved it: `from` is missing the first time it is read.
export type PrChange = { url: string; from?: PrState; to: PrState };

// A task, as stored (see taskFromRow in db.ts). Fields a new task may not
// have yet are optional.
export interface Task {
  title: string;
  priority: Priority;
  status: Status;
  // DD/MM/YYYY, "Immediate" for an incident, or "" for none.
  dueDate?: string;
  people: People;
  // The URLs of its pull requests.
  prs?: string[];
  // A Slack user ID.
  createdBy: string;
  // Whether it was made through the person's AI agent (create_task in mcp.ts), which its card says.
  viaAgent?: boolean;
  completedAt?: string;
  incident?: boolean;
  blocked?: boolean;
  blockedReason?: string;
  // The task's root message.
  link?: string;
  notes?: { url: string };
  export?: { url: string };
  // Where its pull requests stand, by URL, which its card counts: given when it is read, not stored
  // with it. One not in it hasn't been read from GitHub, and counts as open (see prState in tasks.ts).
  prStates?: Record<string, PrState>;
  // The task it is a subtask of, in the same channel: its root message, title and link. Set when a
  // subtask is made, and kept for good (see insertTask in db.ts).
  parent?: Parent;
  // How many of its subtasks are open and closed (Done), which its card shows: given when it is
  // read, not stored with it.
  subtaskCounts?: { open: number; closed: number };
}

// A subtask's parent task (see Task), and its owners: a subtask with none of its own is shown as theirs
// (see shownPeople in tasks.ts).
export interface Parent {
  ts: string;
  title: string;
  link?: string;
  owner?: string[];
}

// A task as loaded from the database: it always has its pull requests.
export type StoredTask = Task & { prs: string[] };

// Slack's Block Kit is large and loose; blocks are built as plain objects. The one field read
// back is a section's text (see review in commands/status.ts).
export type SlackBlock = { text?: { type?: string; text?: string; emoji?: boolean }; [key: string]: unknown };

// A message body Cade posts or answers with.
export interface MessageBody {
  text?: string;
  blocks?: SlackBlock[];
  attachments?: SlackBlock[];
  // A reply in a thread, and what a response_url answer replaces or deletes.
  thread_ts?: string;
  response_type?: "ephemeral" | "in_channel";
  replace_original?: boolean;
  delete_original?: boolean;
}

// What a form's inputs hold when it is sent: values[block_id][action_id].
export interface InputValue {
  type?: string;
  value?: string | null;
  selected_date?: string | null;
  selected_option?: { value: string; text?: { text: string } } | null;
  selected_options?: { value: string }[];
  selected_user?: string | null;
  selected_users?: string[];
  selected_conversation?: string | null;
  selected_channel?: string | null;
  rich_text_value?: RichText;
}

// A rich text box's value, and what it holds: sections of text, people and links; lists, quotes and
// code. Only what Cade reads (see fromRichText in commands/ask.ts).
export interface RichText {
  type: string;
  text?: string;
  style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };
  user_id?: string;
  usergroup_id?: string;
  channel_id?: string;
  url?: string;
  name?: string;
  range?: string;
  elements?: RichText[];
}
// Every Cade form names its input's action "value".
export type ViewValues = Record<string, { value: InputValue; [actionId: string]: InputValue }>;

// A Slack message, as events and conversations.replies give them: only what Cade reads.
export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  // A bot's or app's post, and its name.
  bot_id?: string;
  // The app that posted it. On a person's message (no bot_id), an app, such as an AI agent's Slack
  // tool, posted it for them.
  app_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  subtype?: string;
  text?: string;
  blocks?: SlackBlock[];
  files?: { name?: string; title?: string; permalink?: string }[];
  reactions?: { name: string }[];
  // A thread's root: how many replies it has, and when the last came.
  reply_count?: number;
  latest_reply?: string;
}

// A button, menu or picker used, in a click's `actions`.
export interface SlackAction {
  action_id: string;
  block_id: string;
  value: string;
  selected_option: { value: string };
  selected_user?: string;
  selected_users?: string[];
}

// What Slack sends for a click, a shortcut or a form (block_actions,
// shortcut, message_action, view_submission, view_closed). Only the fields
// Cade reads are named; the rest are there as Slack sends them. Each handler
// is registered for one kind (a button's action_id, a form's callback_id, a
// shortcut's callback_id), so the fields that kind carries are typed as
// present: `actions` on a click, `view` on a form, `channel` and `message` on
// a click in a message or a message shortcut.
export interface SlackPayload {
  type: string;
  user: { id: string; name?: string; username?: string; team_id?: string };
  team?: { id: string; domain?: string };
  channel: { id: string; name?: string };
  message: SlackMessage;
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string; type?: string };
  // A click carries the action clicked: at least one.
  actions: [SlackAction, ...SlackAction[]];
  view: { id: string; callback_id: string; private_metadata: string; hash?: string; state: { values: ViewValues } };
  // The inputs in the message a click came from, such as a picker beside its buttons.
  state?: { values: ViewValues };
  trigger_id: string;
  response_url: string;
  callback_id?: string;
}

// What every handler is given with a request (see index.ts).
export interface Context {
  env: import("./env.ts").AppEnv;
  // The Worker's address.
  origin: string;
  // Runs `promise` after Slack is answered, logging it if it fails.
  waitUntil(promise: Promise<unknown>): void;
}

// A command: a message that starts by mentioning Cade, or `/cade name …`
// (see parse.ts).
export interface Command {
  // The command name, lowercased ("" when none was given).
  name: string;
  // Everything after the name.
  text: string;
  // Users mentioned in `text`, Cade aside.
  mentions: string[];
  user: string;
  channel: string;
  ts?: string;
  threadTs?: string;
  // A slash command's, for opening a modal straight away.
  triggerId?: string;
  // A slash command's, for answering later, privately.
  responseUrl?: string;
}

// A `/cade name …` command: Slack always sends these two with one.
export type SlashCommand = Command & { triggerId: string; responseUrl: string };

// An acknowledgement: a ✅ on the command, and `note`, if any, posted too
// (see acknowledge in slack.ts).
// `ask`: what the change asks of people, offered privately to whoever sent the command before it's
// posted (see offerAsk in commands/ask.ts).
export interface Acknowledgement {
  reaction: string;
  note?: unknown;
  ask?: string[];
}

// What a command answers: plain text, a message body, an acknowledgement,
// or nothing.
export type Reply = string | MessageBody | Acknowledgement | null | undefined | void;

// A plain message as intents see it (see plainMessage in intents.ts).
export interface PlainMessage {
  text: string;
  user: string;
  channel: string;
  ts: string;
  threadTs?: string;
  // Whether it's a reply in a thread.
  inThread: boolean;
  // The people it mentions, Cade aside.
  mentions: string[];
  // Cade's own user ID.
  botUserId: string;
}

// A plain message Cade acts on (see intents.ts).
export interface Intent {
  name: string;
  order: number;
  kinds: string[];
  needs: { thread?: boolean; mention?: boolean };
  test(message: PlainMessage): boolean;
  handle(message: PlainMessage, context: Pick<Context, "env">): unknown;
}

// What answers a button, a form or a shortcut: the body of Slack's response,
// such as { response_action: "errors", errors }, or nothing.
export type PayloadHandler = (payload: SlackPayload, context: Context) => unknown;

export type ChannelScope = "channel" | "channel"[];

// A command or other handler, as registry.ts lists them (see there).
export interface Handler {
  name?: string;
  description?: string;
  usage?: string | string[];
  slashUsage?: string | string[];
  section?: "message" | "task" | "work";
  aliases?: string[];
  // For Cade's admins only (see isAdmin in settings.ts), and not in help: the whole command, with its
  // buttons and forms (`admin`), or only its `/cade` form (`slashAdmin`), the `@Cade` one being for anyone.
  admin?: boolean;
  slashAdmin?: boolean;
  // The channels in PROJECTS it works in: "channel", or [] for any channel.
  channel?: ChannelScope;
  slashChannel?: ChannelScope;
  inThread?: boolean;
  run?(command: Command, context: Context): Reply | Promise<Reply>;
  slash?(command: SlashCommand, context: Context): Reply | Promise<Reply>;
  views?: Record<string, PayloadHandler>;
  actions?: Record<string, PayloadHandler>;
  shortcuts?: Record<string, PayloadHandler>;
  reactions?(event: SlackEvent, context: Context): Promise<unknown>;
  intents?: Intent[];
}

// An event from Slack's Events API: a message (with a message's fields), reaction_added or
// app_home_opened. Only what Cade reads.
export interface SlackEvent extends Partial<SlackMessage> {
  type: string;
  channel?: string;
  // reaction_added: the emoji, and the message it was added to.
  reaction?: string;
  item?: { type: string; channel: string; ts: string };
  // app_home_opened: which tab.
  tab?: string;
}

// Changes to make to a task, each optional (see changeTask in
// commands/changes.ts). Pull requests are links.
export interface Changes {
  people?: Partial<Record<Role, { add?: string[]; remove?: string[] }>>;
  status?: Status;
  priority?: Priority;
  dueDate?: string;
  prs?: { add?: string[]; remove?: string[] };
  blocked?: { on: boolean; reason?: string };
}

// What a change actually did, as notify.ts reads it: only what changed is
// set, and `task` is the task as it now is.
export interface Change {
  user: string;
  // Who the message a suggestion came from mentioned, so was told already.
  told: Record<string, null>;
  task: Task;
  people: { role: Role; added: string[]; removed: string[] }[];
  prs: { added: string[]; removed: string[] } | null;
  priority: { from: Priority; to: Priority } | null;
  dueDate: { from?: string; to: string } | null;
  status: { from: Status; to: Status } | null;
  blocked: { to: boolean; reason: string } | null;
}
