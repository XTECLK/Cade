// What the Worker's tests share: the Worker with a fake Slack (mockSlack), signed requests to it (send), the
// test environment and its database, and the fixtures and helpers more than one test file uses. A helper only one
// file uses lives in that file.
import { beforeEach } from "node:test";
import worker from "../src/index.ts";
import { getTask, insertTask, markTaskPosted, putTask, setPrStates } from "../src/db.ts";
import { fakeD1 } from "./d1.ts";
import type { AppEnv } from "../src/env.ts";
import type { TestContext } from "node:test";
import type { PrState, Status, StoredTask } from "../src/types.ts";
import type { TrackForm } from "../src/payloads.ts";
import { SIGNING_SECRET, context, fake, sign } from "./helpers.ts";
// The tests sign their requests as Slack does (see helpers.ts).
export { sign };
import type { Change } from "../src/types.ts";

// Every environment shares this database; it is emptied for each test, and
// again by mockSlack.
export const DB = fakeD1();
beforeEach(() => DB.reset());
// The Worker's environment for the tests: the settings they need, and no AI binding unless a test adds one.
export const env = {
  DB,
  // Off unless turned on; most tests are of it.
  SUMMARY_CANVAS: "on",
  // No wait for further changes before the summary is written.
  SUMMARY_SETTLE_MS: "0",
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  PROJECTS: [
    { name: "acme", channel: "CDEV" },
    { name: "test", channel: "CTESTDEV" },
  ],
  // Whoever sends the commands in these tests is an admin, for the admin commands.
  ADMINS: JSON.stringify(["UACTOR"]),
} as unknown as AppEnv;

// Sends a signed request and waits for any background work it started.
export async function send(path, body, headers = {}, environment = env) {
  await seeded;
  const pending: Promise<unknown>[] = [];
  const request = new Request(`https://worker.example.net${path}`, {
    method: "POST",
    headers: { ...(await sign(body)), ...headers },
    body,
  });
  const response = await worker.fetch(
    request,
    environment,
    context((promise) => {
      pending.push(promise);
    }),
  );
  await Promise.all(pending);
  return response;
}

export const interaction = (payload) => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

// A message's blocks, then those of its attachment: a task's message has only its title (and its row
// of buttons, left out here: see cardButtons) outside the attachment that gives it a priority strip.
export const allBlocks = (args) =>
  [...(args.blocks ?? []), ...(args.attachments?.[0]?.blocks ?? [])].filter((block) => block.type !== "actions");

// A section's text, or a context block's first element's.
export const blockText = (block) => block.text?.text ?? block.elements?.[0]?.text;

// A task card's small text is in up to three blocks, a few lines each: what goes with it (whose
// subtask it is, its pages, its subtasks' and pull requests' counts); the work (its status and people);
// and who tracked it.
export const workLines = (args) => blockText(allBlocks(args).at(-2)).split("\n");
// The card's pull requests line, wherever it is.
export const prsLineOf = (args) =>
  allBlocks(args)
    .flatMap((block) => (blockText(block) ?? "").split("\n"))
    .find((line) => line.startsWith("Pull requests"));
// The work block's first line: the status, blocked mark, due date and the like.
export const statusLine = (args) => workLines(args)[0];
// Who works on it, then who tracked it: the last line of the work block, and the last block.
export const footerLines = (args) => [workLines(args).at(-1), blockText(allBlocks(args).at(-1))];

// The action_ids used more than once in a message's blocks.
export function duplicateActionIds(blocks) {
  const ids = blocks
    .flatMap((block) => [
      ...(block.elements ?? []).map((element) => element.action_id),
      block.accessory?.action_id,
      block.element?.action_id && `${block.block_id}:${block.element.action_id}`,
    ])
    .filter(Boolean);
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

// Stores a task record ({ channel, ts, task }) in the database. Where its pull requests stand on
// GitHub, `prStates`, is stored too, as the cron would. A subtask is stored as one is made, with its parent, which
// must be stored before it.
async function store(record) {
  if (record.task.parent)
    await markTaskPosted(env, await insertTask(env, record.channel, record.task, {}), record.ts, record.task.link);
  else await putTask(env, record.channel, record.ts, record.task);
  await setPrStates(
    env,
    Object.entries<PrState>(record.task.prStates ?? {}).map(([url, state]) => ({ url, state })),
  );
}
export let seeded: Promise<unknown> = Promise.resolve();

// The task as stored, after a test's commands.
export const savedTask = (channel = "CDEV", ts = "100.1") => getTask(env, channel, ts);

// Replaces fetch with a fake Slack API, with an empty database holding just
// `responses.stored` (task records). `responses` maps a
// method name to its result; every call is recorded with its decoded arguments. Link preview
// settings are recorded as `previews` rather than with the arguments.
// A call Cade made to Slack (or "respond", to a response_url), as mockSlack recorded it. Its `args`
// are what Cade sent, read freely by the assertions.
type Call = { method: string; args: any; headers?: unknown; previews?: { links?: boolean; media?: boolean } };
export let lastCalls: Call[] = [];
// Slack's replies by method: a reply, or a function of the call's arguments giving one.
type Replies = { stored?: readonly Stored[] } & Record<string, unknown>;

// What Slack answers unless a test says otherwise: everyone in these tests is in every channel.
const EVERYONE = [
  "UACTOR",
  "UADMIN",
  "UALICE",
  "UANN",
  "UBOB",
  "UCLICKER",
  "UCLIENT",
  "UCREATOR",
  "UDEV",
  "UDEV1",
  "UDEV2",
  "ULEAD",
  "UME",
  "UMIA",
  "UOTHER",
  "UPM",
  "UREX",
  "URIA",
  "UTC",
  "UTESS",
  "UTOM",
  "UZED",
  "UZOE",
];
// What Slack always sends that a test doesn't set itself: a new canvas's ID,
// without which saving the summary's canvas fails.
const DEFAULTS: Record<string, unknown> = {
  "conversations.members": { members: EVERYONE },
  "conversations.canvases.create": { canvas_id: "F0CANVAS" },
};

export function mockSlack(t: TestContext, { stored = [], ...responses }: Replies = {}) {
  DB.reset();
  seeded = Promise.all(stored.map(store));
  const calls: Call[] & { responses?: unknown[] } = (lastCalls = []);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    // Answers through a click's or command's response_url, unless a test
    // records them itself (see recordResponses).
    if (url === RESPONSE_URL) {
      calls.push({ method: "respond", args: JSON.parse(init.body) });
      return new Response("ok");
    }
    const method = new URL(url).pathname.replace("/api/", "");
    const args = Object.fromEntries(init.body);
    for (const name of ["view", "blocks", "attachments"]) {
      if (args[name]) args[name] = JSON.parse(args[name]);
    }
    // Slack rejects a message whose blocks reuse an action_id, with
    // invalid_blocks.
    for (const blocks of [args.blocks, args.view?.blocks]) {
      const reused = duplicateActionIds(blocks ?? []);
      if (reused.length) {
        calls.push({ method, args, headers: init.headers, previews: {} });
        return Response.json({ ok: false, error: "invalid_blocks", reused });
      }
    }
    const previews = { links: args.unfurl_links, media: args.unfurl_media };
    delete args.unfurl_links;
    delete args.unfurl_media;
    calls.push({ method, args, headers: init.headers, previews });
    const reply = method in responses ? responses[method] : DEFAULTS[method];
    const result = typeof reply === "function" ? reply(args) : reply;
    return Response.json({ ok: true, ...result });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

// What a change asks of people isn't posted: whoever made it is offered it privately, as a draft to send
// (see offerAsk in commands/ask.ts). The drafts offered among `calls`, each its text.
export function drafts(calls: Call[]): string[] {
  return calls
    .filter((call) => call.method === "chat.postEphemeral")
    .flatMap((call) => (call.args.blocks ?? []).flatMap((block) => block.elements ?? []))
    .filter((element) => element.action_id === "ask:send")
    .map((element) => JSON.parse(element.value).text);
}

// The track form, submitted from `origin`: /cade task in the dev channel,
// to begin with.
export const submission = (
  values: { title?: string; dueDate?: string; priority?: string; kind?: string },
  origin: TrackForm = { channel: "CDEV" },
) => ({
  type: "view_submission",
  user: { id: "UCREATOR" },
  view: {
    callback_id: "track",
    private_metadata: JSON.stringify(origin),
    state: {
      values: {
        title: { value: { value: values.title } },
        due_date: { value: { selected_date: values.dueDate ?? null } },
        priority: {
          value: {
            selected_option: values.priority ? { value: values.priority } : null,
          },
        },
        ...(values.kind && { kind: { value: { selected_option: { value: values.kind } } } }),
      },
    },
  },
});

// The task at CDEV/100.1 as stored. Each role lists its people's user IDs.
// A stored task as mockSlack takes it (`stored`): where it is, and the task.
export type Stored = { channel: string; ts: string; task: StoredTask };
type People = { owners?: string[]; reviewers?: string[]; testers?: string[]; status?: Status };

export const storedTask = ({ owners = [], reviewers = [], testers = [], status = "TODO" }: People = {}): Stored => ({
  channel: "CDEV",
  ts: "100.1",
  task: {
    title: "Fix login",
    priority: "High",
    status,
    dueDate: "31/10/2026",
    people: { owner: owners, reviewer: reviewers, tester: testers },
    prs: [],
    createdBy: "UCREATOR",
    completedAt: "",
  },
});

// The same, for tests that name it as the team's own.
export const ownTask = storedTask;

// An incident's task at CDEV/100.1: urgent, due immediately.
export const incidentTask = (people?: People) => {
  const record = storedTask(people);
  Object.assign(record.task, { title: "Checkout is down", priority: "Urgent", dueDate: "Immediate", incident: true });
  return record;
};

// Posting a root message in a dev channel creates the task; other posts are
// replies. The new task links as /p100.
export const createdTask = {
  "chat.postMessage": (args) =>
    args.channel.endsWith("DEV") && !args.thread_ts ? { channel: args.channel, ts: "100.1" } : { ts: "300.1" },
  "chat.getPermalink": { permalink: "https://slack.example/p100" },
};

// The calls besides those keeping the group's summary canvas, which a new
// task makes (see summary.js).
export const withoutSummary = (calls) =>
  calls.filter((call) => !/^(auth\.test|conversations\.canvases\.|canvases\.)/.test(call.method));

export const threadEvent = (text, overrides = {}) =>
  JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UBOT" }],
    event: {
      type: "message",
      channel: "CDEV",
      user: "UACTOR",
      text,
      ts: "100.5",
      thread_ts: "100.1",
      ...overrides,
    },
  });

export const withStatus = (status) => {
  const record = storedTask();
  record.task.status = status;
  return record;
};
export const deleteRequest = JSON.stringify({ kind: "task", channel: "CDEV", ts: "100.1" });

export const deleteClick = (actionId, user) =>
  interaction({
    type: "block_actions",
    user: { id: user },
    message: { ts: "100.9" },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: deleteRequest }],
  });

export const slackUsers = {
  "users.info": (args) => ({
    user: {
      profile: {
        display_name: {
          UCREATOR: "Randil",
          UALICE: "Alice",
          UBOB: "Bob",
          UREX: "Rex",
          UMIA: "Mia",
          UTESS: "Tess",
          UTOM: "Tom",
        }[args.user],
      },
    },
  }),
};

// `/cade …` slash commands arrive form-encoded.
export const slash = (text, channel = "CDEV") =>
  new URLSearchParams({
    command: "/cade",
    text,
    user_id: "UACTOR",
    channel_id: channel,
    trigger_id: "trigger-9",
  }).toString();

// A card's Edit button and ⋯ menu, in the row under its title, or undefined (an archived card has none).
export const cardButtons = (args) => args.blocks.find((block) => block.type === "actions")?.elements;
export const cardMenu = (args) => cardButtons(args)?.find((element) => element.action_id === "task:menu");

// Choosing `choice` from the ⋯ menu on the card of the task at CDEV/100.1.
export const cardMenuClick = (choice) =>
  interaction({
    type: "block_actions",
    trigger_id: "T1",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    message: { ts: "100.1" },
    actions: [{ action_id: "task:menu", selected_option: { value: choice } }],
  });

// A fourth pull request, on GitHub, for the Pull requests form and the sync.
export const PR4 = "https://github.com/acme/web/pull/9";

// GitHub's GraphQL API answering the sync's query: each pull request by its number in `states`, or null
// (one the token can't read). The queries asked are kept in `asked`. Slack is still mockSlack's.
export function mockGitHub(
  states: Record<number, string | null>,
  asked: { query: string; authorization: string }[] = [],
) {
  const slack = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://api.github.com/graphql") return slack(url, init);
    const { query } = JSON.parse(String(init?.body));
    asked.push({ query, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    const data = Object.fromEntries(
      [...query.matchAll(/(p\d+): repository\(owner: "[^"]+", name: "[^"]+"\) \{ pullRequest\(number: (\d+)\)/g)].map(
        ([, alias, number]) => {
          const state = states[Number(number)];
          return [alias, state ? { pullRequest: { state } } : null];
        },
      ),
    );
    return Response.json({
      data,
      ...(Object.values(states).includes(null) && { errors: [{ message: "Could not resolve to a Repository" }] }),
    });
  };
  return asked;
}
// A timestamp a Slack link can name.
export const RESYNC_TS = "1700000000.000200";

// The Worker's address in these tests (see send), which the cards' links are built on.
export const SITE = "https://worker.example.net";
export const NAMES = { UREX: { profile: { display_name: "Rex" } }, UBOB: { real_name: "Bob Lee", profile: {} } };
export const reply = (user, ts, text) => threadEvent(text, { user, ts });
export const get = (path: string, cookie?: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  worker.fetch(
    new Request(`${SITE}${path}`, { ...init, headers: { ...(cookie && { cookie }), ...init.headers } }),
    env,
    context(),
  );

// The approver clicking Approve or Not approve in the task's thread.
// Moves the task at `channel`/100.1 to Client review as UACTOR, clicks the
// private Ask for approval button and chooses `approver` in its form, sending `message` (rich text
// elements; by default what the form starts with, unchanged).
// Returns every Slack call, and in `calls.responses` what was sent to the
// button's response_url.
export async function clientReview(
  t,
  responses,
  { channel = "CDEV", approver = "UCREATOR", environment = env, message = undefined } = {},
) {
  const calls = mockSlack(t, responses);
  calls.responses = recordResponses(t);
  await send("/slack/events", threadEvent("<@UBOT> status client review", { channel }), {}, environment);
  const button = calls.find(
    (call) => call.method === "chat.postEphemeral" && call.args.blocks?.[1]?.elements?.[0]?.action_id === "status:ask",
  ).args.blocks[1].elements[0];
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      trigger_id: "T1",
      user: { id: "UACTOR" },
      channel: { id: channel },
      message: { ts: "100.8", thread_ts: "100.1" },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "status:ask", value: button.value }],
    }),
    {},
    environment,
  );
  const form = calls.findLast((call) => call.method === "views.open").args.view;
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: form.callback_id,
        private_metadata: form.private_metadata,
        state: {
          values: {
            approver: { "status:approver": { selected_user: approver } },
            message: {
              value: {
                rich_text_value: {
                  type: "rich_text",
                  elements: message ?? form.blocks[1].element.initial_value.elements,
                },
              },
            },
          },
        },
      },
    }),
    {},
    environment,
  );
  return calls;
}

// A stored task at `ts`, with `fields` changed.
export const historyTask = (ts, { owners = [], reviewers = [], testers = [], ...fields }) => {
  const record = storedTask({ owners, reviewers, testers });
  record.ts = ts;
  Object.assign(record.task, fields);
  return record;
};

// An incident's task at `ts`, as historyTask.
export const incidentHistoryTask = (ts, fields) =>
  historyTask(ts, { priority: "Urgent", dueDate: "Immediate", incident: true, ...fields });

// A response_url's answer: like the API, it refuses a message whose blocks
// reuse an action_id, with an OK status and { ok: false }.
function respondAsSlack(body) {
  const reused = duplicateActionIds(body.blocks ?? []);
  return reused.length ? Response.json({ ok: false, error: "invalid_blocks" }) : new Response("ok");
}

// Slash command answers sent later go to RESPONSE_URL.
export const RESPONSE_URL = "https://hooks.slack.com/commands/T1/1/abc";

// Sends `/cade <text>` and returns its immediate answer and the one sent later.
export async function runTasksCommand(text, channel, environment = env) {
  const fakeFetch = globalThis.fetch;
  let later;
  globalThis.fetch = async (url, init) => {
    if (url === RESPONSE_URL) {
      later = JSON.parse(init.body);
      return respondAsSlack(later);
    }
    return fakeFetch(url, init);
  };
  const form = new URLSearchParams(slash(text, channel));
  form.set("response_url", RESPONSE_URL);
  const response = await send("/slack/commands", form.toString(), {}, environment);
  globalThis.fetch = fakeFetch;
  return { now: await response.text(), later };
}

export const PR = "https://github.com/acme/cade/pull/42";
export const MR = "https://gitlab.com/acme/web/web-app/-/merge_requests/118";
export const PR3 = "https://github.com/acme/cade/pull/43";

// A plain (non-command) reply in the task's thread, as UACTOR.
export const threadReply = (text, overrides = {}) => threadEvent(text, overrides);

// Records what is sent to RESPONSE_URL. Install it after mockSlack, so it
// sees those requests first.
export function recordResponses(t) {
  const sent = [];
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === RESPONSE_URL) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return respondAsSlack(body);
    }
    return fakeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = fakeFetch;
  });
  return sent;
}

export const assignValue = (role, people, moveTo = null) =>
  JSON.stringify({ channel: "CDEV", ts: "100.1", role, people, moveTo });

export const clickAssign = (actionId, value) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value }],
  });

// In the dev channel: a message at 100.7, posted on its own, and tasks to
// move it to.
export const devStray = { ts: "100.7", user: "UACTOR", text: "The login bug also hits SSO\nfor some people" };
export const devTask = (ts: string, title: string, status: Status, fields: Partial<StoredTask> = {}) => {
  const record = storedTask();
  Object.assign(record, { ts });
  Object.assign(record.task, { title, status, ...fields });
  return record;
};

// A Slack API where conversations.replies gives `root` as the thread's root,
// posts get a ts in their thread, and permalinks end with the message's ts.
export const moveSlack = (root: Record<string, unknown> | null = devStray, replies: unknown[] = []) => ({
  "conversations.replies": { messages: root ? [root, ...replies] : [] },
  "chat.postMessage": (args) =>
    args.thread_ts ? { ts: `${args.thread_ts.split(".")[0]}.9` } : { channel: args.channel, ts: "100.1" },
  "chat.getPermalink": (args) => ({ permalink: `https://slack.example/${args.message_ts}` }),
});

// `@Cade move <link>`, replied in the stray message's thread. The task
// linked to is at TARGET.
export const TARGET = "1700000000.000100";
export const messageLink = (channel, ts, query = "") =>
  `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}${query}`;

// Choosing Cade's message shortcut `callbackId` (⋯ → More actions) on
// `message` in `channel`, a DM to begin with.
export const shortcutClick = (
  callbackId: string,
  message: Record<string, unknown> = { ts: "500.1", user: "UBOB", text: "Customers can't pay\nsince the deploy" },
  channel = "D0BOB",
) =>
  interaction({
    type: "message_action",
    callback_id: callbackId,
    trigger_id: "T1",
    response_url: RESPONSE_URL,
    team: { domain: "acme" },
    user: { id: "UACTOR" },
    channel: { id: channel },
    message,
  });

export const projectOptions = (view) =>
  view.blocks[0].element.options.map((option) => [option.text.text, option.value]);

// A task in `status`, with `people` in its roles.
export const taskWith = (status, people = {}) => {
  const record = storedTask(people);
  record.task.status = status;
  return record;
};

export const ephemeral = (calls) =>
  calls.find((call) => call.method === "chat.postEphemeral" && !drafts([call]).length)?.args;
// That note.
export const linkedNote = (calls) =>
  calls.find((call) => call.method === "chat.postEphemeral" && call.args.text.startsWith("I linked"))?.args;
// What its OK and Unlink carry: the task, the PRs, and what to suggest once clicked.
export const noteValue = (calls) => JSON.parse(linkedNote(calls).blocks[1].elements[0].value);

// The suggestion's Accept, Edit… and Reject, above the line saying where to turn suggestions off.
export const suggestionButtons = (question) => question.blocks.find((block) => block.type === "actions").elements;

// The changes Cade's private suggestion would make, as its Accept button
// carries them (see changes.js).
export const suggestedChanges = (question) => JSON.parse(suggestionButtons(question)[0].value).changes;
export const add = (...ids) => ({ add: ids, remove: [] });

// A suggestion read by AI: `text` sent in the task's thread, with the model answering `raw` (see
// aiRead). Resolves to the calls made and the private question asked, if any.
// `record` is the task, or the task and others stored with it, such as its subtasks.
export const aiSuggestion = async (t, text, record, raw, { user = "UACTOR", settings = {} } = {}) => {
  const { environment, asked } = aiEnv(aiRead(raw));
  const calls = mockSlack(t, { stored: [record].flat() });
  await send("/slack/events", threadReply(text, { user }), {}, { ...environment, ...settings });
  return { calls, question: ephemeral(calls), asked };
};

// A canvas's markdown, from conversations.canvases.create or canvases.edit.
export const canvasMarkdown = (call) =>
  call.method === "canvases.edit"
    ? JSON.parse(call.args.changes)[0].document_content.markdown
    : JSON.parse(call.args.document_content).markdown;

// The table rows of a summary's Open or Closed section, without their
// header and divider.
// The rows of a summary's `section`: Open, Closed or Archived.
export const summaryRows = (markdown, section = "Open") =>
  markdown
    .split("\n## ")
    .find((part) => part.startsWith(`${section}\n`))
    .split("\n")
    .filter((line) => line.startsWith("| ") && !/^\| (Title|---) /.test(line))
    .map(unbroken);

// Short cells, such as priorities, are kept on one line with non-breaking
// spaces; shown here as `~`.
const unbroken = (row) => row.replace(/\u00a0/g, "~");

export const canvasResponses = {
  ...slackUsers,
  "auth.test": { url: "https://acme.slack.com/" },
  "conversations.canvases.create": { canvas_id: "F0CANVAS" },
};

// Clicks `actionId` on a private question, as posted or sent to a
// response_url, as UACTOR. Returns what was sent to its response_url.
export async function answerPrivately(t, question, actionId, environment = env) {
  const responses = recordResponses(t);
  const button = question.blocks[1].elements.find((element) => element.action_id === actionId);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      message: { ts: "100.9" },
      response_url: RESPONSE_URL,
      actions: [{ action_id: actionId, value: button.value }],
    }),
    {},
    environment,
  );
  return responses;
}

// ---- Suggestions read with AI (see ai.js and ai-suggest.js) ----

// An environment with AI on, whose model answers `answer` (an object, as the
// changes it read) or throws it (an Error). The model's inputs are kept in
// `asked`.
export function aiEnv(answer: unknown) {
  const asked = [];
  const AI = {
    run: async (model, input) => {
      asked.push({ model, input });
      if (answer instanceof Error) throw answer;
      return { choices: [{ message: { content: JSON.stringify(answer) } }] };
    },
  };
  return { environment: { ...env, AI, AI_MODEL: "on" } as unknown as AppEnv, asked };
}

// What the model read, with nothing changed but `fields`.
export const aiRead = (fields = {}) => ({
  owner: { add: [], remove: [] },
  reviewer: { add: [], remove: [] },
  tester: { add: [], remove: [] },
  status: "",
  priority: "",
  dueDate: "",
  blocked: "",
  blockedReason: "",
  ...fields,
});

export const where = { channel: "CDEV", ts: "100.1" };

// ---- The acknowledgement engine: what is said about a change ----

// A change as changeTask returns it, with `task` as it now is.
// A change as notify.ts reads it, with only what a test sets; the task is a stand-in, with what notify reads of it.
export const changed = ({
  people = [],
  prs = null,
  status = null,
  priority = null,
  dueDate = null,
  told = {},
  task = {},
}: Partial<Omit<Change, "task">> & { task?: Partial<StoredTask> } = {}): Change =>
  fake<Change>({
    user: "UACTOR",
    told,
    people,
    prs,
    status,
    priority,
    dueDate,
    task: {
      status: status?.to ?? "TODO",
      prs: prs?.added ?? [],
      people: { owner: [], reviewer: [], tester: [] },
      ...task,
    },
  });

// ---- Subtasks ----

// A subtask of the task at CDEV/100.1 ("Fix login"), at `ts`, as historyTask.
export const subtaskOf = (ts: string, fields: Record<string, unknown> = {}) =>
  historyTask(ts, { title: "Fails on Safari", parent: { ts: "100.1", title: "Fix login" }, ...fields });

// Cards with timestamps a Slack link can name, for the commands that take links.
export const [T1, T2, T3] = ["1700000000.000100", "1700000000.000200", "1700000000.000300"];
// A message link to the card at `ts` in CDEV, as Copy link gives it.
export const cardLink = (ts: string) => `<${messageLink("CDEV", ts)}>`;
// As an admin may send them.
export const asAdmin = { ...env, ADMINS: JSON.stringify(["UACTOR"]) } as AppEnv;

// Clicks a button on Cade's private "link these PRs?" question.
export const suggestionClick = (actionId, urls) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.1", urls }) }],
  });
