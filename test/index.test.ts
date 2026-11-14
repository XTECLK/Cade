import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import worker from "../src/index.ts";
import { parseDate } from "../src/commands/details.ts";
import { parseMessage } from "../src/commands/parse.ts";
import { getTask, insertTask, markTaskDeleted, markTaskPosted, putTask, setPrStates } from "../src/db.ts";
import { changeTask } from "../src/commands/changes.ts";
import { editForm } from "../src/commands/edit.ts";
import { changeLog, changeRequests } from "../src/notify.ts";
import { fromRichText as fromRichTextOf, toRichText as toRichTextOf } from "../src/commands/ask.ts";
import { formatDueDate } from "../src/tasks.ts";
import { writeSummary } from "../src/summary.ts";
import { todayIn } from "../src/commands/tasks.ts";
import { fakeD1 } from "./d1.ts";
import type { AppEnv } from "../src/env.ts";
import type { TestContext } from "node:test";
import type { PrState, Status, StoredTask } from "../src/types.ts";
import type { Project } from "../src/channels.ts";
import type { TrackForm } from "../src/payloads.ts";
import { context, fake } from "./helpers.ts";
import type { Allowed } from "../src/ai.ts";
import type { Change, PlainMessage } from "../src/types.ts";

const SIGNING_SECRET = "test-signing-secret";
// Every environment shares this database; it is emptied for each test, and
// again by mockSlack.
const DB = fakeD1();
beforeEach(() => DB.reset());
// The Worker's environment for the tests: the settings they need, and no AI binding unless a test adds one.
const env = {
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

async function sign(body, timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": `v0=${hex}`,
  };
}

// Sends a signed request and waits for any background work it started.
async function send(path, body, headers = {}, environment = env) {
  await seeded;
  const pending: Promise<unknown>[] = [];
  const request = new Request(`https://worker.example.net${path}`, {
    method: "POST",
    headers: { ...(await sign(body)), ...headers },
    body,
  });
  const response = await worker.fetch(request, environment, context((promise) => { pending.push(promise); }));
  await Promise.all(pending);
  return response;
}

const interaction = (payload) =>
  new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

// A message's blocks, then those of its attachment: a task's message has only its title (and its row
// of buttons, left out here: see cardButtons) outside the attachment that gives it a priority strip.
const allBlocks = (args) => [...(args.blocks ?? []), ...(args.attachments?.[0]?.blocks ?? [])].filter((block) => block.type !== "actions");

// A section's text, or a context block's first element's.
const blockText = (block) => block.text?.text ?? block.elements?.[0]?.text;

// A task card's small text is in up to three blocks, a few lines each: what goes with it (whose
// subtask it is, its pages, its subtasks' and pull requests' counts); the work (its status and people);
// and who tracked it.
const workLines = (args) => blockText(allBlocks(args).at(-2)).split("\n");
// The card's pull requests line, wherever it is.
const prsLineOf = (args) => allBlocks(args).flatMap((block) => (blockText(block) ?? "").split("\n")).find((line) => line.startsWith("Pull requests"));
// The work block's first line: the status, blocked mark, due date and the like.
const statusLine = (args) => workLines(args)[0];
// Who works on it, then who tracked it: the last line of the work block, and the last block.
const footerLines = (args) => [workLines(args).at(-1), blockText(allBlocks(args).at(-1))];

// The action_ids used more than once in a message's blocks.
function duplicateActionIds(blocks) {
  const ids = blocks.flatMap((block) => [
    ...(block.elements ?? []).map((element) => element.action_id),
    block.accessory?.action_id,
    block.element?.action_id && `${block.block_id}:${block.element.action_id}`,
  ]).filter(Boolean);
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

// Stores a task record ({ channel, ts, task }) in the database. Where its pull requests stand on
// GitHub, `prStates`, is stored too, as the cron would. A subtask is stored as one is made, with its parent, which
// must be stored before it.
async function store(record) {
  if (record.task.parent) await markTaskPosted(env, await insertTask(env, record.channel, record.task, {}), record.ts, record.task.link);
  else await putTask(env, record.channel, record.ts, record.task);
  await setPrStates(env, Object.entries<PrState>(record.task.prStates ?? {}).map(([url, state]) => ({ url, state })));
}
let seeded: Promise<unknown> = Promise.resolve();

// `record`, moved to `channel`.
const inChannel = (channel, record) => ({ ...record, channel });

// The task as stored, after a test's commands.
const savedTask = (channel = "CDEV", ts = "100.1") => getTask(env, channel, ts);

// Replaces fetch with a fake Slack API, with an empty database holding just
// `responses.stored` (task records). `responses` maps a
// method name to its result; every call is recorded with its decoded arguments. Link preview
// settings are recorded as `previews` rather than with the arguments.
// A call Cade made to Slack (or "respond", to a response_url), as mockSlack recorded it. Its `args`
// are what Cade sent, read freely by the assertions.
type Call = { method: string; args: any; headers?: unknown; previews?: { links?: boolean; media?: boolean } };
let lastCalls: Call[] = [];
// Slack's replies by method: a reply, or a function of the call's arguments giving one.
type Replies = { stored?: readonly Stored[] } & Record<string, unknown>;

// What Slack answers unless a test says otherwise: everyone in these tests is in every channel.
const EVERYONE = ["UACTOR", "UADMIN", "UALICE", "UANN", "UBOB", "UCLICKER", "UCLIENT", "UCREATOR", "UDEV", "UDEV1", "UDEV2", "ULEAD", "UME", "UMIA", "UOTHER", "UPM", "UREX", "URIA", "UTC", "UTESS", "UTOM", "UZED", "UZOE"];
// What Slack always sends that a test doesn't set itself: a new canvas's ID,
// without which saving the summary's canvas fails.
const DEFAULTS: Record<string, unknown> = {
  "conversations.members": { members: EVERYONE },
  "conversations.canvases.create": { canvas_id: "F0CANVAS" },
};

function mockSlack(t: TestContext, { stored = [], ...responses }: Replies = {}) {
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
function drafts(calls: Call[]): string[] {
  return calls
    .filter((call) => call.method === "chat.postEphemeral")
    .flatMap((call) => (call.args.blocks ?? []).flatMap((block) => block.elements ?? []))
    .filter((element) => element.action_id === "ask:send")
    .map((element) => JSON.parse(element.value).text);
}

// The track form, submitted from `origin`: /cade task in the dev channel,
// to begin with.
const submission = (values: { title?: string; dueDate?: string; priority?: string }, origin: TrackForm = { channel: "CDEV" }) => ({
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
      },
    },
  },
});

// The task at CDEV/100.1 as stored. Each role lists its people's user IDs.
// A stored task as mockSlack takes it (`stored`): where it is, and the task.
type Stored = { channel: string; ts: string; task: StoredTask };
type People = { owners?: string[]; reviewers?: string[]; testers?: string[]; status?: Status };

const storedTask = ({ owners = [], reviewers = [], testers = [], status = "TODO" }: People = {}): Stored => ({
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
const ownTask = storedTask;

// An incident's task at CDEV/100.1: urgent, due immediately.
const incidentTask = (people?: People) => {
  const record = storedTask(people);
  Object.assign(record.task, { title: "Checkout is down", priority: "Urgent", dueDate: "Immediate", incident: true });
  return record;
};

// Posting a root message in a dev channel creates the task; other posts are
// replies. The new task links as /p100.
const createdTask = {
  "chat.postMessage": (args) =>
    args.channel.endsWith("DEV") && !args.thread_ts ? { channel: args.channel, ts: "100.1" } : { ts: "300.1" },
  "chat.getPermalink": { permalink: "https://slack.example/p100" },
};

// The calls besides those keeping the group's summary canvas, which a new
// task makes (see summary.js).
const withoutSummary = (calls) => calls.filter((call) => !/^(auth\.test|conversations\.canvases\.|canvases\.)/.test(call.method));

const threadEvent = (text, overrides = {}) =>
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

test("rejects requests with an invalid signature", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example.net/slack/events", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": `v0=${"0".repeat(64)}`,
      },
      body: "{}",
    }),
    env,
    context(),
  );
  assert.equal(response.status, 401);
});

test("rejects signed requests older than five minutes", async () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
  const timestamp = Math.floor(Date.now() / 1000) - 600;
  const response = await worker.fetch(
    new Request("https://worker.example.net/slack/events", {
      method: "POST",
      headers: await sign(body, timestamp),
      body,
    }),
    env,
    context(),
  );
  assert.equal(response.status, 401);
});

test("answers the Events API URL verification challenge", async () => {
  const response = await send(
    "/slack/events",
    JSON.stringify({ type: "url_verification", challenge: "abc" }),
  );
  assert.deepEqual(await response.json(), { challenge: "abc" });
});

test("modal submission rejects a blank title", async (t) => {
  const calls = mockSlack(t);
  const response = await send(
    "/slack/interactions",
    interaction(submission({ title: "   ", priority: "High" })),
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(await response.json(), {
    response_action: "errors",
    errors: { title: "Please give the task a title." },
  });
});

test("modal submission without a due date leaves it out", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" })),
  );
  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV");
  assert.equal(statusLine(post.args), ":memo: To do");
});

test("modal submission tells the creator when the task cannot be posted", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: new URL(url).pathname.replace("/api/", ""), args: Object.fromEntries(init.body) });
    return Response.json({ ok: false, error: "channel_not_found" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" })),
  );
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.postEphemeral"]);
  assert.equal(calls[1].args.user, "UCREATOR");
  assert.equal(calls[1].args.channel, "CDEV");
  assert.match(calls[1].args.text, /^Sorry, I couldn't post the task "Fix login" just now\. I'll try again in a few minutes\.$/);
  // The task is stored, waiting to be posted.
  const row = await DB.prepare("SELECT ts, post_attempts, origin FROM tasks").first<{ ts: string | null; post_attempts: number; origin: string }>();
  assert.equal(row.ts, null);
  assert.equal(row.post_attempts, 1);
  assert.deepEqual(JSON.parse(row.origin), {});
});

test("@Cade assign adds people to a role on the root message", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE"], testers: ["UTESS"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB> <@UALICE|alice>"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add", "chat.postEphemeral"],
  );
  const update = calls[0].args;
  assert.equal(update.ts, "100.1");
  assert.equal(
    footerLines(update)[0],
    "Owner <@UALICE>, <@UBOB>  ·  Test <@UTESS>",
  );
  const task = await savedTask();
  assert.deepEqual(task.people, { owner: ["UALICE", "UBOB"], reviewer: [], tester: ["UTESS"] });
  assert.equal(task.dueDate, "31/10/2026");
  // The card shows who is on it, so the command gets a ✅, and whoever sent it is offered to ask them,
  // privately, in the thread: nothing is posted.
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.equal(calls[2].args.channel, "CDEV");
  assert.equal(calls[2].args.thread_ts, "100.1");
  assert.equal(calls[2].args.user, "UACTOR");
  // @alice was an owner already, so isn't asked again.
  assert.deepEqual(drafts(calls), ["<@UBOB>, could you pick this up?"]);
});

test("the draft of what a change asks of people is sent, edited or left by whoever made it", async (t) => {
  const offered = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  const offer = offered.find((call) => call.method === "chat.postEphemeral").args;
  const buttons = offer.blocks.at(-1).elements;
  assert.deepEqual(buttons.map((button) => button.text.text), ["Send", "Edit", "Not now"]);
  const click = (button, user = "UACTOR") =>
    interaction({ type: "block_actions", user: { id: user }, channel: { id: "CDEV" }, container: { is_ephemeral: true }, trigger_id: "trigger", response_url: RESPONSE_URL, actions: [{ action_id: button.action_id, value: button.value }] });

  // Send posts it in the task's thread, saying whose it is, and removes the draft.
  let calls = mockSlack(t, { stored: [storedTask()] });
  let sent = recordResponses(t);
  await send("/slack/interactions", click(buttons[0]));
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.deepEqual([post.channel, post.thread_ts, post.text], ["CDEV", "100.1", "<@UACTOR> sent:\n<@UBOB>, could you pick this up?"]);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  // Not now removes it and posts nothing.
  calls = mockSlack(t, { stored: [storedTask()] });
  sent = recordResponses(t);
  await send("/slack/interactions", click(buttons[2]));
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  // Edit opens it in a form, mentions as people, to change before it's sent.
  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/interactions", click(buttons[1]));
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.callback_id, "ask:edit");
  assert.deepEqual(form.blocks[0].element.initial_value, {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "UBOB" }, { type: "text", text: ", could you pick this up?" }] }],
  });

  // Sent, it posts what the form holds, and removes the draft.
  const submit = (elements) =>
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: { callback_id: "ask:edit", private_metadata: form.private_metadata, state: { values: { message: { value: { rich_text_value: { type: "rich_text", elements } } } } } },
    });
  calls = mockSlack(t, { stored: [storedTask()] });
  sent = recordResponses(t);
  const response = await send(
    "/slack/interactions",
    submit([
      { type: "rich_text_section", elements: [{ type: "user", user_id: "UBOB" }, { type: "text", text: " can you test it on " }, { type: "text", text: "staging", style: { bold: true } }, { type: "text", text: " <today> " }, { type: "emoji", name: "pray" }] },
      { type: "rich_text_list", elements: [{ type: "rich_text_section", elements: [{ type: "link", url: "https://x.example", text: "the notes" }] }] },
    ]),
  );
  assert.deepEqual(await response.json(), { response_action: "clear" });
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    "<@UACTOR> sent:\n<@UBOB> can you test it on *staging* &lt;today&gt; :pray:\n• <https://x.example|the notes>",
  );
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  // An empty one isn't sent.
  calls = mockSlack(t, { stored: [storedTask()] });
  const empty = await send("/slack/interactions", submit([{ type: "rich_text_section", elements: [{ type: "text", text: "  " }] }]));
  assert.deepEqual(await empty.json(), { response_action: "errors", errors: { message: "Write the message, or cancel." } });
  assert.deepEqual(calls, []);
});

test("@Cade assign works for each role, in any word order", async (t) => {
  for (const [text, role, reply] of [
    // No PR yet, so there's nothing to ask the reviewer.
    ["<@UBOT> assign reviewer <@UBOB>", "reviewer", undefined],
    // Not In testing yet, so nothing to ask the tester either.
    ["<@UBOT> assign tester <@UBOB>", "tester", undefined],
    ["<@UBOT> assign <@UBOB> as Tester", "tester", undefined],
    ["<@UBOT> assign owners <@UBOB>", "owner", "<@UBOB>, could you pick this up?"],
  ] as const) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual((await savedTask()).people[role], ["UBOB"], text);
    assert.equal(calls[1].args.name, "white_check_mark", text);
    assert.equal(drafts(calls)[0], reply, text);
  }
});

test("people are asked only when there's something for them to do now", async (t) => {
  const task = (status, prs = [], prStates = {}) => {
    const root = storedTask();
    Object.assign(root.task, { status, prs, prStates });
    return root;
  };
  const ask = (role) =>
    ({
      owner: "<@UBOB>, could you pick this up?",
      reviewer: `<@UBOB>, could you review this?`,
      tester: "<@UBOB>, could you give this a test?",
    })[role];
  for (const [role, root, asked] of [
    ["owner", task("TODO"), true],
    ["owner", task("DONE"), false],
    // Reviewers review the PRs still open.
    ["reviewer", task("IN_REVIEW", [PR]), true],
    ["reviewer", task("IN_REVIEW", [PR, MR], { [MR]: "MERGED" }), true],
    ["reviewer", task("IN_REVIEW", [PR], { [PR]: "CLOSED" }), false],
    // Testers test it once it's In testing.
    ["tester", task("IN_REVIEW"), false],
    ["tester", task("IN_TESTING"), true],
  ] as const) {
    const calls = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadEvent(`<@UBOT> assign ${role} <@UBOB>`));
    const label = `${role} on ${root.task.status} with ${root.task.prs.length} PRs`;
    assert.equal(drafts(calls)[0], asked ? ask(role) : undefined, label);

    // Those removed are told only when they would have been asked.
    root.task.people[role] = ["UBOB"];
    const again = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadEvent(`<@UBOT> unassign ${role} <@UBOB>`));
    const note = `<@UBOB>, there's no need to ${{ owner: "work on", reviewer: "review", tester: "test" }[role]} this anymore.`;
    assert.equal(drafts(again)[0], asked ? note : undefined, label);
  }
});

test("@Cade assign takes short words for each role", async (t) => {
  for (const [text, role] of [
    ["<@UBOT> assign owner <@UBOB>", "owner"],
    ["<@UBOT> assign devs <@UBOB>", "owner"],
    ["<@UBOT> assign review <@UBOB>", "reviewer"],
    ["<@UBOT> assign test <@UBOB>", "tester"],
    ["<@UBOT> assign qa <@UBOB>", "tester"],
  ] as const) {
    mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual((await savedTask()).people[role], ["UBOB"], text);
  }
});

test("@Cade unassign with a role removes people from that role only", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE", "UBOB"], reviewers: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign owner <@UALICE>"));
  const { people } = await savedTask();
  assert.deepEqual(people.owner, ["UBOB"]);
  assert.deepEqual(people.reviewer, ["UALICE"]);
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(drafts(calls), ["<@UALICE>, there's no need to work on this anymore."]);
});

test("@Cade unassign without a role removes people from every role", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE", "UBOB"], reviewers: ["UALICE"], testers: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> unassign <@UALICE>"));
  assert.deepEqual((await savedTask()).people, { owner: ["UBOB"], reviewer: [], tester: [] });
  assert.equal(
    footerLines(calls[0].args)[0],
    "Owner <@UBOB>",
  );
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(drafts(calls), ["<@UALICE>, there's no need to work on this anymore."]);
});

test("@Cade status updates the task's status", async (t) => {
  const calls = mockSlack(t, {
    stored: [storedTask({ owners: ["UALICE"] })],
  });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));

  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.update", "reactions.add"],
  );
  const update = calls[0].args;
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.deepEqual((await savedTask()).people.owner, ["UALICE"]);
  assert.match(blockText(allBlocks(update)[1]), /^:arrow_forward: In progress  ·/);
  // A typed status gets a ✅ on the command, not a reply.
  assert.deepEqual(calls[1].args, { channel: "CDEV", timestamp: "100.5", name: "white_check_mark" });
});

test("Cade never pins or unpins a task: not when it's made, done, reopened or archived", async (t) => {
  const pins = (calls) => calls.filter((call) => call.method.startsWith("pins."));
  let calls = mockSlack(t, createdTask);
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "Low" })));
  assert.deepEqual(pins(calls), []);

  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "reactions.add"]);

  const done = storedTask();
  done.task.status = "DONE";
  calls = mockSlack(t, { stored: [done] });
  await send("/slack/events", threadEvent("<@UBOT> status IN_TESTING"));
  assert.deepEqual(pins(calls), []);

  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> archive"));
  assert.deepEqual(pins(calls), []);
});

test("a task is announced, then linked, before its summary canvas is made", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = new URL(url).pathname.replace("/api/", "");
    calls.push(method);
    if (method === "chat.getPermalink") return Response.json({ ok: true, permalink: "https://slack.example/p100" });
    if (method === "conversations.canvases.create") return Response.json({ ok: true, canvas_id: "F0CANVAS" });
    return Response.json({ ok: true, channel: "CDEV", ts: "100.1" });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" })),
  );
  // Then the group's summary canvas is made (see summary.js).
  assert.deepEqual(calls.slice(0, 2), ["chat.postMessage", "chat.getPermalink"]);
});

const withStatus = (status) => {
  const record = storedTask();
  record.task.status = status;
  return record;
};

test("a typed status gets a ✅ and never a question", async (t) => {
  for (const [root, input] of [
    [withStatus("TODO"), "in progress"],
    [withStatus("IN_PROGRESS"), "in review"],
    [withStatus("CLIENT_REVIEW"), "done"],
    [withStatus("DONE"), "client review"],
    [withStatus("DONE"), "done"],
    [withStatus("DONE"), "in progress"],
    [ownTask(), "done"],
  ] as const) {
    const calls = mockSlack(t, { stored: [root] });
    await send("/slack/events", threadEvent(`<@UBOT> status ${input}`));
    assert.ok(calls.some((call) => call.method === "reactions.add"), input);
    // Nothing is posted in the thread but the ✅.
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"), input);
  }
});

test("@Cade status accepts every status name", async (t) => {
  for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "IN_TESTING", "CLIENT_REVIEW", "DONE"]) {
    mockSlack(t, {
      stored: [storedTask()],
    });
    await send("/slack/events", threadEvent(`<@UBOT> status ${status.toLowerCase()}`));
    assert.deepEqual((await savedTask()).status, status);
  }
});

test("admin commands have no @Cade form: delete, remove, replace, resync, retry and project are unknown", async (t) => {
  for (const name of ["delete", "remove", "replace", "resync", "retry", "project"]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(`<@UBOT> ${name}`));
    assert.equal(calls.at(-1).args.text, "Send `/cade help` to see what I can do.", name);
    assert.ok(await savedTask(), name);
  }
});
const deleteRequest = JSON.stringify({ kind: "task", channel: "CDEV", ts: "100.1" });

const deleteClick = (actionId, user) =>
  interaction({
    type: "block_actions",
    user: { id: user },
    message: { ts: "100.9" },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: deleteRequest }],
  });

test("confirming deletion removes Cade's replies and then the task", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": {
            messages: [
              { ts: "100.1", bot_id: "BCADE" },
              { ts: "100.2", user: "UACTOR" },
              { ts: "100.3", bot_id: "BCADE" },
              { ts: "100.4", bot_id: "BCADE" },
            ],
          },
  });
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      actions: [
        { action_id: "delete:confirm", value: deleteRequest },
      ],
    }),
  );

  assert.equal(response.status, 200);
  const deletes = calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts);
  assert.deepEqual(deletes, ["100.3", "100.4", "100.1"]);
  // Whoever confirmed sees the task go: nothing is posted, not even
  // privately.
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("deleting a task posts nothing, and only answers whoever asked", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.delete", "respond"]);
  assert.deepEqual(calls.at(-1).args, { response_type: "ephemeral", replace_original: true, text: "Done, it's gone." });
});

test("@Cade assign in a thread that is not a task says so", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.deepEqual(
    calls.map((call) => call.method),
    ["chat.postMessage"],
  );
  assert.equal(calls[0].args.text, "Hmm, I'm not tracking a task in this thread.");
});

test("commands outside the dev channels point to them", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "COTHER" }));
  assert.equal(calls[0].args.text, "That one works with `@Cade assign owner @person` in a task thread in <#CDEV> or <#CTESTDEV>.");

  calls = mockSlack(t);
  const reply = await (await send("/slack/commands", slash("standup", "COTHER"))).json<{ response_type: string; text: string }>();
  assert.equal(calls.length, 0);
  assert.equal(reply.response_type, "ephemeral");
  assert.match(reply.text, /^That one works with `\/cade standup` in <#CDEV> or <#CTESTDEV>\.$/);
});

test("/cade task and /cade incident in any channel open their form, with the Project to choose", async (t) => {
  for (const [kind, callback] of [["task", "track"], ["incident", "incident"]]) {
    // In a channel that isn't a project's, no project is chosen to begin with.
    let calls = mockSlack(t);
    await send("/slack/commands", slash(kind, "COTHER"));
    let { view } = calls[0].args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].block_id, "project");
    assert.equal(view.blocks[0].optional, undefined, "the Project is required");
    assert.deepEqual(projectOptions(view), [["acme", "CDEV"], ["test", "CTESTDEV"]]);
    assert.equal(view.blocks[0].element.initial_option, undefined);
    assert.deepEqual(JSON.parse(view.private_metadata), {});

    // In a project's channel, its project is chosen.
    calls = mockSlack(t);
    await send("/slack/commands", slash(kind, "CTESTDEV"));
    ({ view } = calls[0].args);
    assert.equal(view.blocks[0].element.initial_option.value, "CTESTDEV");
  }
});

test("the Project chosen on the form decides where the task goes", async (t) => {
  const calls = mockSlack(t, createdTask);
  const form = submission({ title: "Fix login", priority: "High" }, { channel: "CDEV" });
  const values = { ...form.view.state.values, project: { value: { selected_option: { value: "CTESTDEV" } } } };
  await send("/slack/interactions", interaction({ ...form, view: { ...form.view, state: { values } } }));
  assert.equal(calls[0].method, "chat.postMessage");
  assert.equal(calls[0].args.channel, "CTESTDEV");
});

test("@Cade task in the thread of a message in any channel Cade is in offers to track it, asking for the Project", async (t) => {
  const root = { ts: "300.1", user: "UBOB", text: "Invoices miss the VAT number" };
  let calls = mockSlack(t, { "conversations.replies": { messages: [root] } });
  await send("/slack/events", threadEvent("<@UBOT> task", { channel: "COTHER", ts: "300.2", thread_ts: "300.1" }));
  const question = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.equal(question.channel, "COTHER");
  const button = question.blocks[1].elements[0];

  calls = mockSlack(t);
  recordResponses(t);
  await send(
    "/slack/interactions",
    interaction({ type: "block_actions", trigger_id: "T1", response_url: RESPONSE_URL, user: { id: "UACTOR" }, channel: { id: "COTHER" }, actions: [{ action_id: button.action_id, value: button.value }] }),
  );
  const { view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(view.blocks[0].block_id, "project");
  assert.equal(view.blocks[0].element.initial_option, undefined);
  assert.deepEqual(JSON.parse(view.private_metadata), { move: { channel: "COTHER", ts: "300.1" }, title: "Invoices miss the VAT number" });
});

test("New task on a message in a channel Cade isn't in warns to invite it, and offers no AI prompt", async (t) => {
  for (const [info, away] of [
    [{ channel: { id: "CPUBLIC", is_member: false } }, true],
    [{ ok: false, error: "channel_not_found" }, true],
    [{ channel: { id: "CPUBLIC", is_member: true } }, false],
  ] as const) {
    const calls = mockSlack(t, { "conversations.info": info });
    await send("/slack/interactions", shortcutClick("convert", undefined, "CPUBLIC"));
    const { view } = calls.find((call) => call.method === "views.open").args;
    const warning = view.blocks.find((block) => block.type === "context" && /not in <#CPUBLIC>/.test(blockText(block)));
    assert.equal(Boolean(warning), away);
    if (away) assert.match(blockText(warning), /Invite me with `\/invite @Cade` in <#CPUBLIC>/);
    assert.equal(JSON.parse(view.private_metadata).move.away, away || undefined);
  }

  // The task is still made, with the message copied in, but without the AI prompt, which reads the
  // thread it came from.
  const calls = mockSlack(t, { ...moveSlack(), "conversations.info": { channel: { id: "CPUBLIC", is_member: false } } });
  await send("/slack/interactions", shortcutClick("convert", undefined, "CPUBLIC"));
  const { view } = calls.find((call) => call.method === "views.open").args;
  const values = {
    project: { value: { selected_option: { value: "CDEV" } } },
    title: { value: { value: "Payments down" } },
    due_date: { value: { selected_date: null } },
    priority: { value: { selected_option: { value: "High" } } },
  };
  const answer = await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "track", private_metadata: view.private_metadata, state: { values } } }));
  assert.deepEqual(await answer.json(), { response_action: "clear" });
});
test("tasks tracked in the test channel go to the test channel", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "High" }, { channel: "CTESTDEV" })));
  assert.equal(calls[0].args.channel, "CTESTDEV");
});

test("thread commands work in the test tasks channel", async (t) => {
  const calls = mockSlack(t, {
    stored: [inChannel("CTESTDEV", storedTask())],
  });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "CTESTDEV" }));
  assert.equal(calls[0].args.channel, "CTESTDEV");
  assert.equal(calls[1].args.channel, "CTESTDEV");
  assert.deepEqual((await savedTask("CTESTDEV")).people.owner, ["UBOB"]);
});

test("no projects in the config is fine: Cade just tracks nothing there", async (t) => {
  const calls = mockSlack(t);
  const pending: Promise<unknown>[] = [];
  const body = threadEvent("<@UBOT> assign owner <@UBOB>");
  await worker.fetch(
    new Request("https://worker.example.net/slack/events", {
      method: "POST",
      headers: await sign(body),
      body,
    }),
    { ...env, PROJECTS: undefined },
    context((promise) => { pending.push(promise); }),
  );
  await Promise.all(pending);
  assert.equal(calls[0].args.text, "Hmm, I'm not tracking a task in this thread.");
});

test("a bare @Cade, @Cade help and unknown commands point to /cade help", async (t) => {
  for (const text of ["<@UBOT> help", "<@UBOT>", "<@UBOT> hello"]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    assert.equal(calls[0].args.text, "Send `/cade help` to see what I can do.");
  }
});

test("ignores messages that do not start with @Cade, bots, edits and retries", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("looks good, assign it later"));
  await send("/slack/events", threadEvent("cade is great"));
  await send("/slack/events", threadEvent("cade assign <@UBOB>"));
  await send("/slack/events", threadEvent("/cade assign <@UBOB>"));
  await send("/slack/events", threadEvent("hi <@UBOT> assign <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { bot_id: "B1" }));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { subtype: "message_changed" }));
  await send("/slack/events", threadEvent("<@UOTHER> assign <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"), {
    "x-slack-retry-num": "1",
  });
  assert.equal(calls.length, 0);
});

test("parseMessage reads the command name and mentioned people", () => {
  const command = parseMessage(
    {
      type: "message",
      text: "<@UBOT> Assign <@UBOB> <@UALICE|alice> <@UBOB> <@UBOT>",
      user: "UACTOR",
      channel: "CDEV",
      ts: "100.5",
      thread_ts: "100.1",
    },
    "UBOT",
  );
  assert.deepEqual(command, {
    name: "assign",
    text: "<@UBOB> <@UALICE|alice> <@UBOB> <@UBOT>",
    mentions: ["UBOB", "UALICE"],
    user: "UACTOR",
    channel: "CDEV",
    ts: "100.5",
    threadTs: "100.1",
  });
  assert.equal(parseMessage({ type: "message", text: "<@UBOT> TRACK" }, "UBOT").name, "track");
  assert.equal(parseMessage({ type: "message", text: "<@UBOT>" }, "UBOT").name, "");
  assert.equal(parseMessage({ type: "message", text: "@Cade task" }, "UBOT"), null);
  assert.equal(parseMessage({ type: "message", text: "<@UOTHER> track" }, "UBOT"), null);
});

const slackUsers = {
  "users.info": (args) => ({
    user: { profile: { display_name: { UCREATOR: "Randil", UALICE: "Alice", UBOB: "Bob", UREX: "Rex", UMIA: "Mia", UTESS: "Tess", UTOM: "Tom" }[args.user] } },
  }),
};
test("a group without a name is reported", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UBOB>"), {}, {
    ...env,
    PROJECTS: [{ channel: "CDEV" }],
  });
  assert.equal(calls[0].args.text, "Sorry, something went wrong with `assign`. Could you try again?");
});
test("setting Done again keeps the original completion time", async (t) => {
  const done = withStatus("DONE");
  done.task.completedAt = "2026-10-20T04:30:00.000Z";
  mockSlack(t, { ...slackUsers, stored: [done] });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.equal((await savedTask()).completedAt, "2026-10-20T04:30:00.000Z");
});
test("formatDueDate shows the picked date as DD/MM/YYYY", () => {
  assert.equal(formatDueDate("2026-10-31"), "31/10/2026");
  assert.equal(formatDueDate("2027-01-05"), "05/01/2027");
  assert.equal(formatDueDate(null), "");
  assert.equal(formatDueDate(undefined), "");
});

// `/cade …` slash commands arrive form-encoded.
const slash = (text, channel = "CDEV") =>
  new URLSearchParams({
    command: "/cade",
    text,
    user_id: "UACTOR",
    channel_id: channel,
    trigger_id: "trigger-9",
  }).toString();

test("/cade task opens the task form straight away", async (t) => {
  const calls = mockSlack(t);
  const response = await send("/slack/commands", slash("task", "CDEV"));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  assert.equal(calls[0].args.trigger_id, "trigger-9");
  assert.equal(calls[0].args.view.callback_id, "track");
  assert.deepEqual(JSON.parse(calls[0].args.view.private_metadata), { channel: "CDEV" });
});

test("/cade task in the dev channel posts the task without an announcement", async (t) => {
  const calls = mockSlack(t, createdTask);
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "Low" }, { channel: "CDEV" })),
  );
  assert.deepEqual(withoutSummary(calls).map((call) => call.method), ["chat.postMessage", "chat.getPermalink", "conversations.replies", "chat.update"]);
});

test("/cade help and unknown slash commands list the commands privately", async (t) => {
  for (const text of ["", "help", "hello"]) {
    mockSlack(t);
    const reply = await (await send("/slack/commands", slash(text))).json<{ response_type: string; text: string }>();
    assert.equal(reply.response_type, "ephemeral");
    // The slash commands, the messages sent in a thread, the shortcuts, and
    // the admin commands, each on its own.
    assert.deepEqual(reply.text.split("\n"), [
      "Here's what I can do:",
      "*Slash commands*, at the top of a channel:",
      "`/cade task` · `/cade incident` · `/cade standup`",
      "*Messages*, sent in a thread:",
      "• In a message's thread: `@Cade task` · `@Cade incident` · `@Cade move <link>`",
      "• In a task's thread: `@Cade assign owner @person` · `@Cade unassign owner @person` · `@Cade status in review` · `@Cade priority high` · `@Cade due 31/12/2026` · `@Cade pr add <link>` · `@Cade pr remove <link>` · `@Cade subtask <title>` · `@Cade archive`",
      "*On any message*: ⋯ → More actions → New task, New incident or Move to existing.",
      "Send `/cade help` any time to see this again.",
    ]);
    for (const usage of ["/cade task", "/cade incident", "@Cade task", "@Cade priority high", "@Cade due 31/12/2026"]) {
      assert.ok(reply.text.includes(`\`${usage}\``), usage);
    }
  }
});

test("parseDate accepts DD/MM/YYYY and YYYY-MM-DD real dates only", () => {
  assert.equal(parseDate("1/2/2027"), "01/02/2027");
  assert.equal(parseDate("01-02-2027"), "01/02/2027");
  assert.equal(parseDate("2027-02-01"), "01/02/2027");
  assert.equal(parseDate("29/02/2027"), "");
  assert.equal(parseDate("13/13/2027"), "");
  assert.equal(parseDate("tomorrow"), "");
});

test("Cade's messages never preview the messages they link to", async (t) => {
  const calls = mockSlack(t, {
    stored: [withStatus("DONE")],
    ...createdTask,
  });
  await send(
    "/slack/interactions",
    interaction(submission({ title: "Fix login", priority: "High" })),
  );
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));

  const posts = calls.filter((call) => ["chat.postMessage", "chat.update"].includes(call.method));
  assert.ok(posts.length >= 3);
  for (const call of posts) {
    assert.deepEqual(call.previews, { links: "false", media: "false" }, call.method);
  }
});

test("@Cade priority and due change the task's priority and due date", async (t) => {
  for (const [text, field, value, reply] of [
    ["<@UBOT> priority low", "priority", "Low", "<@UACTOR> set the priority to :large_green_circle: Low."],
    ["<@UBOT> due 5/1/2027", "dueDate", "05/01/2027", "<@UACTOR> set the due date to 05/01/2027."],
    ["<@UBOT> due 2027-02-28", "dueDate", "28/02/2027", "<@UACTOR> set the due date to 28/02/2027."],
  ] as const) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), [
      "chat.update",
      "reactions.add",
    ], text);
    assert.equal((await savedTask())[field], value, text);
    assert.deepEqual(calls[1].args, { channel: "CDEV", timestamp: "100.5", name: "white_check_mark" }, reply);
  }
});

test("owners were called developers before, and dev and developer still mean owner", async (t) => {
  for (const word of ["owner", "owners", "dev", "developer", "developers"]) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadEvent(`<@UBOT> assign ${word} <@UBOB>`));
    assert.deepEqual((await savedTask()).people.owner, ["UBOB"], word);
    assert.deepEqual(drafts(calls), ["<@UBOB>, could you pick this up?"], word);
  }
});

test("commands without what they need say what to send", async (t) => {
  for (const [text, reply] of [
    ["<@UBOT> assign", "Who, and as what? Try `@Cade assign owner @person`, `@Cade assign review @person`, `@Cade assign test @person`."],
    ["<@UBOT> assign <@UBOB>", "Who, and as what? Try `@Cade assign owner @person`, `@Cade assign review @person`, `@Cade assign test @person`."],
    ["<@UBOT> unassign", "Who? Try `@Cade unassign owner @person`, or `@Cade unassign @person` for every role."],
    ["<@UBOT> status", "Which status? Try `@Cade status in review`: to do, in progress, in review, in testing, client review or done."],
    ["<@UBOT> status soon", "I don't know \"soon\" as a status. Try `@Cade status in review`: to do, in progress, in review, in testing, client review or done."],
    ["<@UBOT> priority", "Which priority? Try `@Cade priority high`: urgent, high, medium or low."],
    ["<@UBOT> priority soon", "I don't know \"soon\" as a priority. Try `@Cade priority high`: urgent, high, medium or low."],
    ["<@UBOT> due", "When is it due? Try `@Cade due 31/12/2026`, or `@Cade due none` to clear it."],
    ["<@UBOT> due 31/02/2027", "I couldn't read \"31/02/2027\" as a date. Try `@Cade due 31/12/2026`, or `@Cade due none` to clear it."],
  ] as const) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"], text);
    assert.equal(calls[0].args.text, reply, text);
    assert.equal((await savedTask()).status, "TODO", text);
  }
});

// A card's Edit button and ⋯ menu, in the row under its title, or undefined (an archived card has none).
const cardButtons = (args) => args.blocks.find((block) => block.type === "actions")?.elements;
const cardMenu = (args) => cardButtons(args)?.find((element) => element.action_id === "task:menu");

// Clicking a card's Subtasks button, on the task at CDEV/`ts`; then Add subtask under the list it opens.
const subtasksClick = (ts = "100.1") =>
  interaction({ type: "block_actions", trigger_id: "T1", user: { id: "UACTOR" }, channel: { id: "CDEV" }, message: { ts }, actions: [{ action_id: "task:subtasks" }] });
const addFromList = (list, user = "UACTOR") => {
  const button = list.blocks.at(-1).elements[0];
  return interaction({ type: "block_actions", trigger_id: "T2", user: { id: user }, view: { id: "VLIST" }, actions: [{ action_id: button.action_id, value: button.value }] });
};

// Choosing `choice` from the ⋯ menu on the card of the task at CDEV/100.1.
const cardMenuClick = (choice) =>
  interaction({
    type: "block_actions",
    trigger_id: "T1",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    message: { ts: "100.1" },
    actions: [{ action_id: "task:menu", selected_option: { value: choice } }],
  });

test("a task's card has Edit, Subtasks and Pull requests buttons, and a menu with Archive; a subtask's has no Subtasks", async (t) => {
  const row = async (record, ts = "100.1") => {
    const calls = mockSlack(t, { stored: [record].flat() });
    await send("/slack/events", threadEvent("<@UBOT> status in progress", { thread_ts: ts }));
    const card = calls.find((call) => call.method === "chat.update" && call.args.ts === ts).args;
    return { buttons: cardButtons(card).map((element) => [element.type, element.action_id, element.text?.text]), menu: cardMenu(card).options.map((option) => option.text.text) };
  };
  const withPrs = ownTask();
  withPrs.task.prs = [PR, MR];
  // They sit in one row under the title: the buttons first, then the ⋯ menu.
  for (const record of [ownTask(), withPrs]) {
    assert.deepEqual(await row(record), {
      buttons: [["button", "task:edit", "Edit"], ["button", "task:subtasks", "Subtasks"], ["button", "task:prs", "Pull requests"], ["overflow", "task:menu", undefined]],
      menu: ["Archive"],
    });
  }
  assert.deepEqual((await row([ownTask(), subtaskOf("100.2")], "100.2")).buttons.map(([, id]) => id), ["task:edit", "task:prs", "task:menu"]);
});

// A fourth pull request, on GitHub, for the Pull requests form and the sync.
const PR4 = "https://github.com/acme/web/pull/9";

// The card's Pull requests button, clicked on the task at CDEV/100.1.
const prsClick = () =>
  interaction({ type: "block_actions", trigger_id: "T1", user: { id: "UACTOR" }, channel: { id: "CDEV" }, message: { ts: "100.1" }, actions: [{ action_id: "task:prs" }] });

// The Pull requests form saved with `box` in its box.
const prsSubmission = (box) =>
  interaction({
    type: "view_submission",
    user: { id: "UACTOR" },
    view: { callback_id: "task:prs", private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1" }), state: { values: { prs: { value: { value: box } } } } },
  });

test("the card's Pull requests button lists them in Open, Merged and Closed, as full links, with Edit on Open only, which opens the form for the open ones", async (t) => {
  const record = ownTask();
  record.task.prs = [PR, MR, PR3, PR4];
  record.task.prStates = { [PR3]: "MERGED", [PR4]: "CLOSED" };
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/interactions", prsClick());
  const { view, trigger_id } = calls.find((call) => call.method === "views.open").args;
  assert.equal(trigger_id, "T1");
  // Only to see: no submit, and nothing to type in.
  assert.equal(view.submit, undefined);
  const sections = view.blocks.filter((block) => block.type === "section");
  // The GitLab one can't be read from GitHub, so it's open.
  assert.deepEqual(sections.map((block) => block.text.text), [`*Open*\n<${PR}>\n<${MR}>`, `*Merged*\n<${PR3}>`, `*Closed*\n<${PR4}>`]);
  assert.deepEqual(sections.map((block) => block.accessory?.action_id), ["prs:edit", undefined, undefined]);

  // Edit opens the form on top of the list, with the open ones in its box.
  await send(
    "/slack/interactions",
    interaction({ type: "block_actions", trigger_id: "T2", user: { id: "UACTOR" }, actions: [{ action_id: "prs:edit", value: sections[0].accessory.value }] }),
  );
  const pushed = calls.find((call) => call.method === "views.push").args;
  assert.equal(pushed.trigger_id, "T2");
  assert.equal(pushed.view.callback_id, "task:prs");
  assert.deepEqual(pushed.view.blocks.map((block) => block.block_id), ["prs"]);
  assert.equal(pushed.view.blocks[0].element.initial_value, `${PR}\n${MR}`);

  // With none, every section says so, and Open still has Edit, to add one.
  const none = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", prsClick());
  const empty = none.find((call) => call.method === "views.open").args.view.blocks.filter((block) => block.type === "section");
  assert.deepEqual(empty.map((block) => block.text.text), ["*Open*\n_None_", "*Merged*\n_None_", "*Closed*\n_None_"]);
  assert.equal(empty[0].accessory.action_id, "prs:edit");
});

test("saving the Pull requests form links new links and unlinks open ones taken out, keeping merged and closed ones", async (t) => {
  const record = ownTask();
  record.task.prs = [PR, MR, PR3];
  record.task.prStates = { [PR3]: "MERGED" };
  const calls = mockSlack(t, { stored: [record] });
  // PR taken out, PR4 added; the merged one written in again changes nothing.
  const sent = await send("/slack/interactions", prsSubmission(`${MR}\n<${PR4}|web/9>\n${PR3}`));
  assert.deepEqual(await sent.json(), { response_action: "clear" });
  assert.deepEqual((await savedTask()).prs, [MR, PR3, PR4]);
  const post = calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").args;
  assert.equal(post.text, `<@UACTOR> linked <${PR4}|web/9>.\n<@UACTOR> unlinked <${PR}|cade/42>.`);

  // An empty box unlinks the open ones only.
  mockSlack(t, { stored: [record] });
  await send("/slack/interactions", prsSubmission(""));
  assert.deepEqual((await savedTask()).prs, [PR3]);

  // A link that isn't a pull request is refused in the form, and nothing changes.
  mockSlack(t, { stored: [record] });
  const refused = await send("/slack/interactions", prsSubmission(`${PR}\nnot a link`));
  assert.deepEqual(await refused.json(), { response_action: "errors", errors: { prs: "That doesn't look like a pull request link: not a link" } });
  assert.deepEqual((await savedTask()).prs, [PR, MR, PR3]);
});

// GitHub's GraphQL API answering the sync's query: each pull request by its number in `states`, or null
// (one the token can't read). The queries asked are kept in `asked`. Slack is still mockSlack's.
function mockGitHub(states: Record<number, string | null>, asked: { query: string; authorization: string }[] = []) {
  const slack = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "https://api.github.com/graphql") return slack(url, init);
    const { query } = JSON.parse(String(init?.body));
    asked.push({ query, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    const data = Object.fromEntries(
      [...query.matchAll(/(p\d+): repository\(owner: "[^"]+", name: "[^"]+"\) \{ pullRequest\(number: (\d+)\)/g)].map(([, alias, number]) => {
        const state = states[Number(number)];
        return [alias, state ? { pullRequest: { state } } : null];
      }),
    );
    return Response.json({ data, ...(Object.values(states).includes(null) && { errors: [{ message: "Could not resolve to a Repository" }] }) });
  };
  return asked;
}

test("the sync reads where open tasks' GitHub pull requests stand, saves it, and redraws the cards that changed", async (t) => {
  const { syncPullRequests } = await import("../src/github.ts");
  const open = storedTask();
  open.task.prs = [PR, PR3, MR];
  const done = withStatus("DONE");
  done.ts = "100.2";
  done.task.prs = [PR4];
  const calls = mockSlack(t, { stored: [open, done] });
  const asked = mockGitHub({ 42: "MERGED", 43: null });
  const withToken = { ...env, GITHUB_TOKEN: "ghp_test" };
  await seeded;
  await syncPullRequests(withToken);

  // One query, with the token, for the open task's GitHub pull requests: not GitLab's, nor a Done task's.
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.authorization, "bearer ghp_test");
  assert.match(asked[0]!.query, /repository\(owner: "acme", name: "cade"\) \{ pullRequest\(number: 42\) \{ state \} \}/);
  assert.match(asked[0]!.query, /pullRequest\(number: 43\)/);
  assert.doesNotMatch(asked[0]!.query, /web-app|number: 9\)/);
  // The one it couldn't read stays open; the card is redrawn with the merged one.
  assert.deepEqual((await savedTask()).prStates, { [PR]: "MERGED" });
  const cards = calls.filter((call) => call.method === "chat.update");
  assert.deepEqual(cards.map((call) => call.args.ts), ["100.1"]);
  assert.equal(prsLineOf(cards[0]!.args), "Pull requests: 2 open  ·  1 merged");

  // A merged one isn't asked again; one that hasn't changed redraws nothing.
  calls.length = 0;
  const again = mockGitHub({ 43: null });
  await syncPullRequests(withToken);
  assert.equal(again.length, 1);
  assert.doesNotMatch(again[0]!.query, /number: 42\)/);
  assert.ok(!calls.some((call) => call.method === "chat.update"));
});

test("open pull requests merged or closed on GitHub are told in each task's thread, one message a task", async (t) => {
  const { syncPullRequests } = await import("../src/github.ts");
  const PR5 = "https://github.com/acme/cade/pull/44";
  const PR6 = "https://github.com/acme/cade/pull/45";
  const open = storedTask({ status: "IN_REVIEW" });
  open.task.prs = [PR, PR3, PR5, PR6];
  open.task.prStates = { [PR]: "OPEN", [PR3]: "OPEN", [PR5]: "OPEN" };
  const other = storedTask();
  other.ts = "100.2";
  other.task.prs = [PR3];
  other.task.prStates = { [PR3]: "OPEN" };
  const calls = mockSlack(t, { stored: [open, other] });
  // 42 merged and 43 closed, 44 still open, 45 read for the first time already merged.
  mockGitHub({ 42: "MERGED", 43: "CLOSED", 44: "OPEN", 45: "MERGED" });
  await seeded;
  await syncPullRequests({ ...env, GITHUB_TOKEN: "ghp_test" });

  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(
    posts.map((call) => [call.args.thread_ts, call.args.text]).sort(),
    [
      ["100.1", `<${PR}|cade/42> was merged on GitHub.\n<${PR3}|cade/43> was closed on GitHub without merging.`],
      ["100.2", `<${PR3}|cade/43> was closed on GitHub without merging.`],
    ],
  );

  // Read again with nothing new, nothing is told again.
  calls.length = 0;
  mockGitHub({ 44: "OPEN" });
  await syncPullRequests({ ...env, GITHUB_TOKEN: "ghp_test" });
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("several pull requests of a task merged in one read are named together", async (t) => {
  const { syncPullRequests } = await import("../src/github.ts");
  const record = storedTask();
  record.task.prs = [PR, PR3];
  record.task.prStates = { [PR]: "OPEN", [PR3]: "OPEN" };
  const calls = mockSlack(t, { stored: [record] });
  mockGitHub({ 42: "MERGED", 43: "MERGED" });
  await seeded;
  await syncPullRequests({ ...env, GITHUB_TOKEN: "ghp_test" });
  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(posts.map((call) => call.args.text), [`<${PR}|cade/42>, <${PR3}|cade/43> were merged on GitHub.`]);
});

test("without GITHUB_TOKEN nothing is read from GitHub, and every pull request counts as open", async (t) => {
  const { syncPullRequests } = await import("../src/github.ts");
  const record = storedTask();
  record.task.prs = [PR];
  const calls = mockSlack(t, { stored: [record] });
  const asked = mockGitHub({ 42: "MERGED" });
  await seeded;
  await syncPullRequests(env);
  assert.equal(asked.length, 0);
  assert.equal(calls.length, 0);
});

test("Release in the menu of a card posted before partial releases went opens Edit, and a release's old buttons say they're gone", async (t) => {
  let calls = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/interactions", cardMenuClick("release"));
  assert.equal(calls.find((call) => call.method === "views.open").args.view.callback_id, "task:edit");

  for (const action_id of ["release:open", "release:approve", "release:reject"]) {
    calls = mockSlack(t, { stored: [ownTask()] });
    const sent = recordResponses(t);
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UCLIENT" }, channel: { id: "CDEV" }, response_url: RESPONSE_URL, message: { ts: "100.9", thread_ts: "100.1" }, actions: [{ action_id, value: "{}" }] }));
    assert.equal(sent.length, 1, action_id);
    assert.match(sent[0].text, /^Partial releases are gone\./, action_id);
    assert.equal(sent[0].replace_original, false, action_id);
  }
});

test("a card's Edit button opens the edit form, as Edit in the menu of a card posted before does", async (t) => {
  for (const click of [
    interaction({ type: "block_actions", trigger_id: "T1", user: { id: "UACTOR" }, channel: { id: "CDEV" }, message: { ts: "100.1" }, actions: [{ action_id: "task:edit" }] }),
    cardMenuClick("edit"),
  ]) {
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/interactions", click);
    const { view } = calls.find((call) => call.method === "views.open").args;
    assert.equal(view.callback_id, "task:edit");
    assert.equal(JSON.parse(view.private_metadata).ts, "100.1");
  }
});

test("@Cade archive and the card's Archive stop tracking the task, keeping its card and thread", async (t) => {
  for (const archive of [
    () => send("/slack/events", threadEvent("<@UBOT> archive")),
    () => send("/slack/interactions", cardMenuClick("archive")),
  ]) {
    const calls = mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })] });
    await archive();
    // Cade no longer finds it, but nothing is deleted.
    assert.equal(await savedTask(), null);
    assert.ok(!calls.some((call) => call.method === "chat.delete"));
    // The card says who archived it, and has no buttons.
    const card = calls.find((call) => call.method === "chat.update").args;
    assert.equal(card.ts, "100.1");
    assert.equal(cardButtons(card), undefined);
    assert.match(statusLine(card), /^:file_cabinet: Archived by <@UACTOR>  ·  Due 31\/10\/2026$/);
    // The thread hears who did.
    const post = calls.find((call) => call.method === "chat.postMessage").args;
    assert.deepEqual([post.thread_ts, post.text], ["100.1", "<@UACTOR> archived this task."]);
  }

  // Its thread no longer has a task.
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> archive"));
  assert.match(calls[0].args.text, /not tracking a task in this thread/);
});

test("the summary lists archived tasks in their own section, until they're deleted", async (t) => {
  const ts = "1700000000.000100";
  const calls = mockSlack(t, {
    ...canvasResponses,
    stored: [{ ...ownTask(), ts }, historyTask("100.2", { title: "Still open" })],
    "conversations.replies": { messages: [] },
  });
  await runTasksCommand("resync summary", "CDEV");
  await send("/slack/events", threadEvent("<@UBOT> archive", { thread_ts: ts }));
  const archived = canvasMarkdown(calls.filter((call) => call.method === "canvases.edit").at(-1));
  assert.deepEqual(summaryRows(archived).map((row) => row.match(/\[([^\]]+)\]/)[1]), ["Still open"]);
  assert.match(archived, /\n## Archived\n\nThe last 1 archived, most recently first\.\n\n/);
  assert.match(summaryRows(archived, "Archived")[0], /^\| \[Fix login\]/);

  // Deleted with /cade remove, it leaves the summary altogether.
  const { later } = await runTasksCommand(`remove <${messageLink("CDEV", ts)}>`, "CDEV");
  await answerPrivately(t, later, "delete:confirm");
  const deleted = canvasMarkdown(calls.filter((call) => call.method === "canvases.edit").at(-1));
  assert.match(deleted, /\n## Archived\n\nNo archived tasks\.$/);
});
// A timestamp a Slack link can name.
const RESYNC_TS = "1700000000.000200";

test("/cade resync <link> redraws a task's card quietly", async (t) => {
  const calls = mockSlack(t, { stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }] });
  await runTasksCommand(`resync ${messageLink("CDEV", RESYNC_TS)}`, "CDEV", env);
  const card = calls.find((call) => call.method === "chat.update").args;
  assert.equal(card.ts, RESYNC_TS);
  assert.equal(footerLines(card)[0], "Owner <@UREX>");
  // Nothing is posted, so no one is notified.
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral", "views.open"].includes(call.method)));
});

// The Worker's address in these tests (see send), which the cards' links are built on.
const SITE = "https://worker.example.net";
const NAMES = { UREX: { profile: { display_name: "Rex" } }, UBOB: { real_name: "Bob Lee", profile: {} } };
const reply = (user, ts, text) => threadEvent(text, { user, ts });
const storedMessages = async () => (await DB.prepare("SELECT * FROM messages ORDER BY ts").all()).results;
const linkLine = (card) => blockText(allBlocks(card)[1]);

test("Resync links the task's thread page on the card, and reads its thread into the database", async (t) => {
  const thread = [
    { user: "UREX", ts: RESYNC_TS, text: "Fix login" },
    { user: "UBOB", ts: "1700000000.000300", text: "On it", files: [{ name: "a.png", permalink: "https://acme.slack.com/files/a.png" }] },
  ];
  const calls = mockSlack(t, { stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }], "conversations.replies": () => ({ messages: thread }) });
  await runTasksCommand(`resync ${messageLink("CDEV", RESYNC_TS)}`, "CDEV", env);
  const card = calls.filter((call) => call.method === "chat.update").at(-1).args;
  assert.equal(linkLine(card), `Full history <${SITE}/t/CDEV/${RESYNC_TS}|here>`);
  assert.match(blockText(allBlocks(card)[2]), /^:memo: To do/);
  assert.equal(footerLines(card)[0], "Owner <@UREX>");
  const rows = await storedMessages();
  assert.deepEqual(rows.map((row) => [row.task_ts, row.ts, row.user_id, row.text]), [
    [RESYNC_TS, RESYNC_TS, "UREX", "Fix login"],
    [RESYNC_TS, "1700000000.000300", "UBOB", "On it"],
  ]);
  assert.deepEqual(JSON.parse(rows[1].files as string), [{ name: "a.png", permalink: "https://acme.slack.com/files/a.png" }]);

  // Again: nothing is stored twice.
  calls.length = 0;
  await runTasksCommand(`resync ${messageLink("CDEV", RESYNC_TS)}`, "CDEV", env);
  assert.equal((await storedMessages()).length, 2);
  assert.ok(!calls.some((call) => call.method === "doc"));
});
test("a new task has its thread stored as it is created, and its card links its thread's page", async (t) => {
  const calls = mockSlack(t, { ...createdTask, "conversations.replies": () => ({ messages: [{ user: "UBOT", ts: "100.1", text: "Fix login" }] }) });
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "Low" })));
  assert.deepEqual((await storedMessages()).map((row) => [row.task_ts, row.ts, row.text]), [["100.1", "100.1", "Fix login"]]);
  const update = calls.find((call) => call.method === "chat.update");
  assert.equal(update.args.ts, "100.1");
  assert.equal(linkLine(update.args), `Full history <${SITE}/t/CDEV/100.1|here>`);
  const { loadTask } = await import("../src/tasks.ts");
  assert.deepEqual((await loadTask(env, "CDEV", "100.1")).export, { url: `${SITE}/t/CDEV/100.1` });
});

test("a reply is stored at once, only from a tracked task's thread, and not twice", async (t) => {
  mockSlack(t, { stored: [ownTask({ owners: ["UREX"] })] });
  await seeded;
  await send("/slack/events", reply("UREX", "100.6", "in the thread"));
  await send("/slack/events", reply("UREX", "100.6", "in the thread"));
  await send("/slack/events", threadEvent("not a task", { thread_ts: "999.1", ts: "100.8" }));
  await send("/slack/events", threadEvent("joined", { subtype: "channel_join", ts: "100.9" }));
  assert.deepEqual((await storedMessages()).map((row) => [row.task_ts, row.ts, row.text]), [["100.1", "100.6", "in the thread"]]);
});

// Presses a button in Cade's web pages modal (see commands/configure.js) as `user`, with the calls of the last
// mockSlack. Resolves to the text of the modal Cade drew in answer.
async function pressWeb(actionId, user = "UACTOR") {
  const before = lastCalls.length;
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: user }, trigger_id: "T1", view: { id: "V1" }, actions: [{ action_id: actionId, value: "" }] }));
  const view = lastCalls.slice(before).find((call) => call.method === "views.update" || call.method === "views.open").args.view;
  return view.blocks.map((block) => block.text?.text ?? "").join("\n");
}

// Signs in the way a person does: the Get a sign-in link button, then the link it gives. Returns the cookie.
async function signIn() {
  const link = /<(https:\/\/worker\.example\.net\/login\/[\w-]+)\|/.exec(await pressWeb("home:web:login"))[1];
  const response = await worker.fetch(new Request(link), env, context());
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}
const get = (path: string, cookie?: string, init: RequestInit & { headers?: Record<string, string> } = {}) => worker.fetch(new Request(`${SITE}${path}`, { ...init, headers: { ...(cookie && { cookie }), ...init.headers } }), env, context());

test("the web pages modal's sign-in link signs you in once, for the thread pages", async (t) => {
  mockSlack(t, { stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }], "conversations.info": { channel: { name: "dev" } }, "users.info": ({ user }) => ({ user: NAMES[user] }) });
  await seeded;
  const link = /<(https:\/\/worker\.example\.net\/login\/[\w-]+)\|/.exec(await pressWeb("home:web:login"))[1];
  const first = await get(new URL(link).pathname);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie"), /^cade_session=[\w-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  // Used up: the same link doesn't work again.
  assert.equal((await get(new URL(link).pathname)).status, 401);
  assert.equal((await get("/login/not-a-code")).status, 401);
});

test("the thread page shows the stored messages with names, only for those in the channel, and there is no notes page", async (t) => {
  const calls = mockSlack(t, { stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }], "conversations.info": { channel: { name: "dev" } }, "conversations.members": { members: ["UACTOR"] }, "users.info": ({ user }) => ({ user: NAMES[user] }) });
  await seeded;
  await send("/slack/events", threadEvent("hello <@UBOB> &amp; <b>co</b>", { user: "UREX", ts: "1700000000.000400", thread_ts: RESYNC_TS }));
  const cookie = await signIn();

  // Not signed in: told how.
  const anonymous = await get(`/t/CDEV/${RESYNC_TS}`);
  assert.equal(anonymous.status, 401);
  assert.match(await anonymous.text(), /Web pages/);

  const thread = await get(`/t/CDEV/${RESYNC_TS}`, cookie);
  assert.equal(thread.status, 200);
  const html = await thread.text();
  assert.match(html, /<strong>Rex<\/strong>/);
  // Markup is plain text and HTML is escaped.
  assert.match(html, /hello @Bob Lee &amp; &lt;b&gt;co&lt;\/b&gt;/);
  assert.equal(thread.headers.get("cache-control"), "no-store");

  // A page for a task Cade doesn't have is not found.
  assert.equal((await get("/t/CDEV/1.1", cookie)).status, 404);
  assert.equal((await get("/t/not-a-channel/1.1", cookie)).status, 404);

  // The notes page is gone: an old card's link to it finds nothing, and the thread page doesn't link it.
  assert.equal((await get(`/n/CDEV/${RESYNC_TS}`, cookie)).status, 404);
  assert.doesNotMatch(html, /Notes/);
  assert.equal((await get(`/t/CDEV/${RESYNC_TS}`, cookie, { method: "POST" })).status, 405);
  assert.ok(calls.length > 0);
});

test("the pages are closed to someone who isn't in a public channel", async (t) => {
  mockSlack(t, { stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }], "conversations.info": { channel: { name: "dev" } }, "conversations.members": { members: ["UREX"] } });
  await seeded;
  const cookie = await signIn();
  assert.equal((await get(`/t/CDEV/${RESYNC_TS}`, cookie)).status, 404);
});

test("the pages are closed to someone who isn't in a private channel, and signing out ends the session", async (t) => {
  mockSlack(t, {
    stored: [{ ...ownTask({ owners: ["UREX"] }), ts: RESYNC_TS }],
    "conversations.info": { channel: { name: "secret", is_private: true } },
    "conversations.members": { members: ["UREX"] },
  });
  await seeded;
  const cookie = await signIn();
  assert.equal((await get(`/t/CDEV/${RESYNC_TS}`, cookie)).status, 404);
  await get("/logout", cookie);
  assert.equal((await get(`/t/CDEV/${RESYNC_TS}`, cookie)).status, 401);
});

test("choosing from a task card's menu opens its form, and an old card's choices open Edit", async (t) => {
  for (const [choice, callbackId] of [
    // Release, before partial releases went.
    ["release", "task:edit"],
    ["assign", "task:edit"],
    ["status", "task:edit"],
    ["more", "task:edit"],
  ] as const) {
    const record = ownTask({ owners: ["UREX"] });
    record.task.prs = ["https://github.com/acme/web/pull/9"];
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/interactions", cardMenuClick(choice));
    assert.deepEqual(calls.map((call) => call.method), ["views.open"], choice);
    assert.equal(calls[0].args.trigger_id, "T1");
    assert.equal(calls[0].args.view.callback_id, callbackId, choice);
  }
});

test("a task card's menu on a task that's gone says so privately", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/interactions", cardMenuClick("status"));
  assert.deepEqual(calls.map((call) => [call.method, call.args.user]), [["chat.postEphemeral", "UACTOR"]]);
});

// The approver clicking Approve or Not approve in the task's thread.
// Moves the task at `channel`/100.1 to Client review as UACTOR, clicks the
// private Ask for approval button and chooses `approver` in its form, sending `message` (rich text
// elements; by default what the form starts with, unchanged).
// Returns every Slack call, and in `calls.responses` what was sent to the
// button's response_url.
async function clientReview(t, responses, { channel = "CDEV", approver = "UCREATOR", environment = env, message = undefined } = {}) {
  const calls = mockSlack(t, responses);
  calls.responses = recordResponses(t);
  await send("/slack/events", threadEvent("<@UBOT> status client review", { channel }), {}, environment);
  const button = calls
    .find((call) => call.method === "chat.postEphemeral" && call.args.blocks?.[1]?.elements?.[0]?.action_id === "status:ask")
    .args.blocks[1].elements[0];
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
        state: { values: { approver: { "status:approver": { selected_user: approver } }, message: { value: { rich_text_value: { type: "rich_text", elements: message ?? form.blocks[1].element.initial_value.elements } } } } },
      },
    }),
    {},
    environment,
  );
  return calls;
}

test("the Ask for approval form starts with the task's PRs in its message, which can be taken out like the rest", async (t) => {
  const task = withStatus("IN_TESTING");
  task.task.prs = [PR];
  let calls = await clientReview(t, { stored: [task] }, { approver: "UCLIENT" });
  const form = calls.find((call) => call.method === "views.open").args.view;
  // The PRs are a link in the box, and come back as one.
  assert.equal(fromRichTextOf(form.blocks[1].element.initial_value), `Could you take a look and approve it, or let us know what needs to change?\n*PRs:* <${PR}|cade/42>`);
  assert.equal(
    calls.find((call) => call.method === "chat.postMessage").args.text,
    `<@UACTOR> sent:\n<@UCLIENT>, could you take a look and approve it, or let us know what needs to change?\n*PRs:* <${PR}|cade/42>`,
  );
  // Taken out, they aren't posted.
  calls = await clientReview(t, { stored: [task] }, { approver: "UCLIENT", message: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "UCLIENT" }, { type: "text", text: ", please approve." }] }] });
  assert.equal(calls.find((call) => call.method === "chat.postMessage").args.text, "<@UACTOR> sent:\n<@UCLIENT>, please approve.");
});

test("the Ask for approval form shows the request, to change before it's sent, following who is chosen until it's changed", async (t) => {
  const calls = await clientReview(t, { stored: [storedTask()] }, {
    approver: "UCLIENT",
    message: [{ type: "rich_text_section", elements: [{ type: "text", text: "Hi, the new login is on staging. Could you approve it by Friday?" }] }],
  });
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.deepEqual(form.blocks.map((block) => block.block_id), ["approver", "message", undefined]);
  assert.equal(form.blocks[0].element.action_id, "status:approver");
  assert.equal(form.blocks[0].dispatch_action, true);
  assert.equal(fromRichTextOf(form.blocks[1].element.initial_value), "Could you take a look and approve it, or let us know what needs to change?");
  // Their words are posted, the approver mentioned first, as they don't name them.
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.text, "<@UACTOR> sent:\n<@UCLIENT> Hi, the new login is on staging. Could you approve it by Friday?");
  assert.equal(JSON.parse(post.blocks[1].elements[0].value).approver, "UCLIENT");

  // Choosing someone puts them in the request; once it's changed, it's left alone.
  const pick = (text, block = "message") =>
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      view: { id: "V1", hash: "h1", callback_id: "status:review", private_metadata: form.private_metadata, state: { values: { approver: { "status:approver": { selected_user: "UCLEO" } }, [block]: { value: { rich_text_value: toRichTextOf(text) } } } } },
      actions: [{ action_id: "status:approver", block_id: "approver", selected_user: "UCLEO" }],
    });
  let picked = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  await send("/slack/interactions", pick("<@UCLIENT>, could you take a look and approve it, or let us know what needs to change?"));
  const update = picked.find((call) => call.method === "views.update").args;
  assert.deepEqual([update.view_id, update.hash], ["V1", "h1"]);
  assert.equal(update.view.blocks[0].element.initial_user, "UCLEO");
  // A new block_id, or Slack would keep what the box held.
  assert.equal(update.view.blocks[1].block_id, "message-UCLEO");
  assert.equal(fromRichTextOf(update.view.blocks[1].element.initial_value), "<@UCLEO>, could you take a look and approve it, or let us know what needs to change?");
  picked = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  await send("/slack/interactions", pick("Please approve by Friday", "message-UCLIENT"));
  assert.deepEqual(picked, []);
});

const reviewClick = (actionId) =>
  interaction({
    type: "block_actions",
    user: { id: "UCLIENT" },
    channel: { id: "CDEV" },
    message: { ts: "100.9", thread_ts: "100.1" },
    actions: [
      {
        action_id: actionId,
        value: JSON.stringify({
          channel: "CDEV",
          ts: "100.1",
          text: "<@UACTOR> says this is ready for you to review.",
        }),
      },
    ],
  });

test("an approval request sent through an AI agent keeps its footer once decided", async (t) => {
  const footer = { type: "context", block_id: "cade_agent_footer", elements: [{ type: "mrkdwn", text: "*Sent using* AI agent" }] };
  const click = JSON.parse(new URLSearchParams(reviewClick("status:approve")).get("payload")!);
  click.message.blocks = [{ type: "section" }, { type: "actions" }, footer];
  const calls = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  await send("/slack/interactions", interaction(click));
  const update = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.9").args;
  assert.equal(update.text, "<@UACTOR> says this is ready for you to review.\n<@UCLIENT> approved it.\nSent using AI agent");
  assert.deepEqual(update.blocks.at(-1), footer);
  assert.ok(!update.blocks.some((block) => block.type === "actions"), "the buttons are gone");
});

test("Approve moves the task to Done and tells the task's thread", async (t) => {
  const calls = mockSlack(t, {
    stored: [withStatus("CLIENT_REVIEW")],
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  const response = await send("/slack/interactions", reviewClick("status:approve"));
  assert.equal(response.status, 200);

  assert.deepEqual(calls.map((call) => [call.method, call.args.ts ?? call.args.thread_ts ?? call.args.timestamp]), [
    ["chat.update", "100.1"],
    ["chat.postMessage", "100.1"],
    ["chat.update", "100.9"],
  ]);
  assert.deepEqual((await savedTask()).status, "DONE");
  assert.ok((await savedTask()).completedAt);
  assert.equal(calls[1].args.text, "<@UCLIENT> approved this, so it's now :white_check_mark: Done.");
  assert.deepEqual(calls[2].args, {
    channel: "CDEV",
    ts: "100.9",
    text: "<@UACTOR> says this is ready for you to review.\n<@UCLIENT> approved it.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "<@UACTOR> says this is ready for you to review.\n<@UCLIENT> approved it.",
        },
      },
    ],
  });
});

test("Not approve moves the task back to In progress and tells the task's thread", async (t) => {
  const calls = mockSlack(t, {
    stored: [withStatus("CLIENT_REVIEW")],
    "chat.getPermalink": { permalink: "https://slack.example/review" },
  });
  await send("/slack/interactions", reviewClick("status:reject"));

  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  const note = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(note.thread_ts, "100.1");
  assert.equal(
    note.text,
    "<@UCLIENT> didn't approve this, so it's back to :arrow_forward: In progress. Have a look at the thread for what needs to change.",
  );
  assert.match(calls.at(-1).args.text, /\n<@UCLIENT> didn't approve it, so the team will pick it up again\.$/);
});

test("Approve and Not approve do nothing once the task has left Client review", async (t) => {
  for (const actionId of ["status:approve", "status:reject"]) {
    const calls = mockSlack(t, { stored: [withStatus("IN_TESTING")] });
    await send("/slack/interactions", reviewClick(actionId));
    assert.deepEqual(calls.map((call) => call.method), ["chat.update"], actionId);
    assert.match(calls[0].args.text, /\nI didn't change anything: the task has since moved to :test_tube: In testing\.$/);
  }
});

test("Approve on a deleted task says so", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/interactions", reviewClick("status:approve"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.update"]);
  assert.match(calls[0].args.text, /\nHmm, this task doesn't exist anymore\.$/);
});

test("setting the status it already has changes nothing, so asks no one", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  await send("/slack/events", threadEvent("<@UBOT> status client review"));
  assert.deepEqual(calls.map((call) => call.method), ["reactions.add"]);
});

test("only the chosen approver can approve or reject", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("CLIENT_REVIEW")] });
  const click = JSON.parse(new URLSearchParams(reviewClick("status:approve")).get("payload"));
  click.actions[0].value = JSON.stringify({ ...JSON.parse(click.actions[0].value), approver: "UPM" });
  await send("/slack/interactions", interaction(click));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  assert.equal(calls[0].args.user, "UCLIENT");
  assert.equal(calls[0].args.text, "Only <@UPM> can approve or reject this.");
  assert.equal((await savedTask()).status, "CLIENT_REVIEW");
});

// A stored task at `ts`, with `fields` changed.
const historyTask = (ts, { owners = [], reviewers = [], testers = [], ...fields }) => {
  const record = storedTask({ owners, reviewers, testers });
  record.ts = ts;
  Object.assign(record.task, fields);
  return record;
};

// An incident's task at `ts`, as historyTask.
const incidentHistoryTask = (ts, fields) => historyTask(ts, { priority: "Urgent", dueDate: "Immediate", incident: true, ...fields });

// A response_url's answer: like the API, it refuses a message whose blocks
// reuse an action_id, with an OK status and { ok: false }.
function respondAsSlack(body) {
  const reused = duplicateActionIds(body.blocks ?? []);
  return reused.length ? Response.json({ ok: false, error: "invalid_blocks" }) : new Response("ok");
}

// Slash command answers sent later go to RESPONSE_URL.
const RESPONSE_URL = "https://hooks.slack.com/commands/T1/1/abc";

// Runs `/cade <text>` from `channel` as UACTOR, with `stored` (each channel's
// task root messages) in the database, and returns its immediate answer, the
// calls made, and the answer sent later through the response_url.
async function tasksCommand(t: TestContext, text: string, channel: string, stored: Record<string, Stored[]> = {}, environment: AppEnv = env) {
  const calls = mockSlack(t, { ...slackUsers, "auth.test": { url: "https://acme.slack.com/" } });
  for (const [where, messages] of Object.entries(stored)) {
    for (const record of messages) await putTask(env, where, record.ts, record.task);
  }
  return { calls, ...(await runTasksCommand(text, channel, environment)) };
}

// Sends `/cade <text>` and returns its immediate answer and the one sent later.
async function runTasksCommand(text, channel, environment = env) {
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

const PR = "https://github.com/acme/cade/pull/42";
const MR = "https://gitlab.com/acme/web/web-app/-/merge_requests/118";
const PR3 = "https://github.com/acme/cade/pull/43";

test("@Cade pr add links pull requests, counted on one line of the card, and reacts ✅", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}/files> <${MR}|the MR> ${PR}`));

  // No reviewer yet, but it's To do, so nothing is asked: just the ✅.
  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "reactions.add"]);
  const blocks = allBlocks(calls[0].args);
  // Stored without the /files tab, and only once.
  assert.deepEqual((await savedTask()).prs, [PR, MR]);
  // No GITHUB_TOKEN, so the GitHub one is saved as open, and the other host's counts as open.
  assert.deepEqual((await savedTask()).prStates, { [PR]: "OPEN", [MR]: "OPEN" });
  // Counted in the work block, after the status, before the people.
  assert.equal(blocks.at(-2).type, "context");
  // Its count is in the first block; the work block is the status and people.
  assert.equal(blockText(allBlocks(calls[0].args).at(-3)), "Pull requests: 2 open  ·  0 merged");
  assert.deepEqual(workLines(calls[0].args), [":memo: To do  ·  Due 31/10/2026", "_Unassigned_"]);
  assert.match(footerLines(calls[0].args)[1], /^Tracked by/);
  assert.equal(calls[1].args.name, "white_check_mark");
});

test("tasks without pull requests show no PRs line", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));
  // The title, the work block (status and people) and who tracked it.
  assert.equal(allBlocks(calls[0].args).length, 3);
  assert.deepEqual(workLines(calls[0].args), [":arrow_forward: In progress  ·  Due 31/10/2026", "_Unassigned_"]);
  // Made in Slack, not through an AI agent.
  assert.match(footerLines(calls[0].args)[1], /^Tracked by <@\w+>$/);
});

test("@Cade pr add skips pull requests already linked", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  let calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}> <${MR}>`));
  assert.deepEqual((await savedTask()).prs, [PR, MR]);
  assert.equal(calls[1].args.name, "white_check_mark");

  calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.equal(calls[0].args.text, "Those pull requests are already linked to this task, so we're all set.");
});

test("@Cade pr remove unlinks pull requests", async (t) => {
  const root = storedTask();
  root.task.prs = [PR, MR];
  let calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).prs, [MR]);
  assert.equal(prsLineOf(calls[0].args), "Pull requests: 1 open  ·  0 merged");
  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "reactions.add"]);
  assert.equal(calls[1].args.name, "white_check_mark");

  // Removing the last one removes the PRs line.
  root.task.prs = [PR];
  calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).prs, []);
  assert.equal(allBlocks(calls[0].args).length, 3);

  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.equal(calls.at(-1).args.text, "Hmm, those pull requests aren't linked to this task.");
});

test("@Cade pr needs add or remove and a pull request link", async (t) => {
  for (const [text, reply] of [
    [`<@UBOT> pr <${PR}>`, "Try `@Cade pr add <link>` or `@Cade pr remove <link>`."],
    ["<@UBOT> pr", "Try `@Cade pr add <link>` or `@Cade pr remove <link>`."],
    ["<@UBOT> pr add", "Which pull request? Paste its link. Try `@Cade pr add <link>` or `@Cade pr remove <link>`."],
    [
      "<@UBOT> pr add <https://github.com/acme/cade/issues/3>",
      "Hmm, that doesn't look like a pull request link: https://github.com/acme/cade/issues/3",
    ],
  ] as const) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"], text);
    assert.equal(calls[0].args.text, reply, text);
  }
});

test("pull requests on GitHub, GitLab and Bitbucket are read as reponame/number", async () => {
  const { parsePullRequest } = await import("../src/tasks.ts");
  assert.deepEqual(parsePullRequest(`${PR}/files`), { url: PR, repo: "cade", number: "42" });
  assert.equal(parsePullRequest(MR).repo, "web-app");
  assert.deepEqual(parsePullRequest("https://bitbucket.org/acme/api/pull-requests/7"), {
    url: "https://bitbucket.org/acme/api/pull-requests/7",
    repo: "api",
    number: "7",
  });
  assert.equal(parsePullRequest("https://github.com/acme/cade/issues/3"), null);
});

test("linking a PR asks the task's reviewers to review it", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA", "UREX"], status: "IN_REVIEW" })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(drafts(calls), [`<@URIA>, <@UREX>, could you review this?`]);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"), "nothing posted, and no picker");
});

test("linking a PR reads where it stands on GitHub first: one merged already isn't put up for review", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" })] });
  const asked = mockGitHub({ 42: "MERGED" });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`), {}, { ...env, GITHUB_TOKEN: "ghp_test" });
  assert.equal(asked.length, 1);
  assert.deepEqual((await savedTask()).prStates, { [PR]: "MERGED" });
  assert.equal(blockText(allBlocks(calls[0]!.args).at(-3)), "Pull requests: 0 open  ·  1 merged");
  // No one asked to review it, and the thread isn't told it was merged: it was linked so.
  assert.deepEqual(drafts(calls), []);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));

  // Found merged by a later read, it isn't told either: it didn't change.
  calls.length = 0;
  mockGitHub({});
  const { syncPullRequests } = await import("../src/github.ts");
  await syncPullRequests({ ...env, GITHUB_TOKEN: "ghp_test" });
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("linking a PR when GitHub can't be reached saves it as open, read next by the sync, and its merge is told", async (t) => {
  const record = storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" });
  // Another task's, read just now: the one linked goes before it.
  const other = storedTask();
  other.ts = "100.2";
  other.task.prs = [PR3];
  other.task.prStates = { [PR3]: "OPEN" };
  const calls = mockSlack(t, { stored: [record, other] });
  const slack = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url) === "https://api.github.com/graphql" ? Promise.reject(new Error("timed out")) : slack(url, init));
  const withToken = { ...env, GITHUB_TOKEN: "ghp_test" };
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`), {}, withToken);
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.deepEqual((await savedTask()).prStates, { [PR]: "OPEN" });
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
  const { prsToSync } = await import("../src/db.ts");
  assert.deepEqual(await prsToSync(env, 1), [PR]);

  // Merged before the sync reads it: a change from open, so the thread is told.
  calls.length = 0;
  globalThis.fetch = slack;
  mockGitHub({ 42: "MERGED", 43: "OPEN" });
  const { syncPullRequests } = await import("../src/github.ts");
  await syncPullRequests(withToken);
  const posts = calls.filter((call) => call.method === "chat.postMessage");
  assert.deepEqual(posts.map((call) => call.args.text), [`<${PR}|cade/42> was merged on GitHub.`]);
});

test("linking a PR before In review asks no reviewer yet, and moving to In review asks them", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA", "UREX"], status: "IN_PROGRESS" })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.equal(calls[1].args.name, "white_check_mark");
  assert.deepEqual(drafts(calls), [], "nobody is asked while it is In progress");

  // Reaching In review asks the reviewers assigned earlier, about what is pending.
  const moved = mockSlack(t, { stored: [{ ...storedTask({ reviewers: ["URIA", "UREX"], status: "IN_PROGRESS" }), task: { ...storedTask({ reviewers: ["URIA", "UREX"], status: "IN_PROGRESS" }).task, prs: [PR] } }] });
  await send("/slack/events", threadEvent("<@UBOT> status in review"));
  assert.deepEqual(drafts(moved), ["<@URIA>, <@UREX>, could you review this?"]);
});

test("@Cade pr add with no reviewer asks whoever sent it, privately, to assign one, only while In review: no picker", async (t) => {
  for (const [status, asked] of [["IN_REVIEW", true], ["IN_PROGRESS", false]] as const) {
    const calls = mockSlack(t, { stored: [withStatus(status)] });
    await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
    assert.ok(calls.some((call) => call.method === "reactions.add" && call.args.name === "white_check_mark"), status);
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"), status);
    assert.deepEqual(calls.filter((call) => call.method === "chat.postEphemeral").map((call) => [call.args.user, call.args.text]), asked ? [["UACTOR", "No one is reviewing this yet. Add a reviewer with Edit…, so they're asked."]] : [], status);
  }
});

test("choosing reviewers assigns them in a new reply, and offers to ask them to review", async (t) => {
  const root = storedTask({ status: "IN_REVIEW" });
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: {
        ts: "100.8",
        thread_ts: "100.1",
        text: `<@UACTOR> linked <${PR}|cade/42>.\nThere's no reviewer yet. Who should review it?`,
      },
      actions: [{ action_id: "pr:reviewers", block_id: JSON.stringify([PR]), selected_users: ["URIA"] }],
    }),
  );
  assert.deepEqual(calls.map((call) => [call.method, call.args.ts]), [
    ["chat.update", "100.1"],
    ["chat.update", "100.8"],
    ["chat.postMessage", undefined],
    ["chat.postEphemeral", undefined],
  ]);
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
  // The picker keeps what came before its question.
  assert.equal(calls[1].args.text, `<@UACTOR> linked <${PR}|cade/42>.`);
  assert.equal(calls[1].args.blocks.length, 1, "the picker is gone");
  // A new reply, since an edited message notifies no one.
  assert.deepEqual(calls[2].args, {
    channel: "CDEV",
    thread_ts: "100.1",
    text: `<@UCLICKER> assigned <@URIA> as reviewer.`,
  });
  assert.equal(calls[3].args.user, "UCLICKER");
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
});

test("choosing reviewers on a picker with nothing before its question removes it", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: { ts: "100.8", thread_ts: "100.1", text: "There's no reviewer yet. Who should review it?" },
      actions: [{ action_id: "pr:reviewers", block_id: JSON.stringify([PR]), selected_users: ["URIA"] }],
    }),
  );
  assert.deepEqual(calls.slice(1).map((call) => [call.method, call.args.ts]), [
    ["chat.delete", "100.8"],
    ["chat.postMessage", undefined],
  ]);
});

test("assigning a reviewer once a PR is linked asks them to review it", async (t) => {
  const root = storedTask({ status: "IN_REVIEW" });
  root.task.prs = [PR, MR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA>"));
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
});

test("reviewers added before a PR are recorded, and asked nothing yet", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign reviewer <@URIA> <@UREX>"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "reactions.add"]);
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

// A plain (non-command) reply in the task's thread, as UACTOR.
const threadReply = (text, overrides = {}) => threadEvent(text, overrides);

// Clicks a button on Cade's private "link these PRs?" question.
const suggestionClick = (actionId, urls) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.1", urls }) }],
  });

// Records what is sent to RESPONSE_URL. Install it after mockSlack, so it
// sees those requests first.
function recordResponses(t) {
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

test("pull requests pasted into a task's thread are auto-linked, with no one asked yet, and whoever pasted them is told privately, with OK and Unlink", async (t) => {
  const root = storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" });
  root.task.prs = [MR];
  const calls = mockSlack(t, { stored: [root], "chat.postMessage": { channel: "CDEV", ts: "300.1" } });
  await send("/slack/events", threadReply(`Fixed in <${PR}> and <${MR}>, see <https://example.com/doc>`));

  // Only the PR that isn't linked yet. The thread hears only that it was auto-linked: the reviewers
  // aren't asked here, even In review.
  assert.deepEqual((await savedTask()).prs, [MR, PR]);
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args);
  assert.deepEqual(posts.map((post) => [post.thread_ts, post.text]), [["100.1", `Auto-linked <${PR}|cade/42>.`]]);
  // The note is the only private message; with nothing else to suggest, it carries no changes.
  const notes = calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args);
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].user, notes[0].thread_ts], ["UACTOR", "100.1"]);
  assert.equal(notes[0].text, `I linked <${PR}|cade/42> to this task from your message.`);
  const [ok, unlink] = notes[0].blocks[1].elements;
  assert.deepEqual([ok.text.text, unlink.text.text], ["OK", "Unlink"]);
  // The Auto-linked message rides along, for Unlink to take back.
  assert.deepEqual(JSON.parse(unlink.value), { channel: "CDEV", ts: "100.1", urls: [PR], posted: "300.1", told: [] });
});

test("OK on a note with nothing to suggest asks for review as linking would: the reviewers while In review, not those mentioned; with none, whoever pasted it privately", async (t) => {
  const ok = (value) =>
    interaction({ type: "block_actions", user: { id: "UACTOR" }, channel: { id: "CDEV" }, container: { is_ephemeral: true }, response_url: RESPONSE_URL, actions: [{ action_id: "pr:linked-ok", value: JSON.stringify(value) }] });
  const linked = (record) => {
    record.task.prs = [PR];
    return record;
  };
  // `asked`: the draft offered to whoever pasted it (see drafts); `privately`: the other private messages.
  for (const [label, record, told, asked, privately] of [
    ["reviewers, In review", linked(storedTask({ reviewers: ["URIA", "UREX"], status: "IN_REVIEW" })), ["UREX"], ["<@URIA>, could you review this?"], []],
    ["all mentioned", linked(storedTask({ reviewers: ["UREX"], status: "IN_REVIEW" })), ["UREX"], [], []],
    ["no reviewer, In review", linked(storedTask({ status: "IN_REVIEW" })), [], [], ["No one is reviewing this yet. Add a reviewer with Edit…, so they're asked."]],
    ["reviewers, In progress", linked(storedTask({ reviewers: ["URIA"], status: "IN_PROGRESS" })), [], [], []],
  ] as const) {
    const calls = mockSlack(t, { stored: [record] });
    const sent = recordResponses(t);
    await send("/slack/interactions", ok({ channel: "CDEV", ts: "100.1", urls: [PR], told }));
    assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }], label);
    assert.deepEqual(calls.filter((call) => call.method === "chat.postMessage"), [], label);
    assert.deepEqual(drafts(calls), asked, label);
    assert.deepEqual(calls.filter((call) => call.method === "chat.postEphemeral" && !drafts([call]).length).map((call) => call.args.text), privately, label);
  }
  // Unlink asks no one, and takes the Auto-linked message back rather than posting another.
  const calls = mockSlack(t, { stored: [linked(storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" }))] });
  recordResponses(t);
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UACTOR" }, channel: { id: "CDEV" }, container: { is_ephemeral: true }, response_url: RESPONSE_URL, actions: [{ action_id: "pr:linked-unlink", value: JSON.stringify({ channel: "CDEV", ts: "100.1", urls: [PR], posted: "300.1", told: [] }) }] }));
  assert.deepEqual((await savedTask()).prs, []);
  assert.deepEqual(calls.filter((call) => call.method === "chat.postMessage"), []);
  assert.deepEqual(calls.filter((call) => call.method === "chat.delete").map((call) => call.args), [{ channel: "CDEV", ts: "300.1" }]);
  assert.deepEqual(drafts(calls), []);
});

test("Unlink on a note from before the Auto-linked message was kept tells the thread who unlinked it", async (t) => {
  const record = storedTask();
  record.task.prs = [PR];
  const calls = mockSlack(t, { stored: [record] });
  recordResponses(t);
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UACTOR" }, channel: { id: "CDEV" }, container: { is_ephemeral: true }, response_url: RESPONSE_URL, actions: [{ action_id: "pr:linked-unlink", value: JSON.stringify({ channel: "CDEV", ts: "100.1", urls: [PR], told: [] }) }] }));
  assert.deepEqual((await savedTask()).prs, []);
  assert.deepEqual(calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.text), [`<@UACTOR> unlinked <${PR}|cade/42>.`]);
  assert.ok(!calls.some((call) => call.method === "chat.delete"));
});

test("an auto-linked PR asks no one, whatever the status and people: what the message means is suggested once the note is clicked", async (t) => {
  for (const record of [storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" }), storedTask({ status: "IN_REVIEW" }), storedTask({ reviewers: ["URIA"], status: "IN_PROGRESS" })]) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadReply(`PR: <${PR}>`));
    assert.deepEqual(calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.text), [`Auto-linked <${PR}|cade/42>.`], record.task.status);
    assert.deepEqual(calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args.text), [`I linked <${PR}|cade/42> to this task from your message.`], record.task.status);
  }
});

test("OK or Unlink on the note turns it into the suggestion, or removes it with none; Unlink also takes the open ones off, and the Auto-linked message names only those left", async (t) => {
  const changes = { people: { reviewer: { add: ["UREX"], remove: [] } } };
  const click = (action_id, value) =>
    interaction({ type: "block_actions", user: { id: "UACTOR" }, channel: { id: "CDEV" }, container: { is_ephemeral: true }, response_url: RESPONSE_URL, actions: [{ action_id, value }] });
  const stored = () => {
    const root = storedTask();
    root.task.prs = [MR, PR, PR3];
    // One merged since stays, as in the Pull requests form.
    root.task.prStates = { [PR3]: "MERGED" };
    return root;
  };

  // Unlink, with a suggestion: the note becomes it, and the open one is unlinked.
  let calls = mockSlack(t, { stored: [stored()] });
  let sent = recordResponses(t);
  await send("/slack/interactions", click("pr:linked-unlink", JSON.stringify({ channel: "CDEV", ts: "100.1", urls: [PR, PR3], posted: "300.1", changes, from: "TODO", told: ["UREX"] })));
  assert.deepEqual((await savedTask()).prs, [MR, PR3]);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage" || call.method === "chat.delete"));
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.update" && call.args.ts === "300.1").map((call) => call.args.text),
    [`Auto-linked <${PR3}|cade/43>.`],
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].replace_original, true);
  assert.equal(sent[0].text, "Should I update the task? From your message:");
  assert.deepEqual(JSON.parse(suggestionButtons(sent[0])[0].value), { channel: "CDEV", ts: "100.1", changes, from: "TODO", told: ["UREX"] });

  // OK, with a suggestion: the same, and nothing is unlinked.
  calls = mockSlack(t, { stored: [stored()] });
  sent = recordResponses(t);
  await send("/slack/interactions", click("pr:linked-ok", JSON.stringify({ channel: "CDEV", ts: "100.1", urls: [PR], changes, from: "TODO", told: [] })));
  assert.deepEqual((await savedTask()).prs, [MR, PR, PR3]);
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.equal(sent[0].text, "Should I update the task? From your message:");

  // OK with nothing to suggest: the note goes.
  mockSlack(t, { stored: [stored()] });
  sent = recordResponses(t);
  await send("/slack/interactions", click("pr:linked-ok", JSON.stringify({ channel: "CDEV", ts: "100.1", urls: [PR] })));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("a PR pasted with a mention is linked, and the person is suggested as reviewer once the note is clicked", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply(`<@UREX> <@UBOT> can you look at <${PR}>?`));
  assert.deepEqual((await savedTask()).prs, [PR]);
  // Only the note now; the suggestion waits in its buttons. Cade isn't someone to add, and the PR is linked already.
  assert.deepEqual(calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args.text), [`I linked <${PR}|cade/42> to this task from your message.`]);
  assert.deepEqual(noteValue(calls), { channel: "CDEV", ts: "100.1", urls: [PR], changes: { people: { reviewer: { add: ["UREX"], remove: [] } } }, from: "TODO", told: ["UREX"] });
});

test("a pasted pull request isn't linked with pr-links off, on a task that's Done, or for someone who turned suggestions off", async (t) => {
  const { setSuggestions } = await import("../src/db.ts");
  for (const [record, overrides, environment] of [
    [storedTask(), {}, { ...env, TASK_CHANGE_DETECTION: JSON.stringify(["hand-offs"]) }],
    [withStatus("DONE"), {}, env],
    [storedTask(), { user: "UQUIET" }, env],
  ] as const) {
    const calls = mockSlack(t, { stored: [record] });
    await setSuggestions(env, "UQUIET", false);
    await send("/slack/events", threadReply(`PR is up: <${PR}>`, overrides), {}, environment);
    assert.deepEqual((await savedTask()).prs, [], JSON.stringify(overrides));
    assert.deepEqual(calls, [], JSON.stringify(overrides));
  }
});

test("a question posted with the old reviewer picker is still answered", async (t) => {
  const linking = mockSlack(t, { stored: [storedTask({ status: "IN_REVIEW" })] });
  const sent = recordResponses(t);
  const click = JSON.parse(new URLSearchParams(suggestionClick("pr:suggest-link", [PR])).get("payload"));
  click.actions[0].value = JSON.stringify({ channel: "CDEV", ts: "100.1", mentioned: ["UREX"], urls: [PR], reviewers: ["UREX"] });
  click.state = { values: { "pr:suggest-reviewers": { "pr:suggest-reviewers": { selected_users: ["UREX", "UMIA"] } } } };
  await send("/slack/interactions", interaction(click));
  const saved = await savedTask();
  assert.deepEqual(saved.prs, [PR]);
  assert.deepEqual(saved.people.reviewer, ["UREX", "UMIA"]);
  // UREX was mentioned in the message, so only UMIA is asked.
  assert.deepEqual(drafts(linking), [`<@UMIA>, could you review this?`]);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("/cade retry asks again about a message in a task's thread, from its link", async (t) => {
  const ts = "1700000001.000500";
  const reply = { ts, thread_ts: "100.1", user: "UREX", text: `<@UMIA> please look at <${PR}>` };
  const calls = mockSlack(t, {
    stored: [storedTask({ reviewers: ["UMIA"] })],
    "conversations.replies": { messages: [reply] },
    "auth.test": { user_id: "UBOT" },
  });
  const { later } = await runTasksCommand(`retry ${messageLink("CDEV", ts, "?thread_ts=100.1&cid=CDEV")}`, "CDEV");

  assert.deepEqual(calls.slice(0, 2).map((call) => call.method), ["conversations.replies", "auth.test"]);
  assert.equal(calls[0].args.ts, ts);
  // The link is linked, from whoever wrote the message, who gets the note, as they would have.
  assert.deepEqual((await savedTask()).prs, [PR]);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.1");
  assert.equal(post.text, `Auto-linked <${PR}|cade/42>.`);
  assert.equal(linkedNote(calls).user, "UREX");
  assert.match(later.text, /<@UREX> will see a private question/);
});

test("/cade retry says when the link is missing, not in a thread, or not found", async (t) => {
  mockSlack(t);
  assert.match((await runTasksCommand("retry", "CDEV")).now, /Paste the link to the message/);

  mockSlack(t, {
    "conversations.replies": { messages: [{ ts: "1700000000.000100", user: "UREX", text: "a task" }] },
    "auth.test": { user_id: "UBOT" },
  });
  assert.match((await runTasksCommand(`retry ${messageLink("CDEV", "1700000000.000100")}`, "CDEV")).later.text, /not in a thread/);

  mockSlack(t, { "conversations.replies": { messages: [] } });
  assert.match((await runTasksCommand(`retry ${messageLink("CDEV", "1700000009.000900")}`, "CDEV")).later.text, /couldn't find that message/);
});

test("a PR in a reply also sent to the channel is linked like any reply", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["UMIA"] })] });
  await send("/slack/events", threadReply(`<@UMIA> can you review <${PR}>?`, { subtype: "thread_broadcast" }));
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.equal(calls.find((call) => call.method === "chat.postMessage").args.text, `Auto-linked <${PR}|cade/42>.`);
});

test("Edit saves the status chosen over the one a PR suggestion moved the task to", async (t) => {
  const task = storedTask({ reviewers: ["UMIA"] });
  task.task.status = "IN_PROGRESS";
  mockSlack(t, { stored: [task] });
  // The form began on In review, as linking the PR moves the task there; the
  // person put In progress back.
  const saveWith = (status) =>
    send(
      "/slack/interactions",
      interaction({
        type: "view_submission",
        user: { id: "UACTOR" },
        view: {
          callback_id: "task:edit",
          private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", details: false, opened: "IN_PROGRESS", shown: "IN_REVIEW" }),
          state: {
            values: {
              owner: { value: { selected_users: [] } },
              reviewer: { value: { selected_users: ["UMIA"] } },
              tester: { value: { selected_users: [] } },
              status: { value: { selected_option: { value: status } } },
              prs: { value: { value: PR } },
            },
          },
        },
      }),
    );
  await saveWith("IN_PROGRESS");
  const saved = await savedTask();
  assert.deepEqual([saved.status, saved.prs], ["IN_PROGRESS", []]);
});

test("messages without unlinked pull requests are left alone", async (t) => {
  const linked = storedTask();
  linked.task.prs = [PR];
  for (const [text, overrides, root] of [
    ["Looks good, no links here", {}, storedTask()],
    [`Already linked <${PR}>`, {}, linked],
    // Not in a team channel, or not a task's thread. (Messages not in a
    // thread are asked whether to track them instead.)
    [`See <${PR}>`, { channel: "COTHER" }, storedTask()],
    [`See <${PR}>`, {}, null],
    // Cade's own messages and edits.
    [`See <${PR}>`, { bot_id: "BCADE" }, storedTask()],
    [`See <${PR}>`, { subtype: "message_changed" }, storedTask()],
  ] as const) {
    const calls = mockSlack(t, { stored: root ? [root] : [] });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${JSON.stringify(overrides)}`);
  }
});

test("@Cade pr add is a command, not a suggestion", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("Link PRs links them, offers only what is new and removes the question", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" })] });
  const sent = recordResponses(t);
  const response = await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.equal(response.status, 200);

  assert.deepEqual(calls.map((call) => call.method), ["chat.update", "chat.postEphemeral"]);
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.equal(calls[1].args.thread_ts, "100.1");
  // No "linked" line: whoever clicked posted the link. They're offered only to ask the reviewer the
  // message didn't mention.
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Link on an older PR question, on a task with no reviewer, asks no one before In review", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("Link PRs after someone else linked them just removes the question", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  const sent = recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.deepEqual(calls.map((call) => call.method), []);
  assert.equal(sent.length, 1);
});

test("Not now just removes the question", async (t) => {
  const calls = mockSlack(t);
  const sent = recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-skip", [PR]));
  assert.equal(calls.length, 0);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

// `mentioned` is who the pasted message mentioned.
const suggestionValue = (fields) =>
  JSON.stringify({ channel: "CDEV", ts: "100.1", mentioned: [], urls: [], reviewers: [], ...fields });

const clickSuggestion = (value) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: "pr:suggest-link", value }],
  });

test("a pasted PR that mentions people proposes them as reviewers too", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  // URIA is already a reviewer and Cade is not a person to add.
  await send("/slack/events", threadReply(`<@UREX> <@URIA> <@UBOT> can you look at <${PR}>?`));
  assert.deepEqual(noteValue(calls).changes, { people: { reviewer: { add: ["UREX"], remove: [] } } });
});

test("an already linked PR is left alone, even when it mentions new people", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadReply(`<@UREX> <@URIA> please look at <${PR}>`));
  assert.deepEqual(calls, []);
});

test("mentions without a PR link are not offered as reviewers", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("<@UREX> can you help with this?"));
  assert.equal(calls.length, 0);
});

test("Link and add reviewer asks only the reviewers the message did not mention", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" })] });
  const sent = recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ mentioned: ["UREX"], urls: [PR], reviewers: ["UREX"] })));

  assert.deepEqual((await savedTask()).people.reviewer, ["URIA", "UREX"]);
  assert.deepEqual((await savedTask()).prs, [PR]);
  // UREX was mentioned in the message, so only URIA is asked.
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
  assert.equal(sent.length, 1);
});

test("Add reviewers on an already linked PR adds them and posts nothing", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  const sent = recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ mentioned: ["UREX"], reviewers: ["UREX"] })));

  assert.deepEqual((await savedTask()).people.reviewer, ["UREX"]);
  // The message already asked UREX; the card shows them as reviewer.
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.equal(sent.length, 1);
});

test("Just link leaves the mentioned people out", async (t) => {
  mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  recordResponses(t);
  await send("/slack/interactions", clickSuggestion(suggestionValue({ urls: [PR] })));
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
});

test("linking a PR leaves the status to the suggestions", async (t) => {
  for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "IN_TESTING", "CLIENT_REVIEW", "DONE"]) {
    const calls = mockSlack(t, { stored: [withStatus(status)] });
    await send("/slack/events", threadEvent(`<@UBOT> pr add <${PR}>`));
    assert.deepEqual((await savedTask()).status, status, status);
    assert.ok(!calls.some((call) => call.args.text?.includes("moved the task")), status);
  }
});

test("removing a PR leaves the status alone", async (t) => {
  const root = withStatus("IN_REVIEW");
  root.task.prs = [PR];
  mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent(`<@UBOT> pr remove <${PR}>`));
  assert.deepEqual((await savedTask()).status, "IN_REVIEW");
});

const assignValue = (role, people, moveTo = null) => JSON.stringify({ channel: "CDEV", ts: "100.1", role, people, moveTo });

const clickAssign = (actionId, value) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value }],
  });

test("a message with a PR link and a hand-off links the PR, and the note carries the hand-off to suggest", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply(`<@UREX> please review <${PR}>`));
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.deepEqual(calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args.text), [`I linked <${PR}|cade/42> to this task from your message.`]);
  assert.deepEqual(noteValue(calls).changes, { people: { reviewer: { add: ["UREX"], remove: [] } } });
});

test("a message an app posted for the person, such as an AI agent's Slack tool, gets no suggestion", async (t) => {
  // As Slack sends one posted with Claude's Slack connector: the person's, with the app's ID and a
  // "Sent using" footer. A plain message from the same person still gets its question.
  const footer = { type: "context", block_id: "mcp_attribution_footer", elements: [{ type: "mrkdwn", text: "*Sent using* Claude" }] };
  for (const [marks, asked] of [
    [{ app_id: "A08SF47R6P4", blocks: [{ type: "rich_text" }, footer] }, false],
    [{ app_id: "A08SF47R6P4" }, false],
    [{ blocks: [{ type: "rich_text" }, footer] }, false],
    [{ client_msg_id: "c42b0a0a", blocks: [{ type: "rich_text" }] }, true],
  ] as const) {
    const calls = mockSlack(t, { stored: [storedTask()] });
    await send("/slack/events", threadReply(`<@UREX> please review <${PR}>`, marks));
    assert.equal(calls.some((call) => call.method === "chat.postEphemeral"), asked, JSON.stringify(marks));
  }

  // Commands sent that way still work.
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("<@UBOT> priority high", { app_id: "A08SF47R6P4" }));
  assert.ok(calls.some((call) => call.method === "reactions.add"));
});

test("Just link works like the other link button", async (t) => {
  mockSlack(t, { stored: [storedTask({ reviewers: ["URIA"] })] });
  recordResponses(t);
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      channel: { id: "CDEV" },
      container: { is_ephemeral: true },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "pr:suggest-link-only", value: suggestionValue({ urls: [PR] }) }],
    }),
  );
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.deepEqual((await savedTask()).people.reviewer, ["URIA"]);
});

test("@Cade assign tester never changes the status", async (t) => {
  mockSlack(t, { stored: [withStatus("IN_PROGRESS")] });
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UTESS>"));
  assert.deepEqual((await savedTask()).status, "IN_PROGRESS");
  assert.deepEqual((await savedTask()).people.tester, ["UTESS"]);
});

test("a task started before the click is not moved again", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("owner", ["UREX"], "IN_PROGRESS")));
  assert.deepEqual((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("@Cade assign owner never changes the status", async (t) => {
  mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UREX>"));
  assert.deepEqual((await savedTask()).status, "TODO");
});

test("saying you've started asks nothing when there's nothing to change, or it isn't a task thread", async (t) => {
  for (const [text, root, overrides] of [
    // A owner on a task that's under way.
    ["started working on this", (() => {
      const root = withStatus("IN_PROGRESS");
      root.task.people.owner = ["UACTOR"];
      return root;
    })(), {}],
    // Anyone, on a task that's Done.
    ["picking this up", withStatus("DONE"), {}],
    // Not about the task, or not a task thread.
    ["can you comment on it?", storedTask(), {}],
    ["started working on this", null, {}],
    ["started working on this", storedTask(), { channel: "COTHER" }],
  ] as const) {
    const calls = mockSlack(t, { stored: root ? [root] : [] });
    await send("/slack/events", threadReply(text, overrides));
    assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"), `${text} ${overrides.channel ?? ""}`);
  }
});

test("Link on an older PR question, on a task In review with no reviewer, asks whoever clicked privately to assign one", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", suggestionClick("pr:suggest-link", [PR]));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(calls.filter((call) => call.method === "chat.postEphemeral").map((call) => call.args.text), ["No one is reviewing this yet. Add a reviewer with Edit…, so they're asked."]);
});

test("other typed statuses get only the ✅", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("TODO")] });
  await send("/slack/events", threadEvent("<@UBOT> status in review"));
  assert.equal(calls.at(-1).method, "reactions.add");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("Client review lists the task's PRs for the client, and keeps them after a decision", async (t) => {
  const task = withStatus("IN_TESTING");
  task.task.prs = [PR, MR];
  const calls = await clientReview(t, {
    stored: [task],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });

  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.text?.startsWith("<@UACTOR> sent:")).args;
  // Led by who sent it, as any message sent for someone is.
  const announced = [
    "<@UACTOR> sent:",
    "<@UCREATOR>, could you take a look and approve it, or let us know what needs to change?",
    `*PRs:* <${PR}|cade/42>, <${MR}|web-app/118>`,
  ].join("\n");
  assert.equal(review.blocks[0].text.text, announced);
  assert.deepEqual(
    review.blocks[1].elements.map((button) => button.action_id),
    ["status:approve", "status:reject"],
  );
  // The buttons carry the request and the PRs, so they stay when the buttons are replaced.
  assert.equal(JSON.parse(review.blocks[1].elements[0].value).text, announced);
});

test("Client review on a task with no PRs shows no PRs line", async (t) => {
  const calls = await clientReview(t, {
    stored: [withStatus("IN_TESTING")],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.text?.startsWith("<@UACTOR> sent:")).args;
  assert.ok(!review.blocks[0].text.text.includes("*PRs:*"));
});

test("a task whose deletion failed after it was marked deleted can be removed again", async (t) => {
  const ts = "1700000000.000100";
  const calls = mockSlack(t, {
    stored: [{ ...withStatus("TODO"), ts }],
    "conversations.replies": (args) => ({ messages: [{ ts: args.ts, bot_id: "BCADE" }] }),
  });
  await seeded;
  await markTaskDeleted(env, "CDEV", ts);
  const ask = (await runTasksCommand(`remove <${messageLink("CDEV", ts)}>`, "CDEV")).later;
  assert.match(ask.text, /should I delete the task \*Fix login\*\?/);

  await answerPrivately(t, ask, "delete:confirm");
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts),
    [ts],
  );
});

test("a failed task deletion leaves the task to be tried again", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }] },
  });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    url.endsWith("/chat.delete") ? Response.json({ ok: false, error: "ratelimited" }) : fetch(url, init);
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR")).catch(() => {});
  assert.ok(calls.some((call) => call.method === "conversations.replies"));
  assert.ok(await savedTask());
});

test("the ready to review message doesn't link to the team's task", async (t) => {
  const calls = await clientReview(t, {
    stored: [withStatus("IN_TESTING")],
    "chat.getPermalink": { permalink: "https://slack.example/p100" },
  });
  const review = calls.find((call) => call.method === "chat.postMessage" && call.args.text?.startsWith("<@UACTOR> sent:")).args;
  assert.equal(
    review.text,
    "<@UACTOR> sent:\n<@UCREATOR>, could you take a look and approve it, or let us know what needs to change?",
  );
  assert.ok(!review.text.includes("slack.example/p100"));
  // No link to look up for it.
  assert.ok(!calls.some((call) => call.method === "chat.getPermalink" && call.args.channel === "CDEV"));
});

test("assigning from the task's own thread still doesn't ask them again", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_REVIEW")] });
  recordResponses(t);
  await send("/slack/interactions", clickAssign("assign:suggest", assignValue("owner", ["UREX"])));
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
});

test("@Cade unassign of someone not assigned changes nothing", async (t) => {
  for (const [text, reply] of [
    ["<@UBOT> unassign <@UREX>", "Looks like they aren't assigned to this task."],
    ["<@UBOT> unassign tester <@UALICE>", "Looks like they aren't assigned to this task as tester."],
    ["<@UBOT> unassign <@UREX> <@UBOB>", "Looks like none of them are assigned to this task."],
  ] as const) {
    const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
    await send("/slack/events", threadEvent(text));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"], text);
    assert.equal(calls[0].args.text, reply);
  }
});

test("removed reviewers are told they no longer need to review", async (t) => {
  const root = storedTask({ reviewers: ["URIA"], status: "IN_REVIEW" });
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> unassign reviewer <@URIA>"));
  assert.deepEqual(drafts(calls), ["<@URIA>, there's no need to review this anymore."]);
});

test("assign-style words without a mention are left alone", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadReply("this was assigned to the wrong sprint, I assigned it to QA board"));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("PROJECTS can be a JSON string, as the Cloudflare dashboard stores it", async (t) => {
  const calls = mockSlack(t);
  const asJson = { ...env, PROJECTS: JSON.stringify(env.PROJECTS) };
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "COTHER" }), {}, asJson);
  assert.equal(calls[0].args.text, "That one works with `@Cade assign owner @person` in a task thread in <#CDEV> or <#CTESTDEV>.");

  const broken = mockSlack(t);
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"), {}, { ...env, PROJECTS: "[{" });
  assert.match(broken[0].args.text, /something went wrong/);
});

test("the Slack app manifest is filled in from the Worker's URL, name and command", async () => {
  const { buildManifest } = await import("../scripts/slack-app.ts");
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../slack/manifest.json", import.meta.url), "utf8"));
  const settings = { workerUrl: "https://cade.acme.workers.dev/", name: "Acme Cade", command: "/acme" };

  const manifest = buildManifest(template, settings);
  assert.equal(manifest._comment, undefined, "Slack doesn't accept extra keys");
  assert.equal(manifest.display_information.name, "Acme Cade");
  assert.equal(manifest.features.bot_user.display_name, "Acme Cade");
  const [command] = manifest.features.slash_commands;
  assert.equal(command.command, "/acme");
  // The trailing slash is dropped, so the paths are clean.
  assert.equal(command.url, "https://cade.acme.workers.dev/slack/commands");
  assert.equal(manifest.settings.interactivity.request_url, "https://cade.acme.workers.dev/slack/interactions");
  assert.equal(manifest.settings.event_subscriptions.request_url, "https://cade.acme.workers.dev/slack/events");
  assert.ok(!JSON.stringify(manifest).includes("{{"), "every placeholder is filled in");

  // Created first without Event Subscriptions, whose URL Slack checks before
  // the Worker has the signing secret.
  assert.equal(buildManifest(template, { ...settings, events: false }).settings.event_subscriptions, undefined);
  assert.ok(template.settings.event_subscriptions, "the template is left as it was");
});

test("the manifest asks for the scopes Cade uses", async () => {
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../slack/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(template.oauth_config.scopes.bot, [
    "canvases:write",
    "channels:history",
    "channels:join",
    "channels:manage",
    "channels:read",
    "chat:write",
    "commands",
    "groups:history",
    "groups:read",
    "groups:write",
    // 🎫 and 🔀 on a message convert or move it.
    "reactions:read",
    "reactions:write",
    "users:read",
    "users:read.email",
  ]);
  assert.deepEqual(template.settings.event_subscriptions.bot_events, [
    // Opening the Home tab draws the person's dashboard.
    "app_home_opened",
    "message.channels",
    "message.groups",
    "reaction_added",
  ]);
  assert.equal(template.features.app_home.home_tab_enabled, true);
});

test("opening the Home tab shows the person's open tasks by what they do on them, most urgent first", async (t) => {
  const task = (ts, title, priority, status, people, dueDate = "") => ({
    channel: "CDEV",
    ts,
    task: { ...storedTask().task, title, priority, status, dueDate, people: { owner: [], reviewer: [], tester: [], ...people } },
  });
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      task("1.1", "Low chore", "Low", "TODO", { owner: ["UME"] }),
      task("2.1", "Urgent fix", "Urgent", "IN_PROGRESS", { owner: ["UME"] }, "01/01/2020"),
      task("3.1", "Review me", "High", "IN_REVIEW", { reviewer: ["UME"] }),
      task("4.1", "Not yet testable", "High", "IN_PROGRESS", { tester: ["UME"] }),
      task("5.1", "Someone else's", "Urgent", "TODO", { owner: ["UOTHER"] }),
      task("6.1", "Finished", "Urgent", "DONE", { owner: ["UME"] }),
    ],
  });
  const body = JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UBOT" }],
    event: { type: "app_home_opened", user: "UME", tab: "home" },
  });
  assert.equal((await send("/slack/events", body)).status, 200);

  const [publish] = calls.filter((call) => call.method === "views.publish");
  assert.equal(publish.args.user_id, "UME");
  const text = publish.args.view.blocks.map((block) => blockText(block) ?? "").join("\n");
  // Each task's title links to its thread.
  assert.match(text, /\*<https:\/\/acme\.slack\.com\/archives\/CDEV\/p21\?thread_ts=2\.1&cid=CDEV\|Urgent fix>\*/);
  assert.deepEqual(duplicateActionIds(publish.args.view.blocks), []);
  assert.ok(text.indexOf("Urgent fix") < text.indexOf("Low chore"));
  assert.match(text, /Overdue/);
  assert.match(text, /\|Urgent fix>\*\n:red_circle: Urgent  ·  :arrow_forward: In progress/);
  assert.match(text, /Review me/);
  assert.match(text, /Coming up[^]*Not yet testable/);
  assert.doesNotMatch(text, /Someone else's|Finished/);
  const headers = publish.args.view.blocks.filter((block) => block.type === "header").map(blockText);
  assert.deepEqual(headers, ["Your tasks", ":hammer_and_wrench: To work on (2)", ":eyes: To review (1)", ":test_tube: To test (0)", ":outbox_tray: Worked on (0)"]);
  // No section ends with a gap before its divider, whatever its last line: To work on a card, To review
  // Coming up, To test and Worked on their empty line.
  const blocks = publish.args.view.blocks;
  const ends = blocks.filter((block, i) => block.type === "context" && blocks[i + 1]?.type === "divider");
  assert.equal(ends.length, 5);
  for (const block of ends) assert.doesNotMatch(blockText(block), /\u2800/);
  assert.match(text, /Worked on \(0\)\n_Nothing handed over yet\._/);
});

test("My Tasks lists what is before a role's turn as Coming up, and what is past it once, at the bottom, as Worked on", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      historyTask("1.1", { title: "Built it", owners: ["UME"], status: "IN_REVIEW" }),
      historyTask("2.1", { title: "Reviewed and built it", owners: ["UME"], reviewers: ["UME"], status: "IN_TESTING" }),
      historyTask("3.1", { title: "Review later", reviewers: ["UME"], status: "TODO" }),
      historyTask("3.5", { title: "Review now", reviewers: ["UME"], status: "IN_REVIEW" }),
      historyTask("4.1", { title: "Test later", testers: ["UME"], status: "IN_REVIEW" }),
      historyTask("5.1", { title: "Tested it", testers: ["UME"], status: "CLIENT_REVIEW" }),
    ],
  });
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:mine" }] }));
  const blocks = calls.find((call) => call.method === "views.publish").args.view.blocks;
  const text = blocks.map((block) => blockText(block) ?? "").join("\n");
  const section = (from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to) : undefined);
  // Nothing comes before working on a task, so To work on has no Coming up.
  assert.doesNotMatch(section("To work on", "To review"), /Coming up/);
  assert.match(section("To review", "To test"), /\*Coming up\*\n<[^|]+\|Review later>  ·  :memo: To do$/m);
  // A card keeps its gap before Coming up, though not before a divider.
  const comingUp = blocks.findIndex((block) => /^\*Coming up\*\n[^\n]*Review later/.test(blockText(block) ?? ""));
  assert.match(blockText(blocks[comingUp - 1]), /\n\u2800$/);
  assert.doesNotMatch(blockText(blocks[comingUp]), /\u2800/);
  assert.match(section("To test", "Worked on ("), /\*Coming up\*\n<[^|]+\|Test later>  ·  :eyes: In review$/m);
  // Each handed-over task once, in small type under a header like the others, with the roles it was theirs in.
  const header = blocks.findIndex((block) => block.type === "header" && blockText(block) === ":outbox_tray: Worked on (3)");
  assert.ok(header > 0);
  assert.equal(blocks[header + 1].type, "context");
  const lines = blockText(blocks[header + 1]).split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines.some((line) => /\|Built it>  ·  :eyes: In review  ·  _Owner_$/.test(line)));
  assert.ok(lines.some((line) => /\|Reviewed and built it>  ·  :test_tube: In testing  ·  _Owner, Reviewer_$/.test(line)));
  assert.ok(lines.some((line) => /\|Tested it>  ·  :raising_hand: Client review  ·  _Tester_$/.test(line)));
  assert.ok(text.indexOf("Worked on (") > text.indexOf("To test"));
});

test("By person shows a picked team member's tasks as My Tasks shows yours, and Refresh keeps the pick", async (t) => {
  const stored = [
    historyTask("1.1", { title: "Rex builds", owners: ["UREX"], status: "IN_PROGRESS" }),
    historyTask("2.1", { title: "Rex reviews", owners: ["UME"], reviewers: ["UREX"], status: "IN_REVIEW" }),
    historyTask("3.1", { title: "Rex handed over", owners: ["UREX"], status: "IN_TESTING" }),
    historyTask("4.1", { title: "Not Rex's", owners: ["UOTHER"] }),
  ];
  const draw = async (action) => {
    const calls = mockSlack(t, {
      "auth.test": { url: "https://acme.slack.com/", user_id: "UBOT" },
      "conversations.members": { members: ["UREX", "UBOT", "UME", "UBOB"] },
      "users.info": ({ user }) => ({ user: { profile: { display_name: { UREX: "Rex", UME: "Me", UBOB: "Bob" }[user] } } }),
      stored,
    });
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [action] }));
    const { blocks } = calls.find((call) => call.method === "views.publish").args.view;
    assert.deepEqual(duplicateActionIds(blocks), []);
    return blocks;
  };
  const text = (blocks) => blocks.map((block) => blockText(block) ?? "").join("\n");
  const picker = (blocks) => blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === "home:person");

  // No one picked yet: the project channel's people by name, without Cade, and a line asking for one.
  const empty = await draw({ action_id: "home:tab:person" });
  assert.deepEqual(picker(empty).options.map((option) => [option.text.text, option.value]), [["Bob", "UBOB"], ["Me", "UME"], ["Rex", "UREX"]]);
  assert.equal(picker(empty).initial_option, undefined);
  assert.match(text(empty), /Pick a team member to see their tasks/);
  assert.doesNotMatch(text(empty), /Rex builds/);

  // Picking Rex shows Rex's tasks, in the sections My Tasks has, and says whose.
  const rex = await draw({ action_id: "home:person", selected_option: { value: "UREX" } });
  assert.equal(picker(rex).initial_option.value, "UREX");
  const headers = rex.filter((block) => block.type === "header").map(blockText);
  assert.deepEqual(headers, ["Rex's tasks", ":hammer_and_wrench: To work on (1)", ":eyes: To review (1)", ":test_tube: To test (0)", ":outbox_tray: Worked on (1)"]);
  assert.match(text(rex), /\*2\* waiting on <@UREX>/);
  assert.match(text(rex), /\|Rex builds>/);
  // The people line still speaks to the viewer: their own part is "you".
  assert.match(text(rex), /\|Rex reviews>\*\n[^\n]+\nOwner you/);
  assert.doesNotMatch(text(rex), /Not Rex's/);

  // Refresh and the project picker draw the view again on Rex, as the view carries the pick.
  const refresh = rex[0].elements.find((element) => element.action_id === "home:refresh");
  assert.equal(refresh.value, "person:UREX");
  const again = await draw({ action_id: "home:refresh", value: refresh.value });
  assert.equal(picker(again).initial_option.value, "UREX");
  assert.match(text(again), /Rex builds/);
  // The pick isn't kept beyond the view: the tab opens without one.
  const reopened = await draw({ action_id: "home:tab:person" });
  assert.equal(picker(reopened).initial_option, undefined);
});

test("By person asks for a pick again when the one picked isn't in the project's channel, as after switching project", async (t) => {
  const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/", user_id: "UBOT" }, "conversations.members": { members: ["UME"] } });
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:refresh", value: "person:UGONE" }] }));
  const text = calls.find((call) => call.method === "views.publish").args.view.blocks.map((block) => blockText(block) ?? "").join("\n");
  assert.match(text, /Pick a team member/);
});

test("All Tasks splits tasks by status into Working on, In review, In testing and Delivered, by priority, with subtasks under their task", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      historyTask("1.1", { title: "Low todo", priority: "Low", status: "TODO" }),
      historyTask("2.1", { title: "Urgent doing", priority: "Urgent", status: "IN_PROGRESS" }),
      historyTask("3.1", { title: "Reviewing", status: "IN_REVIEW" }),
      subtaskOf("3.2", { title: "Low part", priority: "Low", status: "TODO", parent: { ts: "3.1", title: "Reviewing" } }),
      subtaskOf("3.3", { title: "Urgent part", priority: "Urgent", status: "IN_TESTING", parent: { ts: "3.1", title: "Reviewing" } }),
      historyTask("4.1", { title: "With client", status: "CLIENT_REVIEW" }),
    ],
  });
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:all" }] }));
  const blocks = calls.find((call) => call.method === "views.publish").args.view.blocks;
  const text = blocks.map((block) => blockText(block) ?? "").join("\n");
  const headers = blocks.filter((block) => block.type === "header").map(blockText);
  assert.deepEqual(headers, ["All open tasks", ":arrow_forward: Working on (2)", ":eyes: In review (1)", ":test_tube: In testing (0)", ":raising_hand: Delivered (1)"]);
  const at = (title) => text.indexOf(`|${title}>`);
  // Most urgent first within a section.
  assert.ok(at("Urgent doing") < at("Low todo") && at("Low todo") < text.indexOf("In review ("));
  // Subtasks go with their task, whatever their own status, most urgent first.
  assert.ok(text.indexOf("In review (") < at("Reviewing") && at("Reviewing") < at("Urgent part") && at("Urgent part") < at("Low part"));
  assert.ok(at("Low part") < text.indexOf("In testing ("));
  assert.match(text, /In testing \(0\)\n_Nothing in testing\._/);
  assert.ok(text.indexOf("Delivered (") < at("With client"));
});

test("the Home tab's buttons switch between My Tasks, Unassigned and All Tasks, and Refresh stays on the view", async (t) => {
  const task = (ts: string, title: string, people?: Partial<StoredTask["people"]>): Stored => ({
    channel: "CDEV",
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: [], reviewer: [], tester: [], ...people } },
  });
  const stored = [task("1.1", "Mine", { owner: ["UME"] }), task("2.1", "Nobody's", {}), task("3.1", "Theirs", { owner: ["UOTHER"] })];
  const view = async (action_id: string, value?: string) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    const body = interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id, value }] });
    assert.equal((await send("/slack/interactions", body)).status, 200);
    const [publish] = calls.filter((call) => call.method === "views.publish");
    assert.deepEqual(duplicateActionIds(publish.args.view.blocks), []);
    const buttons = publish.args.view.blocks.flatMap((block) => block.elements ?? []).filter((element) => element.type === "button");
    return { text: publish.args.view.blocks.map((block) => blockText(block) ?? "").join("\n"), primary: buttons.filter((b) => b.style).map((b) => b.text.text) };
  };
  const unassigned = await view("home:tab:unassigned");
  assert.match(unassigned.text, /Nobody's/);
  assert.doesNotMatch(unassigned.text, /Mine|Theirs/);
  assert.deepEqual(unassigned.primary, ["Home", "Unassigned"]);
  const all = await view("home:tab:all");
  assert.match(all.text, /Mine[^]*Nobody's[^]*Theirs|Mine[^]*Theirs[^]*Nobody's/);
  assert.doesNotMatch(all.text, /Assign to me/);
  assert.deepEqual(all.primary, ["Home", "All Tasks"]);
  const refreshed = await view("home:refresh", "unassigned");
  assert.deepEqual(refreshed.primary, ["Home", "Unassigned"]);
  assert.deepEqual((await view("home:tab:mine")).primary, ["Home", "My Tasks"]);
});

test("Assign to me on the Home tab's Unassigned view makes the person the owner, unless someone took it", async (t) => {
  const task = (ts: string, title: string, people?: Partial<StoredTask["people"]>): Stored => ({
    channel: "CDEV",
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: [], reviewer: [], tester: [], ...people } },
  });
  const stored = [task("1.1", "Mine", { owner: ["UME"] }), task("2.1", "Nobody's", {}), task("3.1", "Taken", { owner: ["UOTHER"] })];
  const claim = async (ts) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    const body = interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: `home:claim:CDEV:${ts}` }] });
    assert.equal((await send("/slack/interactions", body)).status, 200);
    return calls;
  };
  const buttons = (calls) => calls.find((call) => call.method === "views.publish").args.view.blocks.flatMap((block) => block.elements ?? []).filter((e) => e.text?.text === "Assign to me");
  const claimed = await claim("2.1");
  assert.equal(claimed.filter((call) => call.method === "chat.update").length, 1);
  assert.equal(claimed.find((call) => call.method === "views.publish").args.user_id, "UME");
  // It is drawn again without the task, now owned.
  assert.deepEqual(buttons(claimed), []);
  const drawn = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored: [task("2.1", "Nobody's", {}), task("1.1", "Mine", { owner: ["UME"] })] });
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:unassigned" }] }));
  assert.deepEqual(buttons(drawn).map((b) => b.action_id), ["home:claim:CDEV:2.1"]);
  const late = await claim("3.1");
  assert.equal(late.filter((call) => call.method === "chat.update").length, 0);
  assert.equal(late.filter((call) => call.method === "views.publish").length, 1);
});

test("the Home tab shows only the projects whose channel the person is in, public or private", async (t) => {
  const task = (channel: string, ts: string, title: string): Stored => ({
    channel,
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: ["UME"], reviewer: [], tester: [] } },
  });
  const stored = [task("CDEV", "1.1", "In acme"), task("CTESTDEV", "2.1", "In test")];
  const publishOf = (calls) => calls.findLast((call) => call.method === "views.publish").args.view;
  const textOf = (view) => view.blocks.map((block) => blockText(block) ?? "").join("\n");
  const picker = (view) => view.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === "home:project");
  const opened = () => send("/slack/events", JSON.stringify({ type: "event_callback", authorizations: [{ user_id: "UBOT" }], event: { type: "app_home_opened", user: "UME", tab: "home" } }));

  // UME is in test's channel only, and had picked acme before.
  let calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, "conversations.members": (args) => ({ members: args.channel === "CTESTDEV" ? ["UME"] : ["UBOB"] }), stored });
  await DB.prepare("INSERT INTO user_preferences (user_id, home_project) VALUES (?, ?)").bind("UME", "acme").run();
  await opened();
  let view = publishOf(calls);
  assert.deepEqual(picker(view).options.map((option) => option.value), ["test"]);
  assert.match(textOf(view), /In test/);
  assert.doesNotMatch(textOf(view), /In acme/);

  // In none: no tasks, and told why.
  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, "conversations.members": { members: ["UBOB"] }, stored });
  await opened();
  view = publishOf(calls);
  assert.equal(picker(view), undefined);
  assert.match(textOf(view), /aren't in any project's channel yet/);
  assert.doesNotMatch(textOf(view), /In acme|In test/);
});

test("the Home tab's project picker keeps the person's project for next time", async (t) => {
  const task = (channel: string, ts: string, title: string): Stored => ({
    channel,
    ts,
    task: { ...storedTask().task, title, status: "TODO", people: { owner: ["UME"], reviewer: [], tester: [] } },
  });
  const stored = [task("CDEV", "1.1", "In acme"), task("CTESTDEV", "2.1", "In test")];
  const publishOf = (calls) => calls.find((call) => call.method === "views.publish").args.view;
  const textOf = (view) => view.blocks.map((block) => blockText(block) ?? "").join("\n");
  const interact = (action) => send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, view: { private_metadata: "mine" }, actions: [action] }));

  let calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await interact({ action_id: "home:project", selected_option: { value: "test" } });
  let view = publishOf(calls);
  assert.match(textOf(view), /In test/);
  assert.doesNotMatch(textOf(view), /In acme/);
  const picker = view.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === "home:project");
  assert.equal(picker.initial_option.value, "test");

  // Remembered when the tab is opened later, without the stored tasks being reset.
  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await DB.prepare("INSERT INTO user_preferences (user_id, home_project) VALUES (?, ?)").bind("UME", "test").run();
  await send("/slack/events", JSON.stringify({ type: "event_callback", authorizations: [{ user_id: "UBOT" }], event: { type: "app_home_opened", user: "UME", tab: "home" } }));
  assert.doesNotMatch(textOf(publishOf(calls)), /In acme/);

  // With none chosen, or one that is gone, the first project is shown, and the picker has no "all".
  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await interact({ action_id: "home:project", selected_option: { value: "gone" } });
  view = publishOf(calls);
  assert.match(textOf(view), /In acme/);
  assert.doesNotMatch(textOf(view), /In test/);
  const options = view.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id === "home:project").options;
  assert.deepEqual(options.map((option) => option.value), ["acme", "test"]);
  // The tab is remembered too: it opens on Unassigned after that was last used.
  calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await interact({ action_id: "home:tab:unassigned" });
  await send("/slack/events", JSON.stringify({ type: "event_callback", authorizations: [{ user_id: "UBOT" }], event: { type: "app_home_opened", user: "UME", tab: "home" } }));
  assert.match(textOf(calls.filter((call) => call.method === "views.publish").at(-1).args.view), /Unassigned tasks/);
  assert.equal(await DB.prepare("SELECT home_project FROM user_preferences WHERE user_id = ?").bind("UME").first().then((row) => row.home_project), null);
});

test("Settings on the Home tab has the person's own setup, and for an admin a project picker with that project's settings and Edit", async (t) => {
  const stored: Stored[] = [{ channel: "CDEV", ts: "1.1", task: { ...storedTask().task, status: "TODO", people: { owner: ["UME"], reviewer: [], tester: [] } } }];
  const open = async (action: string, user: string, environment: AppEnv = env, seed?: () => Promise<unknown>) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    await seed?.();
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: user }, view: { private_metadata: "mine" }, actions: [{ action_id: action }] }), {}, environment);
    const view = calls.find((call) => call.method === "views.publish").args.view;
    assert.deepEqual(duplicateActionIds(view.blocks), []);
    const elements = view.blocks.flatMap((block) => [...(block.elements ?? []), ...(block.accessory ? [block.accessory] : [])]);
    const buttons = elements.filter((element) => element.type === "button");
    return {
      view,
      names: buttons.map((button) => button.text.text),
      pickers: elements.filter((element) => element.action_id === "home:project").length,
      settings: buttons.find((button) => button.action_id === "home:settings"),
      text: view.blocks.map((block) => blockText(block) ?? "").join("\n"),
    };
  };
  const settings = (user: string, environment?: AppEnv, seed?: () => Promise<unknown>) => open("home:section:configure", user, environment, seed);
  const admin = { ...env, ADMINS: JSON.stringify(["UME"]) };
  // Everyone: Home, Settings and Refresh along the top, then their own setup, each with how it stands and a button to change it.
  // No project picker, task tabs or Add project there.
  const member = await settings("UME");
  assert.equal(member.view.private_metadata, "configure");
  assert.deepEqual(member.names, ["Home", "Settings", "Refresh", "Manage", "Manage", "Turn off"]);
  assert.equal(member.view.blocks[0].elements[1].style, "primary");
  assert.equal(member.pickers, 0);
  assert.match(member.text, /Just for you\n\*Web pages\*\n:x: Not signed in on any browser/);
  assert.match(member.text, /\*AI agent\*\n:x: No key yet/);
  assert.doesNotMatch(member.text, /Projects|Project settings/);
  // The picture follows what the person has done, without opening anything.
  const set = await settings("UME", env, async () => {
    await DB.prepare("INSERT INTO web_tokens (token_hash, user_id, kind, expires_at) VALUES ('h1', 'UME', 'session', datetime('now', '+1 day')), ('h2', 'UME', 'session', datetime('now', '+1 day')), ('h3', 'UME', 'session', datetime('now', '-1 day'))").run();
    await DB.prepare("INSERT INTO mcp_tokens (user_id, token_hash) VALUES ('UME', 'k1')").run();
  });
  assert.match(set.text, /:white_check_mark: Signed in on 2 browsers/);
  assert.match(set.text, /:white_check_mark: Configured · key made \d{4}-\d{2}-\d{2} · \d+ tools/);
  // An admin also has Projects: the picker, then the picked project's people and switches, with Edit for the form.
  const asAdmin = await settings("UME", admin);
  assert.deepEqual(asAdmin.names, ["Home", "Settings", "Refresh", "Manage", "Manage", "Turn off", "Edit"]);
  assert.equal(asAdmin.pickers, 1);
  assert.equal(asAdmin.settings.value, "CDEV");
  assert.match(asAdmin.text, /Projects\n[\s\S]*\*Project settings\*\n\*acme\* in <#CDEV>\nTask change detection: on  ·  New task detection: on/);
  // MCP off: it says so, with no button.
  const off = await settings("UME", { ...env, MCP: "off" });
  assert.deepEqual(off.names, ["Home", "Settings", "Refresh", "Manage", "Turn off"]);
  assert.match(off.text, /\*AI agent\*\n:x: Turned off by an admin/);
  // Suggestions name every project where an admin turned them off, whichever project is picked.
  const projectsOff = (env.PROJECTS as Project[]).map((pair) => (pair.channel === "CDEV" ? pair : { ...pair, taskChangeDetection: false }));
  const named = await settings("UME", { ...env, PROJECTS: projectsOff });
  const others = projectsOff.filter((pair) => pair.channel !== "CDEV").map((pair) => `\\*${pair.name}\\*`).join(", ");
  assert.match(named.text, new RegExp(`Turned off for everyone by an admin in ${others}\\.`));

  // Home: the same top row, then the project picker with Add project (for an admin), then the task tabs.
  const home = await open("home:section:home", "UME", admin);
  assert.equal(home.view.private_metadata, "mine");
  assert.deepEqual(home.view.blocks[0].elements.map((element) => element.text.text), ["Home", "Settings", "Refresh"]);
  assert.equal(home.view.blocks[0].elements[0].style, "primary");
  // A line between the top row and the rest, on Home as on Settings.
  assert.equal(home.view.blocks[1].type, "divider");
  assert.equal(member.view.blocks[1].type, "divider");
  assert.deepEqual(home.view.blocks[2].elements.map((element) => element.action_id), ["home:project", "home:project:add"]);
  assert.deepEqual(home.view.blocks[3].elements.map((element) => element.text.text), ["My Tasks", "By person", "Unassigned", "All Tasks"]);
  const memberHome = await open("home:section:home", "UME");
  assert.deepEqual(memberHome.view.blocks[2].elements.map((element) => element.action_id), ["home:project"]);
});

test("with no projects yet, Home offers an admin Add project, and Settings still has the person's own setup", async (t) => {
  const draw = async (action: string, environment: AppEnv) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: action }] }), {}, environment);
    return calls.find((call) => call.method === "views.publish").args.view.blocks;
  };
  const none = { ...env, PROJECTS: "[]" };
  const admin = { ...none, ADMINS: JSON.stringify(["UME"]) };
  const adminHome = await draw("home:section:home", admin);
  assert.equal(adminHome[2].text.text, "There are no projects yet.");
  assert.equal(adminHome[2].accessory.action_id, "home:project:add");
  const memberHome = await draw("home:section:home", none);
  assert.match(blockText(memberHome[2]), /There are no projects yet\. An admin adds one on this tab\./);
  const adminSettings = (await draw("home:section:configure", admin)).map((block) => blockText(block) ?? "").join("\n");
  assert.match(adminSettings, /\*Suggestions\*/);
  assert.match(adminSettings, /Projects\n_There are no projects yet\. Add one with Add project on Home\._/);
});

test("npm run config sets MCP on or off from mcp", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.equal(readConfig(JSON.stringify({ projects })).MCP, undefined);
  assert.equal(readConfig(JSON.stringify({ projects, mcp: false })).MCP, "off");
  assert.equal(readConfig(JSON.stringify({ projects, mcp: true })).MCP, "on");
  assert.throws(() => readConfig(JSON.stringify({ projects, mcp: "no" })), /mcp is true or false/);
});

test("npm run config sets ADMINS from admins, always, and checks them", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.equal(readConfig(JSON.stringify({ projects })).ADMINS, "[]");
  assert.equal(readConfig(JSON.stringify({ projects, admins: ["UANN", "UBOB", "UANN"] })).ADMINS, '["UANN","UBOB"]');
  assert.throws(() => readConfig(JSON.stringify({ projects, admins: ["ann"] })), /admins is a list of Slack user IDs/);
  assert.throws(() => readConfig(JSON.stringify({ projects, admins: "UANN" })), /admins is a list of Slack user IDs/);
});

test("npm run config checks the summaryCanvas and newTaskDetection switches, and says activeTasksPinning is gone", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  const set = JSON.parse(readConfig(JSON.stringify({ projects: [{ ...projects[0], summaryCanvas: true, newTaskDetection: false }] })).PROJECTS)[0];
  assert.deepEqual([set.summaryCanvas, set.newTaskDetection], [true, false]);
  assert.throws(() => readConfig(JSON.stringify({ projects: [{ ...projects[0], summaryCanvas: "no" }] })), /acme's summaryCanvas is true or false/);
  assert.throws(() => readConfig(JSON.stringify({ projects, summaryCanvas: true })), /"summaryCanvas" at the top; set it on each project/);
  // Pinning was removed: a config that still sets it is told to delete it, whatever it says.
  for (const value of [true, false]) {
    assert.throws(() => readConfig(JSON.stringify({ projects: [{ ...projects[0], activeTasksPinning: value }] })), /acme's activeTasksPinning is no longer a setting: Cade doesn't pin tasks .* Delete it\./);
  }
});

test("the summary canvas can be turned off, for every group or one", async (t) => {
  const { refreshSummary } = await import("../src/tasks.ts");
  const pairs = [{ name: "acme", channel: "CDEV" }, { name: "test", channel: "CTESTDEV", summaryCanvas: false }];
  for (const [environment, channel, canvases] of [
    [{ ...env }, "CDEV", true],
    [{ ...env, SUMMARY_CANVAS: "off" }, "CDEV", false],
    [{ ...env, SUMMARY_CANVAS: undefined }, "CDEV", false],
    [{ ...env, PROJECTS: pairs }, "CDEV", true],
    [{ ...env, PROJECTS: pairs }, "CTESTDEV", false],
  ] as const) {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" } });
    await refreshSummary(environment, channel, { create: true });
    assert.equal(calls.some((call) => /canvas/.test(call.method)), canvases, JSON.stringify([channel, environment.SUMMARY_CANVAS]));
  }
});
test("slack:create checks its settings before calling Slack", async () => {
  const { checkSettings } = await import("../scripts/slack-app.ts");
  assert.deepEqual(checkSettings({ workerUrl: "https://cade.acme.workers.dev", name: "Cade", command: "/cade" }), []);
  assert.equal(checkSettings({ workerUrl: "http://cade", name: "Cade", command: "/cade" }).length, 1);
  assert.equal(checkSettings({ workerUrl: "https://cade.dev", name: "x".repeat(36), command: "/cade" }).length, 1);
  assert.equal(checkSettings({ workerUrl: "https://cade.dev", name: "Cade", command: "cade" }).length, 1);
});

test("npm run config checks the suggestions setting", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  const suggestions = (value) => JSON.parse(readConfig(JSON.stringify({ projects: [{ ...projects[0], taskChangeDetection: value }] })).PROJECTS)[0].taskChangeDetection;
  assert.equal(suggestions(false), false);
  assert.equal(suggestions(true), true);
  assert.throws(() => suggestions(["pr-links"]), /acme's taskChangeDetection is true or false/);
  assert.throws(() => suggestions("off"), /acme's taskChangeDetection is true or false/);
});

test("suggestions can be turned off, all or some, and a kind turned off asks the model nothing about it", async (t) => {
  const record = () => {
    const task = ownTask({ owners: ["UDEV1"] });
    task.task.status = "IN_PROGRESS";
    return task;
  };
  for (const [suggestions, text, offered] of [
    [undefined, "<@UREX> please review this", true],
    ["false", "<@UREX> please review this", false],
    ['["hand-offs"]', "<@UREX> please review this", true],
    ['["pr-links"]', "<@UREX> please review this", false],
  ] as const) {
    const { environment } = aiEnv(aiRead({ reviewer: add("UREX") }));
    const calls = mockSlack(t, { stored: [record()] });
    await send("/slack/events", threadEvent(text, { user: "UDEV1" }), {}, suggestions === undefined ? environment : { ...environment, TASK_CHANGE_DETECTION: suggestions });
    assert.equal(calls.some((call) => call.method === "chat.postEphemeral"), offered, `${suggestions}: ${text}`);
  }
});

test("npm run config turns cade.config.json into the Worker's secrets", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.deepEqual(readConfig(JSON.stringify({ timezone: "Asia/Colombo", projects })), {
    PROJECTS: JSON.stringify(projects),
    ADMINS: "[]",
    AI_MODEL_NAME: "",
    THREAD_ROTATION_DAYS: "",
    TIMEZONE: "Asia/Colombo",
  });
  // The timezone is optional.
  assert.deepEqual(readConfig(JSON.stringify({ projects })), { PROJECTS: JSON.stringify(projects), ADMINS: "[]", AI_MODEL_NAME: "", THREAD_ROTATION_DAYS: "" });
});

test("npm run config stops on a mistake, before uploading anything", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const good = [{ name: "acme", channel: "C0000000002" }];
  for (const [config, problem] of [
    ["{", /not valid JSON/],
    [{ projects: [{ channel: "C0000000002" }] }, /must list \{ name, channel \}/],
    [{ projects: [{ name: "acme" }] }, /must list \{ name, channel \}/],
    [{ projects: [{ name: "acme", channel: "#acme-dev" }] }, /doesn't look like a Slack channel ID/],
    [{ projects: [{ name: "acme", channel: "C0000000001" }, { name: "beta", channel: "C0000000001" }] }, /used twice/],
    [{ projects: good, timezone: "Sri Lanka" }, /isn't a time zone/],
    // A token here would be a mistake: they belong in Cloudflare only.
    [{ projects: good, SLACK_BOT_TOKEN: "xoxb-1" }, /has "SLACK_BOT_TOKEN"; it takes projects and timezone/],
  ] as const) {
    assert.throws(() => readConfig(typeof config === "string" ? config : JSON.stringify(config)), problem);
  }
});

test("npm run dev passes its settings to Wrangler as a quoted .env file", async () => {
  const { envFile } = await import("../scripts/dev.ts");
  const pairs = JSON.stringify([{ name: "acme", channel: "C0000000002" }]);
  assert.equal(
    envFile({ PROJECTS: pairs, TIMEZONE: "UTC", SLACK_BOT_TOKEN: "xoxb-1", PUBLIC_URL: undefined }),
    `PROJECTS='${pairs}'\nTIMEZONE='UTC'\nSLACK_BOT_TOKEN='xoxb-1'`,
  );
  assert.throws(() => envFile({ SLACK_SIGNING_SECRET: "it's" }), /can't contain a quote/);
});

test("npm run dev asks for Slack's two secrets", async () => {
  const { SECRETS } = await import("../scripts/dev.ts");
  assert.deepEqual(SECRETS.map(({ name }) => name), ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]);
  assert.deepEqual(SECRETS.filter((secret) => !secret.optional && !secret.when).map(({ name }) => name), [
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
  ]);
});

test("cade.config.json refuses googleUrl and workDoc, which went with executive summaries", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.throws(() => readConfig(JSON.stringify({ projects, googleUrl: "https://script.google.com/macros/s/AKfy-abc/exec" })), /googleUrl is no longer a setting.*Delete it/);
  assert.throws(() => readConfig(JSON.stringify({ projects: [{ ...projects[0], workDoc: "https://docs.google.com/document/d/x/edit" }] })), /acme's workDoc is no longer a setting.*Delete it/);
  assert.equal(readConfig(JSON.stringify({ projects })).GOOGLE_URL, undefined);
  // The old settings, and the secret, stay out of the file.
  assert.throws(() => readConfig(JSON.stringify({ projects, sheetUrl: "x" })), /has "sheetUrl"/);
  assert.throws(() => readConfig(JSON.stringify({ projects, googleSecret: "s" })), /has "googleSecret"/);
});

test("intent phrases match whole words, or word starts with *", async () => {
  const { intent, plainMessage } = await import("../src/intents.ts");
  const message = (text: string) => plainMessage({ type: "message", text, user: "U", channel: "C", ts: "1.2", thread_ts: "1.1" }, "UBOT");
  const whole = intent({ name: "whole", order: 1, phrases: ["work on"], handle() {} });
  assert.ok(whole.test(message("can you work on this")));
  assert.ok(!whole.test(message("that would work only later")));
  const start = intent({ name: "start", order: 1, phrases: ["test*"], handle() {} });
  assert.ok(start.test(message("ready for testing")));
  assert.ok(!start.test(message("the latest build")));
  assert.throws(() => intent({ name: "neither", order: 1, handle() {} }), /needs either phrases or match/);
});

test("the first intent by order wins, and needs are checked first", async () => {
  const { findIntent, intent, plainMessage } = await import("../src/intents.ts");
  const event = (text: string, extra = {}) => ({ type: "message", text, user: "U", channel: "C", ts: "1.2", thread_ts: "1.1", ...extra });
  const late = intent({ name: "late", order: 50, phrases: ["deploy*"], handle() {} });
  const early = intent({ name: "early", order: 5, phrases: ["deploy*"], needs: { mention: true }, handle() {} });
  // Order wins over the order they're listed in…
  assert.equal(findIntent([late, early], plainMessage(event("<@UREX> deploying now"), "UBOT")).name, "early");
  // …but an intent whose needs aren't met is passed over.
  assert.equal(findIntent([late, early], plainMessage(event("deploying now"), "UBOT")).name, "late");
  // Cade mentioning itself isn't someone mentioned.
  assert.equal(findIntent([early], plainMessage(event("<@UBOT> deploying"), "UBOT")), undefined);
  const threaded = intent({ name: "threaded", order: 1, phrases: ["deploy*"], needs: { thread: true }, handle() {} });
  assert.equal(findIntent([threaded], plainMessage(event("deploying", { thread_ts: undefined }), "UBOT")), undefined);
  // Edits and bot posts are never intents.
  assert.equal(plainMessage(event("deploying", { subtype: "message_changed" }), "UBOT"), null);
  assert.equal(plainMessage(event("deploying", { bot_id: "B1" }), "UBOT"), null);
});

test("handlers' intents are registered in order: work, then new threads", async () => {
  const { intents } = await import("../src/commands/registry.ts");
  assert.deepEqual(
    [...intents].sort((a, b) => a.order - b.order).map((each) => each.name),
    ["work", "new-thread"],
  );
});

test("@Cade status takes short names for each status", async () => {
  const { parseStatus } = await import("../src/commands/status.ts");
  for (const [input, status] of [
    ["to do", "TODO"], ["todo", "TODO"],
    ["in progress", "IN_PROGRESS"], ["progress", "IN_PROGRESS"], ["wip", "IN_PROGRESS"],
    ["in review", "IN_REVIEW"], ["review", "IN_REVIEW"],
    ["in testing", "IN_TESTING"], ["testing", "IN_TESTING"], ["QA", "IN_TESTING"],
    ["client review", "CLIENT_REVIEW"], ["client", "CLIENT_REVIEW"], ["uat", "CLIENT_REVIEW"],
    ["done", "DONE"], ["Finished", "DONE"], ["CLIENT_REVIEW", "CLIENT_REVIEW"],
    ["soon", undefined],
  ] as const) {
    assert.equal(parseStatus(input), status, input);
  }
});

test("messages about work already in hand suggest nothing", async (t) => {
  // UDEV1 and UDEV2 develop it, UMIA reviews and UTOM tests, and it's In
  // progress: none of these needs a question.
  const task = () => {
    const record = ownTask({ owners: ["UDEV1", "UDEV2"], reviewers: ["UMIA"], testers: ["UTOM"] });
    record.task.status = "IN_PROGRESS";
    return record;
  };
  for (const [user, text] of [
    ["UDEV1", "<@UDEV2> started working on some subtask"],
    ["UDEV1", "<@UDEV2> started working on the review comments"],
    ["UDEV1", "<@UDEV2> started working on the test cases"],
    ["UDEV1", "<@UDEV2> is working on the login part"],
    ["UDEV1", "<@UDEV2> started on the subtask"],
    ["UDEV1", "<@UMIA> started working on the review"],
    ["UDEV1", "<@UTOM> is working on the test plan"],
    ["UMIA", "started working on the review"],
    ["UTOM", "started working on the test cases"],
    ["UDEV2", "finished the login subtask"],
    ["UDEV2", "first part is done"],
    ["UDEV2", "fixed one of the bugs"],
  ] as const) {
    const calls = mockSlack(t, { stored: [task()] });
    await send("/slack/events", threadEvent(text, { user }));
    assert.deepEqual(calls.map((call) => call.method), [], `${user}: ${text}`);
  }
});

test("the Slack app's description fits Slack's 140 characters", async () => {
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../slack/manifest.json", import.meta.url), "utf8"));
  assert.ok(template.display_information.description.length <= 140);
});

test("npm run setup leaves secrets and tokens to the scripts it runs", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../scripts/setup.ts", import.meta.url), "utf8");
  // It sets no secrets itself.
  assert.doesNotMatch(script, /secret put/);
  // Nor does it ask for a token: slack:create does, hidden.
  assert.doesNotMatch(script, /askHidden/);
  assert.doesNotMatch(script, /ask\([^)]*token/i);
  const guide = await readFile(new URL("../GETTING_STARTED.md", import.meta.url), "utf8");
  assert.match(guide, /npm run setup/);
});

test("npm run slack:create asks for both tokens hidden", async () => {
  const { readFile } = await import("node:fs/promises");
  const script = await readFile(new URL("../scripts/slack-app.ts", import.meta.url), "utf8");
  assert.match(script, /askHidden\("Bot token/);
  assert.doesNotMatch(script, /createInterface/);
});

// D1 is the source of truth; root messages are rendered from it.

test("each change is stored, and the root message is rendered from the stored task", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  await send("/slack/events", threadEvent("<@UBOT> assign tester <@UTESS>"));

  // Slack is only written to: nothing is read back from it.
  assert.deepEqual(calls.map((call) => call.method), [
    "chat.update",
    "reactions.add",
    "chat.postEphemeral",
    "chat.update",
    "reactions.add",
  ]);
  assert.deepEqual((await savedTask()).people, { owner: ["UALICE", "UBOB"], reviewer: [], tester: ["UTESS"] });
  assert.equal(
    footerLines(calls[3].args)[0],
    "Owner <@UALICE>, <@UBOB>  ·  Test <@UTESS>",
  );
});

test("a thread with no stored task isn't one", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  // The task is in CDEV; the same ts in another channel is a different message.
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>", { channel: "CTESTDEV" }));
  assert.match(calls.at(-1).args.text, /not tracking a task in this thread/);
});

test("a deleted task is kept in the database and no longer loads", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [] },
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.equal(await savedTask(), null);
  assert.ok(await DB.prepare("SELECT 1 FROM tasks WHERE deleted_at IS NOT NULL").first());

  calls.length = 0;
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);
  assert.match(calls[0].args.text, /not tracking a task in this thread/);
});
// Tasks are stored before they are posted; those Slack refused are posted
// again by the cron.

// Runs the cron, as Cloudflare does, and waits for its work.
async function runCron(environment = env) {
  await seeded;
  const pending: Promise<unknown>[] = [];
  await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.UTC(2026, 0, 1, 0, 0) } as ScheduledController, environment, context((promise) => { pending.push(promise); }));
  await Promise.all(pending);
}

// Makes every stored row look `minutes` old, as if posting failed back then.
const age = (minutes = 2) =>
  DB.prepare("UPDATE tasks SET created_at = datetime('now', ?)").bind(`-${minutes} minutes`).run();

// A task tracked with /cade task that Slack refused `attempts` times.
async function waitingTask(attempts = 1) {
  const { task } = storedTask();
  const id = await insertTask(env, "CDEV", task, {});
  await DB.prepare("UPDATE tasks SET post_attempts = ? WHERE id = ?").bind(attempts, id).run();
  return id;
}

test("the cron posts a task Slack refused, and finishes tracking it", async (t) => {
  const calls = mockSlack(t, { ...createdTask, stored: [] });
  await waitingTask();
  await age();
  await runCron();

  // Its thread is read to be kept; with no request, the cron has no address to link its pages by.
  assert.deepEqual(withoutSummary(calls).map((call) => call.method), ["chat.postMessage", "chat.getPermalink", "conversations.replies"]);
  assert.equal(calls[0].args.channel, "CDEV");
  const task = await savedTask();
  assert.equal(task.title, "Fix login");
  assert.equal(task.link, "https://slack.example/p100");
  // Posted once: nothing is left to retry.
  calls.length = 0;
  await runCron();
  // Only the summary canvas, made for the new task, is left to write (see summary.js).
  assert.equal(withoutSummary(calls).length, 0);
});

test("the cron leaves alone posts that may still be under way", async (t) => {
  const calls = mockSlack(t, createdTask);
  await waitingTask();
  await runCron();
  assert.equal(calls.length, 0);
});

// Thread rotation (see rotate.ts): the cron, on the hour, gives an open task older than
// threadRotationDays a new root message.
const OLD_ROOT = "1765000000.000100"; // 6 December 2025, 26 days before runCron's time
const NEW_ROOT = "1767225600.000200";

async function oldThread(status: Status = "TODO") {
  const { task } = storedTask({ status });
  await putTask(env, "CDEV", OLD_ROOT, { ...task, export: { url: `https://worker.example.net/t/CDEV/${OLD_ROOT}` } });
  await DB.prepare("INSERT INTO messages (channel, task_ts, ts, text) VALUES ('CDEV', ?, '1765000001.000100', 'on it')").bind(OLD_ROOT).run();
  await DB.prepare("INSERT INTO task_summaries (channel, task_ts, summary, through_ts, written_by) VALUES ('CDEV', ?, 'The issue', '1765000001.000100', 'UANN')").bind(OLD_ROOT).run();
  await DB.prepare("INSERT INTO task_consumers (channel, task_ts, consumer, through_ts, acked_by) VALUES ('CDEV', ?, 'sync-tasks', '1765000001.000100', 'UANN')").bind(OLD_ROOT).run();
}

const rotating = {
  // Replies are posted just after the new root: the old thread's note, then the new one's.
  "chat.postMessage": (args) => ({ channel: args.channel, ts: args.thread_ts ? `176722560${args.thread_ts === OLD_ROOT ? 1 : 2}.000300` : NEW_ROOT }),
  "chat.getPermalink": (args) => ({ permalink: `https://slack.example/p${args.message_ts}` }),
};

test("the cron rotates an open task's thread older than threadRotationDays, linking old and new", async (t) => {
  const calls = mockSlack(t, rotating);
  await oldThread();
  await runCron({ ...env, SUMMARY_CANVAS: "off", THREAD_ROTATION_DAYS: "20" });

  const posts = calls.filter((call) => call.method === "chat.postMessage");
  // The card again as a new root, then a note in each thread.
  assert.equal(posts.length, 3);
  assert.equal(posts[0].args.thread_ts, undefined);
  assert.equal(posts[1].args.thread_ts, OLD_ROOT);
  assert.match(posts[1].args.text, new RegExp(`This thread is rotated.*New messages go <https://slack.example/p${NEW_ROOT}\\|here>`));
  assert.equal(posts[2].args.thread_ts, NEW_ROOT);
  assert.match(posts[2].args.text, new RegExp(`Rotated thread. Complete history <https://worker.example.net/t/CDEV/${NEW_ROOT}\\|here>, older thread <https://slack.example/p${OLD_ROOT}\\|here>`));
  // The old card is its title and where it went, with no buttons or strip.
  const old = calls.find((call) => call.method === "chat.update" && call.args.ts === OLD_ROOT);
  assert.deepEqual(old.args.attachments, []);
  assert.deepEqual(old.args.blocks.map(blockText), ["*Fix login*", `:recycle: This thread is rotated. New messages go <https://slack.example/p${NEW_ROOT}|here>.`]);
  // The new card links its history at its new address.
  const update = calls.find((call) => call.method === "chat.update");
  assert.equal(update.args.ts, NEW_ROOT);
  assert.match(JSON.stringify(update.args.attachments), new RegExp(`/t/CDEV/${NEW_ROOT}`));

  // The task, its kept messages, its summary and its consumers' positions are found by the new root now.
  assert.equal(await savedTask("CDEV", OLD_ROOT), null);
  const task = await savedTask("CDEV", NEW_ROOT);
  assert.equal(task.link, `https://slack.example/p${NEW_ROOT}`);
  assert.equal(task.export.url, `https://worker.example.net/t/CDEV/${NEW_ROOT}`);
  // Its history runs on across both threads: the old thread's messages, then the rotation.
  const { results } = await DB.prepare("SELECT text FROM messages WHERE task_ts = ? ORDER BY ts").bind(NEW_ROOT).all();
  assert.deepEqual(results.map((row) => String(row.text).split(".")[0]), ["on it", ":recycle: Rotated thread"]);
  assert.ok(await DB.prepare("SELECT 1 FROM task_summaries WHERE task_ts = ?").bind(NEW_ROOT).first());
  assert.ok(await DB.prepare("SELECT 1 FROM task_consumers WHERE task_ts = ?").bind(NEW_ROOT).first());
});

test("rotating a task's thread redraws its subtasks' cards, which link the new root", async (t) => {
  const calls = mockSlack(t, rotating);
  await oldThread();
  // A subtask posted since, too young to rotate itself, with an owner of its own (so saving its task
  // wouldn't redraw it anyway: see followParent).
  const subtask = { ...storedTask({ owners: ["UREX"] }).task, title: "Its part", parent: { ts: OLD_ROOT, title: "Fix login" } };
  await markTaskPosted(env, await insertTask(env, "CDEV", subtask, {}), "1766000000.000100");
  await runCron({ ...env, SUMMARY_CANVAS: "off", THREAD_ROTATION_DAYS: "20" });

  const redrawn = calls.find((call) => call.method === "chat.update" && call.args.ts === "1766000000.000100");
  assert.match(JSON.stringify(redrawn.args.attachments), new RegExp(`Subtask of <https://slack.example/p${NEW_ROOT}\\|Fix login>`));
});

test("a subtask rotates by its own thread's age, and after its task in the same run, links the task's new root", async (t) => {
  // Each new root gets the next ts, the task's first as it is the older.
  let roots = 0;
  const calls = mockSlack(t, { ...rotating, "chat.postMessage": (args) => ({ channel: args.channel, ts: args.thread_ts ? "1767225609.000300" : `176722560${++roots}.000100` }) });
  await oldThread();
  const subtask = { ...storedTask({ owners: ["UREX"] }).task, title: "Its part", parent: { ts: OLD_ROOT, title: "Fix login" } };
  await markTaskPosted(env, await insertTask(env, "CDEV", subtask, {}), "1765000500.000100");
  await runCron({ ...env, SUMMARY_CANVAS: "off", THREAD_ROTATION_DAYS: "20" });

  const [taskRoot, subtaskRoot] = ["1767225601.000100", "1767225602.000100"];
  assert.equal((await savedTask("CDEV", subtaskRoot)).parent.ts, taskRoot);
  const card = calls.filter((call) => call.method === "chat.update" && call.args.ts === subtaskRoot).at(-1);
  assert.match(JSON.stringify(card.args.attachments), new RegExp(`Subtask of <https://slack.example/p${taskRoot}\\|Fix login>`));
});

test("the cron leaves young threads, Done tasks, and every thread without threadRotationDays", async (t) => {
  for (const [status, days] of [["TODO", "80"], ["DONE", "20"], ["TODO", ""]] as const) {
    const calls = mockSlack(t, rotating);
    await oldThread(status);
    await runCron({ ...env, SUMMARY_CANVAS: "off", THREAD_ROTATION_DAYS: days });
    assert.deepEqual(calls, [], `${status}, ${days || "off"}`);
    assert.ok(await savedTask("CDEV", OLD_ROOT));
  }
});

test("npm run config sets THREAD_ROTATION_DAYS from threadRotationDays, always, and checks it", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [{ name: "acme", channel: "C0000000002" }];
  assert.equal(readConfig(JSON.stringify({ projects, threadRotationDays: 80 })).THREAD_ROTATION_DAYS, "80");
  assert.equal(readConfig(JSON.stringify({ projects })).THREAD_ROTATION_DAYS, "");
  for (const days of [0, 1.5, "80"]) assert.throws(() => readConfig(JSON.stringify({ projects, threadRotationDays: days })), /threadRotationDays is a whole number/);
});

test("the cron tells nobody while it keeps trying, and gives up after the last attempt", async (t) => {
  const calls = mockSlack(t, { "chat.postMessage": { ok: false, error: "channel_not_found" } });
  await waitingTask(1);
  await age();
  await runCron();
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage"]);

  calls.length = 0;
  await DB.prepare("UPDATE tasks SET post_attempts = 4").run();
  await runCron();
  assert.deepEqual(calls.map((call) => call.method), ["chat.postMessage", "chat.postEphemeral"]);
  assert.equal(calls[1].args.user, "UCREATOR");
  assert.equal(calls[1].args.text, 'Sorry, I couldn\'t create the task "Fix login", even after a few tries.');
  // Given up: not tried again.
  calls.length = 0;
  await runCron();
  assert.equal(calls.length, 0);
  assert.ok(await DB.prepare("SELECT 1 FROM tasks WHERE deleted_at IS NOT NULL").first());
});

// /cade tasks options: a person, everyone, status and due date filters.


test("today is in the configured time zone", () => {
  const lateEvening = new Date("2026-10-24T20:00:00Z");
  assert.equal(todayIn({}, lateEvening), "2026-10-24");
  assert.equal(todayIn({ TIMEZONE: "Asia/Colombo" }, lateEvening), "2026-10-25");
});

// /cade standup: the group's open tasks, one owner at a time, privately.

// A click on a standup message's button or menu, `action` as Slack sends it.
const standupClick = (action) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    response_url: RESPONSE_URL,
    container: { is_ephemeral: true },
    actions: [action],
  });

// The step's buttons, as [label, action_id].
const buttonsOf = (message) =>
  message.blocks.at(-1).elements.map((button) => [button.text.text, button.action_id]);

// Clicks the button labelled `label` in `message`, and returns the step shown
// in its place.
async function clickButton(t, message, label) {
  const button = message.blocks.at(-1).elements.find((element) => element.text.text === label);
  const sent = recordResponses(t);
  await send("/slack/interactions", standupClick({ action_id: button.action_id, value: button.value }));
  return sent.at(-1);
}

const standupTasks = () => ({
  CDEV: [
    historyTask("100.1", { title: "Bob's low", priority: "Low", owners: ["UBOB"] }),
    historyTask("100.2", { title: "Bob's urgent", priority: "Urgent", owners: ["UBOB"], status: "IN_PROGRESS" }),
    historyTask("100.3", { title: "Alice's", owners: ["UALICE"] }),
    historyTask("100.4", { title: "Mine", owners: ["UACTOR"], status: "IN_REVIEW" }),
    historyTask("100.5", { title: "Nobody's", testers: ["UALICE"] }),
    historyTask("100.6", { title: "Done already", owners: ["UALICE"], status: "DONE" }),
  ],
});

test("/cade standup starts with whoever runs it, then everyone by name, then tasks with no owner", async (t) => {
  const { calls, now, later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  assert.equal(now, "");
  assert.equal(later.response_type, "ephemeral");
  assert.equal(later.blocks[0].text.text, "*Standup: <@UACTOR>*  ·  1 of 4");
  assert.equal(later.blocks[1].elements[0].text, "1 open task  ·  acme");
  const [mine] = later.blocks.filter((block) => block.accessory);
  assert.match(mine.text.text, /\|Mine>  ·  :eyes: In review/);
  assert.equal(mine.accessory.type, "static_select");
  assert.equal(mine.accessory.initial_option.value, "IN_REVIEW");
  assert.deepEqual(buttonsOf(later), [["Next: Alice ▶", "standup:next"], ["End", "standup:end"]]);

  const alice = await clickButton(t, later, "Next: Alice ▶");
  assert.equal(alice.replace_original, true);
  assert.equal(alice.blocks[0].text.text, "*Standup: <@UALICE>*  ·  2 of 4");
  // Done tasks are left out.
  assert.equal(alice.blocks[1].elements[0].text, "1 open task  ·  acme");
  assert.deepEqual(buttonsOf(alice), [["◀ Back", "standup:back"], ["Next: Bob ▶", "standup:next"], ["End", "standup:end"]]);

  const bob = await clickButton(t, alice, "Next: Bob ▶");
  // Most urgent first.
  const titles = bob.blocks.filter((block) => block.accessory).map((block) => block.text.text.match(/\|([^>]+)>/)[1]);
  assert.deepEqual(titles, ["Bob's urgent", "Bob's low"]);
  // Each menu has its own action_id, as Slack requires.
  assert.deepEqual(
    bob.blocks.filter((block) => block.accessory).map((block) => block.accessory.action_id),
    ["standup:status:0", "standup:status:1"],
  );

  const nobody = await clickButton(t, bob, "Next: No owner ▶");
  assert.equal(nobody.blocks[0].text.text, "*Standup: no owner yet*  ·  4 of 4");
  const [unassigned] = nobody.blocks.filter((block) => block.accessory);
  assert.match(unassigned.text.text, /\|Nobody's>/);
  assert.equal(unassigned.accessory.type, "users_select");
  assert.deepEqual(buttonsOf(nobody), [["◀ Back", "standup:back"], ["Finish", "standup:end"]]);

  const back = await clickButton(t, nobody, "◀ Back");
  assert.equal(back.blocks[0].text.text, "*Standup: <@UBOB>*  ·  3 of 4");
  // Each step sorts the owners by name, but the names are kept after the
  // first look-up rather than asked of Slack on every click.
  const asked = calls.filter((call) => call.method === "users.info").map((call) => call.args.user);
  assert.deepEqual(asked.sort(), ["UACTOR", "UALICE", "UBOB"]);
});

test("a standup's status menu sets the status and tells the task's thread", async (t) => {
  const { calls, later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  const [mine] = later.blocks.filter((block) => block.accessory);
  calls.length = 0;
  const sent = recordResponses(t);
  await send(
    "/slack/interactions",
    standupClick({ action_id: mine.accessory.action_id, block_id: mine.block_id, selected_option: { value: "IN_TESTING" } }),
  );
  assert.equal((await savedTask("CDEV", "100.4")).status, "IN_TESTING");
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.4");
  assert.equal(post.text, "<@UACTOR> set the status to :test_tube: In testing.");
  // The same step again, showing the change.
  assert.equal(sent.at(-1).replace_original, true);
  assert.equal(sent.at(-1).blocks[0].text.text, "*Standup: <@UACTOR>*  ·  1 of 4");
  assert.equal(sent.at(-1).blocks.find((block) => block.accessory).accessory.initial_option.value, "IN_TESTING");
});

test("/cade standup -unassigned goes through tasks with no owner, one at a time, to assign them", async (t) => {
  const { calls, later } = await tasksCommand(t, "standup -unassigned", "CDEV", {
    CDEV: [
      historyTask("100.1", { title: "Low", priority: "Low" }),
      historyTask("100.2", { title: "Urgent", priority: "Urgent", link: "https://acme.slack.com/archives/CDEV/p1002" }),
      historyTask("100.3", { title: "Taken", owners: ["UBOB"] }),
    ],
  });
  assert.equal(later.blocks[0].text.text, "*Unassigned acme tasks*  ·  1 of 2");
  const first = later.blocks.find((block) => block.accessory);
  assert.match(first.text.text, /\|Urgent>/);
  assert.deepEqual(buttonsOf(later), [["Skip ▶", "standup:next"], ["End", "standup:end"]]);

  calls.length = 0;
  const sent = recordResponses(t);
  await send(
    "/slack/interactions",
    standupClick({ action_id: first.accessory.action_id, block_id: first.block_id, selected_user: "UALICE" }),
  );
  assert.deepEqual((await savedTask("CDEV", "100.2")).people.owner, ["UALICE"]);
  const post = calls.find((call) => call.method === "chat.postMessage").args;
  assert.equal(post.thread_ts, "100.2");
  assert.equal(post.text, "<@UACTOR> assigned <@UALICE> as owner.");
  // Asking them is offered where the walk is, in the channel, linking the task's thread.
  assert.deepEqual(drafts(calls), ["<@UALICE>, could you pick this up?"]);
  const offer = calls.find((call) => call.method === "chat.postEphemeral").args;
  assert.deepEqual([offer.channel, offer.thread_ts, offer.user], ["CDEV", undefined, "UACTOR"]);
  assert.match(offer.blocks[0].text.text, /^Send this in <https:\/\/acme\.slack\.com\/archives\/CDEV\/p1002\|the task's thread>\?/);
  // Assigned, it leaves the walk: the next one takes its place.
  const next = sent.at(-1);
  assert.equal(next.blocks[0].text.text, "*Unassigned acme tasks*  ·  1 of 1");
  assert.match(next.blocks.find((block) => block.accessory).text.text, /\|Low>/);
  assert.deepEqual(buttonsOf(next), [["Finish", "standup:end"]]);

  const last = next.blocks.find((block) => block.accessory);
  await send(
    "/slack/interactions",
    standupClick({ action_id: last.accessory.action_id, block_id: last.block_id, selected_user: "UBOB" }),
  );
  assert.equal(sent.at(-1).text, "Every open acme task has an owner. Nice!");
});

test("End and Finish remove the standup", async (t) => {
  const { later } = await tasksCommand(t, "standup", "CDEV", standupTasks());
  const sent = recordResponses(t);
  await send("/slack/interactions", standupClick({ action_id: "standup:end", value: "end" }));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
  assert.ok(later);
});

test("/cade standup says so when there's nothing to go through, and takes only -unassigned", async (t) => {
  const empty = await tasksCommand(t, "standup", "CDEV", {});
  assert.equal(empty.later.text, "No one has open acme tasks right now.");

  const wrong = await tasksCommand(t, "standup everyone", "CDEV", {});
  assert.equal(
    JSON.parse(wrong.now).text,
    'I don\'t know "everyone" as an option. Send `/cade standup` to go through everyone\'s tasks, or `/cade standup -unassigned` for those with no owner.',
  );
  // It's the team's, so it runs in its channels.
  const outside = await tasksCommand(t, "standup", "COTHER", {});
  assert.equal(JSON.parse(outside.now).text, "That one works with `/cade standup` in <#CDEV> or <#CTESTDEV>.");
});

// In the dev channel: a message at 100.7, posted on its own, and tasks to
// move it to.
const devStray = { ts: "100.7", user: "UACTOR", text: "The login bug also hits SSO\nfor some people" };
const devTask = (ts: string, title: string, status: Status, fields: Partial<StoredTask> = {}) => {
  const record = storedTask();
  Object.assign(record, { ts });
  Object.assign(record.task, { title, status, ...fields });
  return record;
};

// A Slack API where conversations.replies gives `root` as the thread's root,
// posts get a ts in their thread, and permalinks end with the message's ts.
const moveSlack = (root: Record<string, unknown> | null = devStray, replies: unknown[] = []) => ({
  "conversations.replies": { messages: root ? [root, ...replies] : [] },
  "chat.postMessage": (args) => (args.thread_ts ? { ts: `${args.thread_ts.split(".")[0]}.9` } : { channel: args.channel, ts: "100.1" }),
  "chat.getPermalink": (args) => ({ permalink: `https://slack.example/${args.message_ts}` }),
});

// `@Cade move`, replied in the stray message's thread.
const moveEvent = (overrides = {}) => threadEvent("<@UBOT> move", { ts: "100.8", thread_ts: "100.7", ...overrides });

// Clicks Move on the picker, with `picked` (a task's ts) chosen.
const moveClick = (picked, actionId = "move:confirm") =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    state: { values: { "move:target": { "move:pick": { selected_option: picked ? { value: picked } : null } } } },
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.7" }) }],
  });

// Cade's note under a message it moved already.
const movedNote = {
  ts: "100.71",
  bot_id: "BCADE",
  text: "<@UACTOR> moved this message to the task thread <https://slack.example/100.9|Fix login>. Please carry on the conversation there.",
};

const optionsOf = (element) => element.options.map((option) => [option.text.text, option.value]);

test("@Cade move without a link says to add one, or use Move to existing", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  await send("/slack/events", moveEvent());
  assert.match(calls.at(-1).args.text, /^Add the link to the task: `@Cade move <link>`.*Move to existing\.$/);
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("@Cade move says why it can't move a message", async (t) => {
  for (const [event, stored, root, text] of [
    [moveEvent({ ts: "100.7", thread_ts: undefined }), [], devStray, "Reply `@Cade move` in the thread of the message you want to move."],
    [moveEvent({ thread_ts: "100.1" }), [storedTask()], devStray, "This is already a task thread."],
    [moveEvent(), [], { ...devStray, bot_id: "BOTHER" }, "I can only move people's messages."],
  ] as const) {
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    await send("/slack/events", event);
    assert.equal(calls.at(-1).args.text, text);
  }

  // A message moved already is pointed to, privately.
  const calls = mockSlack(t, moveSlack(devStray, [movedNote]));
  await send("/slack/events", moveEvent());
  assert.equal(calls.at(-1).method, "chat.postEphemeral");
  assert.equal(calls.at(-1).args.text, "This message was already moved: <https://slack.example/100.9|see it there>.");
});

test("Move copies the message into the task's thread and points the original there", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick("100.1"));
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.channel, call.args.thread_ts, call.args.text]);
  assert.deepEqual(posts, [
    ["CDEV", "100.1", "Moved from <@UACTOR>'s <https://slack.example/100.7?thread_ts=100.7&cid=CDEV|message>:\n> The login bug also hits SSO\n> for some people"],
    ["CDEV", "100.7", "<@UACTOR> moved this message to the task thread <https://slack.example/100.9|Fix login>. Please carry on the conversation there."],
  ]);
  assert.ok(calls.some((call) => call.method === "reactions.add" && call.args.timestamp === "100.7" && call.args.name === "outbox_tray"));
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Move says an incident thread, notes attachments, and leaves a pinned message's pin alone", async (t) => {
  const calls = mockSlack(t, {
    ...moveSlack({ ...devStray, files: [{ id: "F1" }], pinned_to: ["CDEV"] }),
    stored: [devTask("100.1", "Checkout is down", "TODO", { incident: true })],
  });
  recordResponses(t);
  await send("/slack/interactions", moveClick("100.1"));
  const [copy, note] = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.text);
  assert.match(copy, /\n_There's more in the original\._$/);
  assert.match(note, /moved this message to the incident thread/);
  assert.ok(!calls.some((call) => call.method.startsWith("pins.")));
});

test("Move moves nothing if the task was closed or the message deleted since", async (t) => {
  for (const [stored, root, text] of [
    [[devTask("100.1", "Fix login", "DONE")], devStray, "That task has been closed or deleted since, so I didn't move anything."],
    [[devTask("100.1", "Fix login", "TODO")], null, "That message has been deleted since, so there's nothing to move."],
  ] as const) {
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    const responses = recordResponses(t);
    await send("/slack/interactions", moveClick("100.1"));
    assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
    assert.equal(responses[0].text, text);
  }
});

test("Move without a pick asks for one, and Cancel removes the picker", async (t) => {
  const calls = mockSlack(t, { stored: [devTask("100.1", "Fix login", "TODO")] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick(null));
  assert.equal(calls[0].args.text, "Pick where it goes first, then press Move.");
  await send("/slack/interactions", moveClick(null, "move:cancel"));
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("a move stands without its reaction, and a thread that's gone can't be moved", async (t) => {
  let calls = mockSlack(t, { ...moveSlack(), "reactions.add": { ok: false, error: "already_reacted" }, stored: [devTask("100.1", "Fix login", "TODO")] });
  const responses = recordResponses(t);
  await send("/slack/interactions", moveClick("100.1"));
  assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 2);
  assert.deepEqual(responses.at(-1), { response_type: "ephemeral", delete_original: true });

  calls = mockSlack(t, { "conversations.replies": { ok: false, error: "message_not_found" }, stored: [devTask("100.1", "Fix login", "TODO")] });
  await send("/slack/events", moveEvent());
  assert.equal(calls.at(-1).args.text, "I can only move people's messages.");
});

// `@Cade move <link>`, replied in the stray message's thread. The task
// linked to is at TARGET.
const TARGET = "1700000000.000100";
const messageLink = (channel, ts, query = "") => `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}${query}`;

test("@Cade move with a link moves the message there straight away and acknowledges it", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask(TARGET, "Fix login", "IN_PROGRESS")] });
  await send("/slack/events", moveEvent({ text: `<@UBOT> move <${messageLink("CDEV", TARGET, `?thread_ts=${TARGET}&cid=CDEV`)}|link>` }));
  assert.deepEqual(
    calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.thread_ts),
    [TARGET, "100.7"],
  );
  assert.deepEqual(calls.at(-1).args, { channel: "CDEV", timestamp: "100.8", name: "white_check_mark" });
});

test("@Cade move with a link says why it can't move the message", async (t) => {
  for (const [stored, text] of [
    [[], "That link isn't to a task. Use Copy link on its message."],
    [[devTask(TARGET, "Fix login", "DONE")], "That task is done, so I didn't move anything."],
  ] as const) {
    const calls = mockSlack(t, { ...moveSlack(), stored });
    await send("/slack/events", moveEvent({ text: `<@UBOT> move <${messageLink("CDEV", TARGET)}>` }));
    assert.equal(calls.at(-1).args.text, text);
  }
});

// Choosing Cade's message shortcut `callbackId` (⋯ → More actions) on
// `message` in `channel`, a DM to begin with.
const shortcutClick = (callbackId: string, message: Record<string, unknown> = { ts: "500.1", user: "UBOB", text: "Customers can't pay\nsince the deploy" }, channel = "D0BOB") =>
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

const projectOptions = (view) => view.blocks[0].element.options.map((option) => [option.text.text, option.value]);

test("Make new task and Make new incident open their forms, with the project outside a dev channel", async (t) => {
  for (const [callbackId, callback] of [["convert", "track"], ["incident", "incident"]]) {
    let calls = mockSlack(t);
    await send("/slack/interactions", shortcutClick(callbackId));
    let { view } = calls[0].args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].block_id, "project");
    assert.deepEqual(projectOptions(view), [["acme", "CDEV"], ["test", "CTESTDEV"]]);
    assert.equal(view.blocks[1].element.initial_value, "Customers can't pay");
    const origin = JSON.parse(view.private_metadata);
    assert.equal(origin.channel, undefined);
    assert.deepEqual(origin.move, {
      channel: "D0BOB",
      ts: "500.1",
      threadTs: "500.1",
      author: "UBOB",
      text: "Customers can't pay\nsince the deploy",
      files: false,
      link: "https://acme.slack.com/archives/D0BOB/p5001?thread_ts=500.1&cid=D0BOB",
    });

    // In a dev channel, that channel's project is chosen.
    calls = mockSlack(t, moveSlack());
    await send("/slack/interactions", shortcutClick(callbackId, devStray, "CDEV"));
    ({ view } = calls.find((call) => call.method === "views.open").args);
    assert.equal(view.blocks[0].block_id, "project");
    assert.equal(view.blocks[0].element.initial_option.value, "CDEV");
    assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");
  }
});

test("a task made from a message anywhere goes to the chosen project, and the message is copied into it", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), "reactions.add": { ok: false, error: "channel_not_found" } });
  const opened = mockSlack(t);
  await send("/slack/interactions", shortcutClick("convert"));
  const { view } = opened[0].args;
  const all = mockSlack(t, { ...moveSlack(), "chat.postMessage": (args) => (args.channel === "D0BOB" ? { ok: false, error: "channel_not_found" } : moveSlack()["chat.postMessage"](args)) });

  // Without a project, the form says to choose one.
  const values = (project) => ({
    ...(project && { project: { value: { selected_option: { value: project } } } }),
    title: { value: { value: "Payments down" } },
    due_date: { value: { selected_date: null } },
    priority: { value: { selected_option: { value: "High" } } },
  });
  const submit = (project) =>
    send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "track", private_metadata: view.private_metadata, state: { values: values(project) } } }));
  const refused = await (await submit(null)).json();
  assert.deepEqual(refused, { response_action: "errors", errors: { project: "Please choose a project." } });

  await submit("CTESTDEV");
  const posts = all.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.channel, call.args.thread_ts, call.args.text]);
  assert.deepEqual(posts.slice(0, 2), [
    ["CTESTDEV", undefined, "High task: Payments down"],
    ["CTESTDEV", "100.1", "Moved from <@UBOB>'s <https://acme.slack.com/archives/D0BOB/p5001?thread_ts=500.1&cid=D0BOB|message>:\n> Customers can't pay\n> since the deploy"],
  ]);
  // Cade isn't in the DM, so the note under the original is tried and the
  // task stands without it.
  assert.deepEqual(posts[2].slice(0, 2), ["D0BOB", "500.1"]);
  assert.ok((await savedTask("CTESTDEV")).title, "Payments down");
  assert.equal(calls.length, 0);
});

test("Make new incident reports an urgent incident in the dev channel, labelled on its card", async (t) => {
  const calls = mockSlack(t, moveSlack());
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "incident",
        private_metadata: JSON.stringify({ channel: "CDEV", move: { channel: "CDEV", ts: "100.7" } }),
        state: { values: { title: { value: { value: "Checkout is down" } } } },
      },
    }),
  );
  const card = calls.find((call) => call.method === "chat.postMessage" && !call.args.thread_ts).args;
  assert.equal(card.text, "Urgent incident: Checkout is down");
  assert.equal(allBlocks(card)[0].text.text, "[URGENT] [Incident] *Checkout is down*");
  assert.equal(statusLine(card), ":memo: To do  ·  Due Immediate");
  assert.match(footerLines(card)[1], /^Reported by <@UACTOR>$/);
  const task = await savedTask();
  assert.deepEqual([task.incident, task.priority, task.dueDate], [true, "Urgent", "Immediate"]);
  const notes = calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.7");
  assert.match(notes[0].args.text, /moved this message to the incident thread/);
});

test("Move to existing outside a dev channel asks for the project, then lists its open tasks", async (t) => {
  const stored = [devTask("100.1", "Fix login", "IN_PROGRESS"), devTask("100.3", "Checkout is down", "TODO", { incident: true })];
  let calls = mockSlack(t, { stored });
  await send("/slack/interactions", shortcutClick("move"));
  let { view } = calls[0].args;
  assert.equal(view.callback_id, "move:form");
  // Two projects: none is picked, so there are no tasks to choose yet.
  assert.equal(view.blocks[0].dispatch_action, true);
  assert.equal(view.blocks[0].element.action_id, "move:project");
  assert.equal(view.blocks[0].element.initial_option, undefined);
  assert.equal(blockText(view.blocks[1]), "Choose a project to see its open tasks.");

  // Choosing a project lists its open tasks, incidents included.
  calls = mockSlack(t, { stored });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UACTOR" },
      view: { id: "V1", hash: "H1", private_metadata: view.private_metadata, state: { values: { project: { "move:project": { selected_option: { value: "CDEV" } } } } } },
      actions: [{ action_id: "move:project", selected_option: { value: "CDEV" } }],
    }),
  );
  assert.equal(calls[0].method, "views.update");
  assert.deepEqual([calls[0].args.view_id, calls[0].args.hash], ["V1", "H1"]);
  ({ view } = calls[0].args);
  assert.equal(view.blocks[0].element.initial_option.value, "CDEV");
  assert.deepEqual(optionsOf(view.blocks[1].element), [
    ["To do · Incident · Checkout is down", "100.3"],
    ["In progress · Fix login", "100.1"],
  ]);

  // Moving copies the message from the DM into the task's thread.
  calls = mockSlack(t, { ...moveSlack(), stored });
  const values = { project: { "move:project": { selected_option: { value: "CDEV" } } }, target: { value: { selected_option: { value: "100.1" } } } };
  await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "move:form", private_metadata: view.private_metadata, state: { values } } }));
  const copy = calls.find((call) => call.method === "chat.postMessage").args;
  assert.deepEqual([copy.channel, copy.thread_ts], ["CDEV", "100.1"]);
  assert.match(copy.text, /^Moved from <@UBOB>'s <https:\/\/acme\.slack\.com\/archives\/D0BOB\/p5001\?thread_ts=500\.1&cid=D0BOB\|message>:/);

  // A project with no open tasks can't be moved to.
  const empty = await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "move:form", private_metadata: view.private_metadata, state: { values: { project: values.project } } } }));
  assert.deepEqual(await empty.json(), { response_action: "errors", errors: { project: "Choose a project with open tasks." } });
});

test("with only one group, the shortcuts anywhere choose its project", async (t) => {
  const single = { ...env, PROJECTS: [{ name: "acme", channel: "CDEV" }] };
  for (const [callbackId, callback] of [["convert", "track"], ["incident", "incident"]]) {
    const calls = mockSlack(t);
    await send("/slack/interactions", shortcutClick(callbackId), {}, single);
    const { view } = calls[0].args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].element.initial_option.value, "CDEV", callbackId);
    assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");
  }

  // Move to existing lists the group's open tasks straight away.
  let calls = mockSlack(t, { stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  await send("/slack/interactions", shortcutClick("move"), {}, single);
  const { view } = calls[0].args;
  assert.equal(view.blocks[0].block_id, "target");
  assert.deepEqual(optionsOf(view.blocks[0].element), [["In progress · Fix login", "100.1"]]);
  assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");

  // With nothing open, it says so instead of opening the form.
  calls = mockSlack(t);
  const responses = recordResponses(t);
  await send("/slack/interactions", shortcutClick("move"), {}, single);
  assert.ok(!calls.some((call) => call.method === "views.open"));
  assert.match(responses[0].text, /There are no open tasks there/);
});

test("Move to existing in a dev channel lists that channel's open tasks, without the project", async (t) => {
  const calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "IN_PROGRESS")] });
  await send("/slack/interactions", shortcutClick("move", devStray, "CDEV"));
  const { view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(view.blocks[0].block_id, "target");
  assert.deepEqual(optionsOf(view.blocks[0].element), [["In progress · Fix login", "100.1"]]);
  assert.equal(JSON.parse(view.private_metadata).channel, "CDEV");
});

test("Message shortcuts in a dev channel say privately why they can't, without opening a form", async (t) => {
  for (const [callbackId, message, stored, text] of [
    ["move", { ...devStray, thread_ts: "100.1" }, [], /not replies in a thread/],
    ["convert", { ...devStray, ts: "100.1" }, [storedTask()], /already a task thread/],
    ["incident", devStray, [], /There are no open tasks|people's messages/],
    ["move", devStray, [], /There are no open tasks there/],
  ] as const) {
    const root = callbackId === "incident" ? { ...devStray, bot_id: "B1" } : devStray;
    const calls = mockSlack(t, { ...moveSlack(root), stored });
    const responses = recordResponses(t);
    await send("/slack/interactions", shortcutClick(callbackId, message, "CDEV"));
    assert.ok(!calls.some((call) => call.method === "views.open"), callbackId);
    assert.match(responses[0].text, text, callbackId);
  }
});

// Someone adding `reaction` to the message at `ts` in `channel`.
const reactionEvent = (reaction, ts = "100.7", channel = "CDEV", user = "UACTOR") =>
  JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UBOT" }],
    event: { type: "reaction_added", user, reaction, item: { type: "message", channel, ts } },
  });

test("🎫 and 🔀 on a message in a dev channel offer privately to track or move it", async (t) => {
  let calls = mockSlack(t, { ...moveSlack(), stored: [devTask("100.1", "Fix login", "TODO")] });
  await send("/slack/events", reactionEvent("twisted_rightwards_arrows"));
  assert.deepEqual(optionsOf(calls.at(-1).args.blocks[1].elements[0]), [["To do · Fix login", "100.1"]]);

  calls = mockSlack(t, moveSlack());
  await send("/slack/events", reactionEvent("ticket"));
  const offer = calls.at(-1).args;
  assert.equal(offer.text, "Shall I track this message as a task?");
  assert.equal(offer.blocks[1].elements[0].action_id, "move:track-task");

  // Elsewhere, and other emoji, are left alone.
  calls = mockSlack(t, moveSlack());
  await send("/slack/events", reactionEvent("ticket", "500.1", "CRANDOM"));
  await send("/slack/events", reactionEvent("thumbsup"));
  assert.equal(calls.length, 0);
});

// Clicks a button on the question about a message posted on its own.
const promptClick = (actionId) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    container: { is_ephemeral: true },
    trigger_id: "trigger-9",
    response_url: RESPONSE_URL,
    actions: [{ action_id: actionId, value: JSON.stringify({ channel: "CDEV", ts: "100.7", title: "The login bug also hits SSO" }) }],
  });

test("a message posted on its own in a dev channel is asked whether it's a task, an incident or part of one", async (t) => {
  for (const [stored, buttons] of [
    [[devTask("100.1", "Fix login", "IN_PROGRESS")], ["New task", "New incident", "Move to existing", "Not now"]],
    [[devTask("100.1", "Fix login", "DONE")], ["New task", "New incident", "Not now"]],
  ] as const) {
    const calls = mockSlack(t, { stored });
    await send("/slack/events", threadEvent("The login bug also hits SSO", { ts: "100.7", thread_ts: undefined }));
    assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
    const question = calls[0].args;
    assert.equal(question.text, "Is this a new task, a new incident, or part of an existing one?");
    assert.deepEqual(question.blocks[1].elements.map((button) => button.text.text), buttons);
  }
});

test("with suggestions off, a message posted on its own is still asked about; others aren't", async (t) => {
  let calls = mockSlack(t);
  await send("/slack/events", threadEvent("hi", { ts: "100.7", thread_ts: undefined }), {}, { ...env, TASK_CHANGE_DETECTION: "false" });
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);

  calls = mockSlack(t);
  await send("/slack/events", threadEvent("deploying now", { channel: "CRANDOM", ts: "500.1", thread_ts: undefined }));
  await send("/slack/events", threadEvent("done", { ts: "100.7", thread_ts: undefined, bot_id: "BOTHER" }));
  await send("/slack/events", threadEvent("edited", { ts: "100.7", thread_ts: undefined, subtype: "message_changed" }));
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("newTaskDetection false stops the question about a message posted on its own, for one project or every one", async (t) => {
  const post = (environment) => send("/slack/events", threadEvent("hi", { ts: "100.7", thread_ts: undefined }), {}, environment);
  const projects = (settings) => ({ ...env, PROJECTS: (env.PROJECTS as Project[]).map((project) => (project.name === "acme" ? { ...project, ...settings } : project)) });
  for (const [environment, asked] of [
    [env, true],
    [projects({ newTaskDetection: false }), false],
    [{ ...env, NEW_TASK_DETECTION: "off" }, false],
    [{ ...projects({ newTaskDetection: true }), NEW_TASK_DETECTION: "off" }, true],
  ] as const) {
    const calls = mockSlack(t);
    await post(environment);
    assert.equal(calls.some((call) => call.method === "chat.postEphemeral"), asked);
  }
  // Messages in other threads and the other project are unaffected.
  const calls = mockSlack(t);
  await send("/slack/events", threadEvent("hi", { channel: "CTESTDEV", ts: "100.7", thread_ts: undefined }), {}, projects({ newTaskDetection: false }));
  assert.ok(calls.some((call) => call.method === "chat.postEphemeral"));
});

test("Track as task and Report incident open their forms, named from the message", async (t) => {
  for (const [actionId, callback] of [["move:track-task", "track"], ["move:report-incident", "incident"]]) {
    const calls = mockSlack(t);
    const responses = recordResponses(t);
    await send("/slack/interactions", promptClick(actionId));
    const { view } = calls.find((call) => call.method === "views.open").args;
    assert.equal(view.callback_id, callback);
    assert.equal(view.blocks[0].element.initial_option.value, "CDEV");
    assert.equal(view.blocks[1].element.initial_value, "The login bug also hits SSO");
    assert.deepEqual(JSON.parse(view.private_metadata), {
      channel: "CDEV",
      move: { channel: "CDEV", ts: "100.7" },
      title: "The login bug also hits SSO",
    });
    assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
  }
});

test("Move to existing opens the shortcut's form, and Not now removes the question", async (t) => {
  const stored = [devTask("100.1", "Fix login", "IN_PROGRESS")];
  let calls = mockSlack(t, { stored });
  const responses = recordResponses(t);
  await send("/slack/interactions", promptClick("move:existing"));
  const { view, trigger_id } = calls.find((call) => call.method === "views.open").args;
  assert.equal(trigger_id, "trigger-9");
  assert.equal(view.callback_id, "move:form");
  // The channel's project, so no project picker.
  assert.equal(view.blocks[0].block_id, "target");
  assert.deepEqual(optionsOf(view.blocks[0].element), [["In progress · Fix login", "100.1"]]);
  assert.equal(blockText(view.blocks[1]), "The login bug also hits SSO");
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);

  // Moving reads the message from the channel and copies it in.
  calls = mockSlack(t, { ...moveSlack(), stored });
  await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "move:form", private_metadata: view.private_metadata, state: { values: { target: { value: { selected_option: { value: "100.1" } } } } } } }));
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => call.args.thread_ts);
  assert.deepEqual(posts, ["100.1", "100.7"]);

  // With everything closed since, the question says so instead.
  calls = mockSlack(t, { stored: [devTask("100.1", "Fix login", "DONE")] });
  const later = recordResponses(t);
  await send("/slack/interactions", promptClick("move:existing"));
  assert.ok(!calls.some((call) => call.method === "views.open"));
  assert.match(later.at(-1).text, /^Everything here has been closed since/);

  await send("/slack/interactions", promptClick("move:dismiss"));
  assert.deepEqual(later.at(-1), { response_type: "ephemeral", delete_original: true });
});

test("a task tracked from a message takes the message into its thread", async (t) => {
  const calls = mockSlack(t, moveSlack());
  await send(
    "/slack/interactions",
    interaction(submission({ title: "SSO login", priority: "High" }, { channel: "CDEV", move: { channel: "CDEV", ts: "100.7" } })),
  );
  const posts = calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.thread_ts, call.args.text]);
  assert.equal(posts[0][1], "High task: SSO login");
  assert.deepEqual(posts.slice(1), [
    ["100.1", "Moved from <@UACTOR>'s <https://slack.example/100.7?thread_ts=100.7&cid=CDEV|message>:\n> The login bug also hits SSO\n> for some people"],
    ["100.7", "<@UCREATOR> moved this message to the task thread <https://slack.example/100.9|SSO login>. Please carry on the conversation there."],
  ]);
});

// `@Cade <kind>` replied in the thread of the stray message.
const startEvent = (kind, threadTs = "100.7") => threadEvent(`<@UBOT> ${kind}`, { ts: "100.8", thread_ts: threadTs });

test("@Cade task and @Cade incident in a message's thread offer to start one from it", async (t) => {
  for (const [kind, question, button, actionId] of [
    ["task", "Shall I track this message as a task?", "New task", "move:track-task"],
    ["incident", "Shall I report an incident from this message?", "New incident", "move:report-incident"],
  ] as const) {
    const calls = mockSlack(t, moveSlack());
    await send("/slack/events", startEvent(kind));
    assert.deepEqual(calls.map((call) => call.method), ["conversations.replies", "chat.postEphemeral"], kind);
    const offer = calls[1].args;
    assert.equal(offer.thread_ts, "100.7", kind);
    assert.equal(offer.text, question, kind);
    const [start, dismiss] = offer.blocks[1].elements;
    assert.deepEqual([start.text.text, start.action_id, dismiss.action_id], [button, actionId, "move:dismiss"], kind);
    assert.deepEqual(JSON.parse(start.value), { channel: "CDEV", ts: "100.7", title: "The login bug also hits SSO" }, kind);
  }

  // A task's own thread isn't a message to start one from.
  const calls = mockSlack(t, { ...moveSlack(), stored: [storedTask()] });
  await send("/slack/events", startEvent("incident", "100.1"));
  assert.equal(calls.at(-1).args.text, "This is already a task thread.");
});

test("@Cade task and @Cade incident at the top of the dev channel point to replying in a thread", async (t) => {
  for (const kind of ["task", "incident"]) {
    const calls = mockSlack(t);
    await send("/slack/events", threadEvent(`<@UBOT> ${kind}`, { ts: "100.7", thread_ts: undefined }));
    assert.equal(
      calls[0].args.text,
      `To start one from a message, reply \`@Cade ${kind}\` in its thread, or use \`/cade ${kind}\` for something new.`,
    );
  }
});

test("/cade incident opens a form that asks only what the incident is, in a dev channel", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/commands", slash("incident", "CDEV"));
  const { view } = calls[0].args;
  assert.equal(view.callback_id, "incident");
  assert.deepEqual(JSON.parse(view.private_metadata), { channel: "CDEV" });
  assert.deepEqual(view.blocks.map((block) => block.block_id ?? block.type), ["project", "title", "context"]);

  // An incident needs a description.
  const response = await send(
    "/slack/interactions",
    interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "incident", private_metadata: view.private_metadata, state: { values: { title: { value: { value: " " } } } } } }),
  );
  assert.deepEqual(await response.json(), { response_action: "errors", errors: { title: "Please tell us what's going on." } });
});

test("an incident's priority and due date can't be changed, and its Edit form leaves them out", async (t) => {
  for (const text of ["<@UBOT> priority low", "<@UBOT> due 15/12/2026"]) {
    const calls = mockSlack(t, { stored: [incidentTask()] });
    await send("/slack/events", threadEvent(text));
    assert.equal(calls.at(-1).args.text, "Incidents are always :red_circle: Urgent and due Immediate, so I can't change their priority or due date.");
  }
  const calls = mockSlack(t, { stored: [incidentTask()] });
  await send("/slack/interactions", cardMenuClick("edit"));
  const form = calls[0].args.view;
  assert.deepEqual(form.blocks.map((block) => block.block_id ?? block.type), ["owner", "reviewer", "tester", "status", "context", "blocked", "blocked_reason"]);
  assert.match(blockText(form.blocks[4]), /Incidents are always :red_circle: Urgent and due Immediate/);
});

// A task in `status`, with `people` in its roles.
const taskWith = (status, people = {}) => {
  const record = storedTask(people);
  record.task.status = status;
  return record;
};

const ephemeral = (calls) => calls.find((call) => call.method === "chat.postEphemeral" && !drafts([call]).length)?.args;
// The private question about changes, not the note that a pasted PR was linked (see linkPasted).
const suggestion = (calls) => calls.find((call) => call.method === "chat.postEphemeral" && call.args.text.startsWith("Should I update"))?.args;
// That note.
const linkedNote = (calls) => calls.find((call) => call.method === "chat.postEphemeral" && call.args.text.startsWith("I linked"))?.args;
// What its OK and Unlink carry: the task, the PRs, and what to suggest once clicked.
const noteValue = (calls) => JSON.parse(linkedNote(calls).blocks[1].elements[0].value);

// The suggestion's Accept, Edit… and Reject, above the line saying where to turn suggestions off.
const suggestionButtons = (question) => question.blocks.find((block) => block.type === "actions").elements;

// The changes Cade's private suggestion would make, as its Accept button
// carries them (see changes.js).
const suggestedChanges = (question) => JSON.parse(suggestionButtons(question)[0].value).changes;
const add = (...ids) => ({ add: ids, remove: [] });

// Clicks the suggestion `question`'s button `index`: 0 Accept, 1 Edit…, 2 Reject.
const answerSuggestion = (question, index = 0, user = "UACTOR") => {
  const button = suggestionButtons(question)[index];
  return interaction({
    type: "block_actions",
    user: { id: user },
    channel: { id: "CDEV" },
    trigger_id: "T1",
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: button.action_id, value: button.value }],
  });
};

// A suggestion read by AI: `text` sent in the task's thread, with the model answering `raw` (see
// aiRead). Resolves to the calls made and the private question asked, if any.
// `record` is the task, or the task and others stored with it, such as its subtasks.
const aiSuggestion = async (t, text, record, raw, { user = "UACTOR", settings = {} } = {}) => {
  const { environment, asked } = aiEnv(aiRead(raw));
  const calls = mockSlack(t, { stored: [record].flat() });
  await send("/slack/events", threadReply(text, { user }), {}, { ...environment, ...settings });
  return { calls, question: ephemeral(calls), asked };
};

test("a suggestion moving the task to In review or In testing with no one in that role says so under it, and accepting it asks nothing more", async (t) => {
  const line = (question) => question.blocks.find((block) => block.type === "context" && !blockText(block).startsWith("Don't want these"));
  for (const [label, record, raw, expected] of [
    ["no reviewer", taskWith("IN_PROGRESS"), { status: "IN_REVIEW" }, "No one is reviewing this yet. Add a reviewer with Edit…, so they're asked."],
    ["no tester", taskWith("IN_REVIEW", { reviewers: ["UACTOR"] }), { status: "IN_TESTING" }, "No one is testing this yet. Add a tester with Edit…, so they're asked."],
    // Someone there, or suggested, or a stage that waits on no one.
    ["a reviewer", taskWith("IN_PROGRESS", { reviewers: ["UMIA"] }), { status: "IN_REVIEW" }, undefined],
    ["one suggested", taskWith("IN_PROGRESS"), { status: "IN_REVIEW", reviewer: { add: ["UMIA"], remove: [] } }, undefined],
  ] as const) {
    const text = label === "one suggested" ? "<@UMIA> ready for review, can you review?" : label === "no tester" ? "lgtm" : "ready for review";
    const { question } = await aiSuggestion(t, text, record, raw);
    assert.ok(question, label);
    assert.equal(line(question) && blockText(line(question)), expected, label);
  }

  // Accepting it moves the task, and asks for no one privately again: the line said so.
  const { calls, question } = await aiSuggestion(t, "ready for review", taskWith("IN_PROGRESS"), { status: "IN_REVIEW" });
  calls.length = 0;
  recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  assert.equal((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("saving the Edit form into In review with no reviewer asks nothing more: the form shows who's missing", async (t) => {
  const calls = mockSlack(t, { stored: [taskWith("IN_PROGRESS")] });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "task:edit",
        private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", details: false }),
        state: { values: { owner: { value: { selected_users: [] } }, reviewer: { value: { selected_users: [] } }, tester: { value: { selected_users: [] } }, status: { value: { selected_option: { value: "IN_REVIEW" } } } } },
      },
    }),
  );
  assert.equal((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postEphemeral"));
});

test("a suggestion asks whoever wrote the message, privately, with Accept, Edit… and Reject", async (t) => {
  const { question } = await aiSuggestion(t, "<@UMIA> can you review this? cc <@UREX>", taskWith("IN_PROGRESS", { reviewers: ["URIA"] }), { reviewer: add("UMIA") });
  assert.equal(question.user, "UACTOR");
  assert.equal(question.thread_ts, "100.1");
  assert.equal(question.text, "Should I update the task? From your message:");
  assert.equal(question.blocks[1].text.text, "*Reviewers:* <@UMIA> (Add)");
  assert.deepEqual(suggestedChanges(question), { people: { reviewer: add("UMIA") } });
  assert.deepEqual(suggestionButtons(question).map((button) => button.text.text), ["Accept", "Edit…", "Reject"]);
});

test("suggestions turned off in Settings aren't offered to that person, nor their messages read with AI, until turned on", async (t) => {
  const { environment, asked } = aiEnv(aiRead({ reviewer: add("UMIA") }));
  const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored: [taskWith("IN_PROGRESS")] });
  const turn = async (on: boolean) => {
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UACTOR" }, actions: [{ action_id: "home:suggestions", value: JSON.stringify({ on }) }] }), {}, environment);
    const view = calls.filter((call) => call.method === "views.publish").at(-1).args.view;
    assert.equal(view.private_metadata, "configure", "Configure is drawn again");
    return view.blocks.find((block) => block.accessory?.action_id === "home:suggestions");
  };
  const questions = () => calls.filter((call) => call.method === "chat.postEphemeral").length;

  const off = await turn(false);
  assert.match(blockText(off), /\*Suggestions\*\n:x: Off for you/);
  assert.equal(off.accessory.text.text, "Turn on");
  assert.deepEqual(JSON.parse(off.accessory.value), { on: true });
  await send("/slack/events", threadReply("<@UMIA> can you review this?", { user: "UACTOR" }), {}, environment);
  assert.equal(questions(), 0);
  assert.equal(asked.length, 0, "the model isn't asked");
  // Someone else still gets theirs.
  await send("/slack/events", threadReply("<@UMIA> can you review this?", { user: "UOTHER", ts: "100.6" }), {}, environment);
  assert.equal(questions(), 1);

  const on = await turn(true);
  assert.match(blockText(on), /\*Suggestions\*\n:white_check_mark: On/);
  assert.equal(on.accessory.text.text, "Turn off");
  await send("/slack/events", threadReply("<@UMIA> can you review this?", { user: "UACTOR", ts: "100.7" }), {}, environment);
  assert.equal(questions(), 2);
  // Each question says where to turn them off.
  assert.match(blockText(calls.filter((call) => call.method === "chat.postEphemeral").at(-1).args.blocks.at(-1)), /Home tab → Settings → Suggestions/);
});

test("three rejects in a row offer to turn suggestions off: Accept or Edit… starts the count again, Keep them stops it for 30 days", async (t) => {
  const { environment } = aiEnv(aiRead({ reviewer: add("UMIA") }));
  const calls = mockSlack(t, { stored: [taskWith("IN_PROGRESS")] });
  let ts = 100.5;
  // A message from UACTOR, and the private question it gets, or undefined.
  const suggest = async () => {
    const before = calls.length;
    await send("/slack/events", threadReply("<@UMIA> can you review this?", { user: "UACTOR", ts: String((ts += 0.1).toFixed(1)) }), {}, environment);
    return calls.slice(before).find((call) => call.method === "chat.postEphemeral")?.args;
  };
  // Clicks the question's button `index` (0 Accept, 1 Edit…, 2 Reject), or a button of the offer by its label; returns what replaced it.
  const click = async (button) => {
    const before = calls.length;
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UACTOR" }, channel: { id: "CDEV" }, trigger_id: "T1", response_url: RESPONSE_URL, actions: [{ action_id: button.action_id, value: button.value }] }), {}, environment);
    return calls.slice(before).find((call) => call.method === "respond")?.args;
  };
  const reject = async () => click(suggestionButtons(await suggest())[2]);
  const offerButton = (offer, label) => suggestionButtons(offer).find((button) => button.text.text === label);

  // Two rejects, then an Edit…: it starts the count again (Accept does too, in the next test).
  assert.equal((await reject()).delete_original, true);
  assert.equal((await reject()).delete_original, true);
  await click(suggestionButtons(await suggest())[1]);
  assert.equal((await reject()).delete_original, true);
  assert.equal((await reject()).delete_original, true);
  // The third in a row: the suggestion becomes the offer.
  const offer = await reject();
  assert.equal(offer.replace_original, true);
  assert.match(offer.text, /turned down my last 3 suggestions/);
  assert.deepEqual(suggestionButtons(offer).map((button) => button.text.text), ["Turn off", "Keep them"]);
  assert.match(blockText(offer.blocks.at(-1)), /Home tab → Settings → Suggestions/);

  // Keep them: no offer for the next rejects, and suggestions stay on.
  assert.match((await click(offerButton(offer, "Keep them"))).text, /won't ask about this for 30 days/);
  for (let i = 0; i < 4; i++) assert.equal((await reject()).delete_original, true);
  // Thirty days on, the count runs again.
  await DB.prepare("UPDATE user_preferences SET rejects_paused_until = datetime('now', '-1 minute') WHERE user_id = 'UACTOR'").run();
  await reject();
  await reject();
  const again = await reject();
  assert.equal(again.replace_original, true);

  // Turn off: the same switch as Settings, so the next message gets no question.
  assert.match((await click(offerButton(again, "Turn off"))).text, /won't suggest changes from your messages/);
  assert.equal(await suggest(), undefined);
});

test("accepting a suggestion starts the count of rejects in a row again", async (t) => {
  const { environment } = aiEnv(aiRead({ reviewer: add("UMIA") }));
  mockSlack(t, { stored: [taskWith("IN_PROGRESS")] });
  await DB.prepare("INSERT INTO user_preferences (user_id, suggestion_rejects) VALUES ('UACTOR', 2)").run();
  const before = lastCalls.length;
  await send("/slack/events", threadReply("<@UMIA> can you review this?", { user: "UACTOR" }), {}, environment);
  const question = lastCalls.slice(before).find((call) => call.method === "chat.postEphemeral").args;
  await send("/slack/interactions", answerSuggestion(question, 0, "UACTOR"), {}, environment);
  assert.equal((await DB.prepare("SELECT suggestion_rejects FROM user_preferences WHERE user_id = 'UACTOR'").first()).suggestion_rejects, 0);
});

test("Accept applies the suggestion and tells the thread who changed what", async (t) => {
  const record = () => taskWith("IN_REVIEW", { reviewers: ["URIA"], testers: ["UTOM"] });
  const { question } = await aiSuggestion(t, "<@UTESS> please test it", record(), { tester: add("UTESS"), status: "IN_TESTING" });

  const calls = mockSlack(t, { ...slackUsers, stored: [record()] });
  const sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  const saved = await savedTask();
  assert.deepEqual(saved.people.tester, ["UTOM", "UTESS"]);
  assert.equal(saved.status, "IN_TESTING");
  const post = calls.filter((call) => call.method === "chat.postMessage" && call.args.channel === "CDEV").at(-1).args;
  assert.equal(post.thread_ts, "100.1");
  assert.equal(post.text, ["<@UACTOR> assigned <@UTESS> as tester.", "<@UACTOR> set the status to :test_tube: In testing."].join("\n"));
  // Tess was mentioned in the message, so is named and not asked again; moving to In testing means
  // asking the other testers, offered to whoever accepted it.
  assert.deepEqual(drafts(calls), ["<@UTOM>, could you give this a test?"]);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("someone who assigns or removes themselves is named as themselves, and isn't asked anything", async (t) => {
  // Commands only get a ✅, and whoever else is asked.
  for (const [text, record, reply] of [
    ["<@UBOT> assign owner <@UACTOR>", storedTask(), undefined],
    [
      "<@UBOT> assign owner <@UACTOR> <@UBOB>",
      storedTask(),
      "<@UBOB>, could you pick this up?",
    ],
    ["<@UBOT> unassign owner <@UACTOR>", storedTask({ owners: ["UACTOR"] }), undefined],
    ["<@UBOT> unassign <@UACTOR>", storedTask({ owners: ["UACTOR"] }), undefined],
  ] as const) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadEvent(text));
    assert.equal(drafts(calls)[0], reply, text);
  }

  // Accepting "started working on this" makes the writer an owner, and
  // asks no one.
  const { question } = await aiSuggestion(t, "okay, started working on this", taskWith("TODO"), { owner: add("UACTOR"), status: "IN_PROGRESS" });
  let calls = mockSlack(t, { stored: [taskWith("TODO")] });
  recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  const post = calls.filter((call) => call.method === "chat.postMessage").at(-1).args;
  assert.equal(post.text, "<@UACTOR> assigned themselves as owner.\n<@UACTOR> set the status to :arrow_forward: In progress.");

  // A tester who moves it to In testing isn't asked to test it.
  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { testers: ["UACTOR", "UTOM"] })] });
  await send("/slack/events", threadEvent("<@UBOT> status in testing"));
  assert.deepEqual(drafts(calls), ["<@UTOM>, could you give this a test?"]);
});

test("Edit… on a suggestion opens the task's Edit form, filled in with it", async (t) => {
  const { question } = await aiSuggestion(t, "<@UMIA> can you review this?", taskWith("IN_REVIEW", { reviewers: ["URIA"] }), { reviewer: add("UMIA") });
  const calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { reviewers: ["URIA"] })] });
  await send("/slack/interactions", answerSuggestion(question, 1));
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.callback_id, "task:edit");
  assert.deepEqual(form.blocks[1].element.initial_users, ["URIA", "UMIA"]);
});

test("Accept leaves a suggested status alone once the task has moved, and Reject changes nothing", async (t) => {
  const { question } = await aiSuggestion(t, "on it", taskWith("TODO", { owners: ["UACTOR"] }), { status: "IN_PROGRESS" });

  // Someone moved it to In review meanwhile.
  let calls;
  calls = mockSlack(t, { stored: [taskWith("IN_REVIEW", { owners: ["UACTOR"] })] });
  let sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question));
  assert.equal((await savedTask()).status, "IN_REVIEW");
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);

  calls = mockSlack(t, { stored: [taskWith("TODO", { owners: ["UACTOR"] })] });
  sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question, 2));
  assert.deepEqual(calls, []);
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("progressOptions reads the task, the writer and their words", async () => {
  const { progressOptions } = await import("../src/commands/status.ts");
  const task = (status, people = {}) => taskWith(status, people).task;
  const says = (text: string) => fake<PlainMessage>({ text });
  assert.deepEqual(progressOptions(task("IN_REVIEW", { reviewers: ["U1"] }), "U1", says("lgtm")), ["IN_TESTING"]);
  assert.deepEqual(progressOptions(task("IN_TESTING", { testers: ["U1"] }), "U1", says("lgtm")), ["DONE"]);
  assert.deepEqual(progressOptions(task("IN_PROGRESS", { owners: ["U1"] }), "U1", says("lgtm")), []);
  assert.deepEqual(progressOptions(task("DONE", { owners: ["U1"] }), "U1", says("done")), []);
});

// Paths that only run when something goes wrong, or at the edges.

test("the started intent asks nothing outside the paired channels", async (t) => {
  const calls = mockSlack(t);
  await send("/slack/events", threadReply("started working on this", { channel: "COTHER" }));
  assert.deepEqual(calls, []);
});

test("the Worker answers only POSTs to its routes, and needs the signing secret", async () => {
  const get = await worker.fetch(new Request("https://worker.example.net/slack/events"), env, context());
  assert.equal(get.status, 405);
  const missing = await worker.fetch(new Request("https://worker.example.net/nowhere", { method: "POST" }), env, context());
  assert.equal(missing.status, 404);
  await assert.rejects(
    worker.fetch(new Request("https://worker.example.net/slack/events", { method: "POST", body: "{}" }), { ...env, SLACK_SIGNING_SECRET: "" }, context()),
    /SLACK_SIGNING_SECRET is not configured/,
  );
});

test("events other than messages, and interactions Cade has no handler for, are acknowledged and ignored", async (t) => {
  const calls = mockSlack(t);
  const reaction = JSON.stringify({ type: "event_callback", authorizations: [{ user_id: "UBOT" }], event: { type: "reaction_added" } });
  assert.equal((await send("/slack/events", reaction)).status, 200);
  for (const payload of [
    { type: "view_closed", user: { id: "UACTOR" }, view: { callback_id: "track" } },
    { type: "block_actions", user: { id: "UACTOR" }, actions: [{ action_id: "nobody:knows" }] },
    { type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: "nobody:knows" } },
  ]) {
    assert.equal((await send("/slack/interactions", interaction(payload))).status, 200, payload.type);
  }
  assert.deepEqual(calls, []);
});

test("callSlack and respondLater report Slack's failures", async (t) => {
  const { callSlack, respondLater } = await import("../src/slack.ts");
  await assert.rejects(callSlack(fake({}), "chat.postMessage", {}), /SLACK_BOT_TOKEN is not configured/);
  const fetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetch;
  });
  globalThis.fetch = async () => new Response("down", { status: 503 });
  await assert.rejects(callSlack(env, "chat.postMessage", {}), /Slack chat.postMessage returned HTTP 503/);
  await assert.rejects(respondLater(RESPONSE_URL, { text: "hi" }), /response_url returned HTTP 503/);
  globalThis.fetch = async () => Response.json({ ok: false, error: "invalid_blocks" });
  await assert.rejects(respondLater(RESPONSE_URL, { text: "hi" }), /refused the message: invalid_blocks/);
  // A plain "ok" reply is fine.
  globalThis.fetch = async () => new Response("ok", { headers: { "content-type": "text/plain" } });
  await respondLater(RESPONSE_URL, { text: "hi" });
});

test("choosing reviewers whose PR list didn't fit asks about all the task's PRs", async (t) => {
  const root = storedTask({ status: "IN_REVIEW" });
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "UCLICKER" },
      channel: { id: "CDEV" },
      message: { ts: "100.8", thread_ts: "100.1" },
      actions: [{ action_id: "pr:reviewers", block_id: "not json", selected_users: ["URIA"] }],
    }),
  );
  assert.equal(
    calls.findLast((call) => call.method === "chat.postMessage").args.text,
    `<@UCLICKER> assigned <@URIA> as reviewer.`,
  );
  assert.deepEqual(drafts(calls), [`<@URIA>, could you review this?`]);
});

test("deleting copes with a thread that's gone and replies it can't delete", async (t) => {
  // The thread is gone, replies and all: the root still goes.
  let calls = mockSlack(t, { stored: [ownTask()], "conversations.replies": { ok: false, error: "thread_not_found" } });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts), ["100.1"]);

  // A reply that can't be deleted is passed over.
  calls = mockSlack(t, {
    stored: [ownTask()],
    "conversations.replies": { messages: [{ ts: "100.1", bot_id: "BCADE" }, { ts: "100.3", bot_id: "BOTHER" }] },
    "chat.delete": (args) => (args.ts === "100.3" ? { ok: false, error: "cant_delete_message" } : {}),
  });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.deepEqual(calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts), ["100.3", "100.1"]);

  // Reading the replies fails for another reason: nothing is deleted.
  calls = mockSlack(t, { stored: [ownTask()], "conversations.replies": { ok: false, error: "ratelimited" } });
  await send("/slack/interactions", deleteClick("delete:confirm", "UACTOR"));
  assert.ok(!calls.some((call) => call.method === "chat.delete"));
});

test("a standup step with more tasks than fit says how many more", async (t) => {
  const many = Array.from({ length: 23 }, (_, i) => historyTask(`100.${i + 10}`, { title: `Task ${i}`, owners: ["UALICE"] }));
  const { later } = await tasksCommand(t, "standup", "CDEV", { CDEV: many });
  assert.equal(later.blocks.at(-2).elements[0].text, "_…and 3 more, after these._");
});

// A canvas's markdown, from conversations.canvases.create or canvases.edit.
const canvasMarkdown = (call) =>
  call.method === "canvases.edit"
    ? JSON.parse(call.args.changes)[0].document_content.markdown
    : JSON.parse(call.args.document_content).markdown;

// The table rows of a summary's Open or Closed section, without their
// header and divider.
// The rows of a summary's `section`: Open, Closed or Archived.
const summaryRows = (markdown, section = "Open") =>
  markdown
    .split("\n## ")
    .find((part) => part.startsWith(`${section}\n`))
    .split("\n")
    .filter((line) => line.startsWith("| ") && !/^\| (Title|---) /.test(line))
    .map(unbroken);

// Short cells, such as priorities, are kept on one line with non-breaking
// spaces; shown here as `~`.
const unbroken = (row) => row.replace(/\u00a0/g, "~");

const canvasResponses = {
  ...slackUsers,
  "auth.test": { url: "https://acme.slack.com/" },
  "conversations.canvases.create": { canvas_id: "F0CANVAS" },
};
test("/cade resync summary puts the group's open tasks in the dev channel's canvas, most urgent first", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (const [channel, record] of [
    ["CDEV", historyTask("100.1", { title: "Low task", priority: "Low", owners: ["UALICE"] })],
    ["CDEV", historyTask("100.2", { title: "High | [later]", priority: "High", dueDate: "05/11/2026", reviewers: ["UBOB"] })],
    ["CDEV", historyTask("100.3", { title: "High, sooner", priority: "High", dueDate: "01/11/2026", status: "IN_PROGRESS" })],
    ["CDEV", historyTask("100.4", { title: "Done task", status: "DONE", completedAt: "2026-10-10T09:00:00.000Z" })],
    ["CDEV", historyTask("100.5", { title: "Done later", status: "DONE", completedAt: "2026-10-20T09:00:00.000Z", owners: ["UBOB"] })],
    ["CDEV", incidentHistoryTask("100.8", { title: "Checkout is down", testers: ["UALICE", "UBOB"] })],
  ] as const) await putTask(env, channel, record.ts, record.task);
  const { now, later } = await runTasksCommand("resync summary", "CDEV", env);

  assert.equal(now, "");
  assert.equal(later.text, "Added the summary to this channel's canvas. I'll keep it up to date. Only I can edit it.");
  // Read-only for the channel: Cade rewrites it on every change anyway.
  const lock = calls.find((call) => call.method === "canvases.access.set").args;
  assert.deepEqual(lock, { canvas_id: "F0CANVAS", access_level: "read", channel_ids: '["CDEV"]' });
  const create = calls.find((call) => call.method === "conversations.canvases.create");
  assert.equal(create.args.channel_id, "CDEV");
  assert.equal(create.args.title, "acme tasks");
  const markdown = canvasMarkdown(create);
  assert.match(markdown, /^_Updated \d\d\/\d\d\/\d{4} \d\d:\d\d\. Cade keeps this up to date\._\n\n## Open\n\n4 open, most urgent first\.\n\n/);
  assert.match(markdown, /\n\n---\n\n## Closed\n\nThe last 2 done, most recently first\.\n\n/);
  assert.ok(markdown.includes("| Title | Status | Priority | Due date | Owner | Reviewer | Tester |"));
  const thread = (channel, ts) =>
    `(https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}?thread_ts=${ts}&cid=${channel})`;
  assert.deepEqual(summaryRows(markdown), [
    `| \\[Incident\\] [Checkout is down]${thread("CDEV", "100.8")} | :memo:~To~do | :red_circle:~Urgent | Immediate | — | — | @Alice, @Bob |`,
    `| [High, sooner]${thread("CDEV", "100.3")} | :arrow_forward:~In~progress | :large_orange_circle:~High | 01/11/2026 | — | — | — |`,
    `| [High \\| \\[later\\]]${thread("CDEV", "100.2")} | :memo:~To~do | :large_orange_circle:~High | 05/11/2026 | — | @Bob | — |`,
    `| [Low task]${thread("CDEV", "100.1")} | :memo:~To~do | :large_green_circle:~Low | 31/10/2026 | @Alice | — | — |`,
  ]);
  // Done tasks follow, most recently done first.
  assert.deepEqual(summaryRows(markdown, "Closed"), [
    `| [Done later]${thread("CDEV", "100.5")} | :white_check_mark:~Done | :large_orange_circle:~High | 31/10/2026 | @Bob | — | — |`,
    `| [Done task]${thread("CDEV", "100.4")} | :white_check_mark:~Done | :large_orange_circle:~High | 31/10/2026 | — | — | — |`,
  ]);

  // Sent again, the same canvas is rewritten, with its title.
  calls.length = 0;
  const again = await runTasksCommand("resync summary", "CDEV", env);
  assert.equal(again.later.text, "Resynced the summary in this channel's canvas. Only I can edit it.");
  const edits = calls.filter((call) => call.method === "canvases.edit");
  assert.deepEqual(edits.map((call) => call.args.canvas_id), ["F0CANVAS", "F0CANVAS"]);
  assert.deepEqual(edits.map((call) => JSON.parse(call.args.changes)[0].operation), ["replace", "rename"]);
  assert.equal(JSON.parse(edits[1].args.changes)[0].title_content.markdown, "acme tasks");
  assert.ok(!calls.some((call) => call.method === "conversations.canvases.create"));
});

test("a summary write is skipped when the canvas would not change, but a full resync still writes", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  const record = historyTask("100.1", { title: "Low task", priority: "Low", owners: ["UALICE"] });
  await putTask(env, "CDEV", record.ts, record.task);
  await runTasksCommand("resync summary", "CDEV", env);

  calls.length = 0;
  const same = await writeSummary(env, "CDEV");
  assert.equal(same, "The summary in this channel's canvas is already up to date.");
  assert.ok(!calls.some((call) => call.method === "canvases.edit"));

  const changed = historyTask("100.2", { title: "New task", priority: "High" });
  await putTask(env, "CDEV", changed.ts, changed.task);
  await writeSummary(env, "CDEV");
  assert.equal(calls.filter((call) => call.method === "canvases.edit").length, 1);

  calls.length = 0;
  await writeSummary(env, "CDEV", { full: true });
  assert.equal(calls.filter((call) => call.method === "canvases.edit").length, 2);
});

test("the summary names people rather than mentioning them, with names kept from the first look-up", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  const record = historyTask("100.1", { title: "Low task", owners: ["UALICE"], reviewers: ["UBOB"] });
  await putTask(env, "CDEV", record.ts, record.task);
  await runTasksCommand("resync summary", "CDEV", env);
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  // A canvas mention notifies the person again on every write.
  assert.ok(!markdown.includes("![](@"));
  assert.match(summaryRows(markdown)[0], /\| @Alice \| @Bob \| — \|$/);
  assert.deepEqual(calls.filter((call) => call.method === "users.info").map((call) => call.args.user).sort(), ["UALICE", "UBOB"]);

  // Rewritten, the names come from the database, not Slack.
  calls.length = 0;
  await writeSummary(env, "CDEV", { full: true });
  assert.ok(calls.some((call) => call.method === "canvases.edit"));
  assert.ok(!calls.some((call) => call.method === "users.info"));
});

test("the summary uses the canvas the channel already has", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    "conversations.info": { channel: { id: "CDEV", properties: { canvas: { file_id: "F0THEIRS" } } } },
  });
  const fakeFetch = globalThis.fetch;
  // Slack won't let Cade change who can edit a canvas someone else made;
  // the summary goes in it all the same.
  globalThis.fetch = async (url, init) =>
    url.endsWith("/conversations.canvases.create")
      ? (await fakeFetch(url, init), Response.json({ ok: false, error: "channel_canvas_already_exists" }))
      : url.endsWith("/canvases.access.set")
        ? (await fakeFetch(url, init), Response.json({ ok: false, error: "no_permission" }))
        : fakeFetch(url, init);

  const { later } = await runTasksCommand("resync summary", "CDEV");
  assert.equal(later.text, "Added the summary to this channel's canvas. I'll keep it up to date.");
  const [edit, rename] = calls.filter((call) => call.method === "canvases.edit");
  assert.equal(edit.args.canvas_id, "F0THEIRS");
  assert.match(canvasMarkdown(edit), /No open tasks\.[\s\S]*No closed tasks yet\./);
  // It takes the summary's title.
  assert.equal(rename.args.canvas_id, "F0THEIRS");
  assert.equal(JSON.parse(rename.args.changes)[0].title_content.markdown, "acme tasks");

  // Saved, so it is used from now on.
  calls.length = 0;
  await runTasksCommand("resync summary", "CDEV");
  assert.equal(calls.find((call) => call.method === "canvases.edit").args.canvas_id, "F0THEIRS");
  assert.ok(!calls.some((call) => call.method === "conversations.canvases.create"));
});

test("/cade resync summary only works in a group's dev channel", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  const { now } = await runTasksCommand("resync summary", "CRANDOM");
  assert.equal(JSON.parse(now).text, "Send `/cade resync summary` in a group's dev channel, for its summary.");
  assert.ok(!calls.some((call) => /canvas/.test(call.method)));
});

test("a task change rewrites the summaries of its group that have one", async (t) => {
  const calls = mockSlack(t, { ...canvasResponses, stored: [storedTask()] });
  await runTasksCommand("resync summary", "CDEV");
  calls.length = 0;

  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  const edit = calls.find((call) => call.method === "canvases.edit");
  assert.equal(edit.args.canvas_id, "F0CANVAS");
  assert.match(summaryRows(canvasMarkdown(edit))[0], /^\| \[Fix login\]\(https:[^)]+\) \| :memo:~To~do \| :large_orange_circle:~High \| 31\/10\/2026 \| @Bob \|/);
});

test("a new task makes its group's summary canvas; other changes only rewrite one there is", async (t) => {
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));
  assert.ok(!calls.some((call) => /canvas|auth\.test/.test(call.method)));

  calls = mockSlack(t, { ...createdTask, ...canvasResponses });
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "High" })));
  const create = calls.find((call) => call.method === "conversations.canvases.create").args;
  assert.equal(create.channel_id, "CDEV");
  assert.match(canvasMarkdown({ args: create }), /\[Fix login\]/);
  assert.deepEqual(calls.find((call) => call.method === "canvases.access.set").args, { canvas_id: "F0CANVAS", access_level: "read", channel_ids: '["CDEV"]' });
});

test("a long summary continues in another table, as a canvas table holds 300 cells", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (let i = 0; i < 45; i++) {
    const record = historyTask(`100.${String(i).padStart(2, "0")}`, { title: `Task ${i}` });
    await putTask(env, "CDEV", record.ts, record.task);
  }
  await runTasksCommand("resync summary", "CDEV");
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  const tables = markdown.split("\n\n").filter((part) => part.startsWith("| Title"));
  assert.deepEqual(tables.map((part) => part.split("\n").length - 2), [41, 4]);
});

test("a summary's Closed section keeps the last 50 done", async (t) => {
  const calls = mockSlack(t, canvasResponses);
  for (let i = 0; i < 55; i++) {
    const record = historyTask(`100.${String(i).padStart(2, "0")}`, {
      title: `Done ${i}`,
      status: "DONE",
      completedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    });
    await putTask(env, "CDEV", record.ts, record.task);
  }
  await runTasksCommand("resync summary", "CDEV");
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  const closed = summaryRows(markdown, "Closed");
  assert.equal(closed.length, 50);
  assert.match(closed[0], /^\| \[Done 54\]/);
  assert.match(closed.at(-1), /^\| \[Done 5\]/);
  assert.match(markdown, /The last 50 done, most recently first\./);
});

// Clicks `actionId` on a private question, as posted or sent to a
// response_url, as UACTOR. Returns what was sent to its response_url.
async function answerPrivately(t, question, actionId, environment = env) {
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

test("moving a task to In review with no reviewer, or In testing with no tester, suggests whoever moved it assign one, with Edit… and Reject", async (t) => {
  for (const [status, record, note] of [
    ["review", storedTask(), "No one is reviewing this yet. Add a reviewer with Edit…, so they're asked."],
    ["testing", storedTask(), "No one is testing this yet. Add a tester with Edit…, so they're asked."],
    // Someone is there, or the stage waits on no one.
    ["review", storedTask({ reviewers: ["UMIA"] }), undefined],
    ["testing", storedTask({ testers: ["UTOM"] }), undefined],
    ["in progress", storedTask(), undefined],
  ] as const) {
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadEvent(`<@UBOT> status ${status}`));
    const asked = ephemeral(calls);
    assert.equal(asked?.text, note, `${status} ${JSON.stringify(record.task.people)}`);
    if (!asked) continue;
    assert.deepEqual([asked.user, asked.thread_ts], ["UACTOR", "100.1"]);
    // A suggestion with nothing to accept: the same buttons, but Accept.
    assert.deepEqual(suggestionButtons(asked).map((button) => [button.action_id, button.text.text]), [["ai-suggest:edit", "Edit…"], ["ai-suggest:reject", "Reject"]]);
    assert.equal(JSON.parse(suggestionButtons(asked)[0].value).changes && Object.keys(JSON.parse(suggestionButtons(asked)[0].value).changes).length, 0);
  }
});

test("Edit… on the assign-someone suggestion opens the task's Edit form as it stands, which removes it once saved; Reject removes it", async (t) => {
  const calls = mockSlack(t, { stored: [withStatus("IN_PROGRESS")] });
  await send("/slack/events", threadEvent("<@UBOT> status review"));
  const question = ephemeral(calls);
  const sent = recordResponses(t);
  await send("/slack/interactions", answerSuggestion(question, 0));
  const { view } = calls.find((call) => call.method === "views.open").args;
  assert.equal(view.callback_id, "task:edit");
  assert.deepEqual(JSON.parse(view.private_metadata), { channel: "CDEV", ts: "100.1", details: true, responseUrl: RESPONSE_URL });
  assert.deepEqual(view.blocks.find((block) => block.block_id === "reviewer").element.initial_users, undefined);

  await send("/slack/interactions", answerSuggestion(question, 1));
  assert.deepEqual(sent, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Client review asks the approver in the task's own thread", async (t) => {
  const record = ownTask({ owners: ["UDEV"] });
  record.task.status = "IN_TESTING";
  record.task.prs = [PR];
  let calls = await clientReview(t, { stored: [record] }, { approver: "UPM" });
  assert.equal((await savedTask()).status, "CLIENT_REVIEW");
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(form.blocks[0].element.initial_user, undefined);
  assert.equal(form.blocks[2].elements[0].text, "Posted in the task's thread with Approve and Not approve, which only they can click.");
  // The request is posted in the task's thread.
  const ask = calls.at(-1).args;
  assert.equal(calls.at(-1).method, "chat.postMessage");
  assert.equal(ask.channel, "CDEV");
  assert.equal(ask.thread_ts, "100.1");
  assert.equal(
    ask.blocks[0].text.text,
    `<@UACTOR> sent:\n<@UPM>, could you take a look and approve it, or let us know what needs to change?\n*PRs:* <${PR}|cade/42>`,
  );
  const [approve] = ask.blocks[1].elements;

  for (const [action, status, said] of [
    ["status:approve", "DONE", "<@UPM> approved this, so it's now :white_check_mark: Done."],
    ["status:reject", "IN_PROGRESS", "<@UPM> didn't approve this, so it's back to :arrow_forward: In progress. Have a look at the thread for what needs to change."],
  ] as const) {
    calls = mockSlack(t, { stored: [{ ...record, task: { ...record.task, status: "CLIENT_REVIEW" } }] });
    await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: "UPM" },
        channel: { id: "CDEV" },
        message: { ts: "100.8", thread_ts: "100.1" },
        actions: [{ action_id: action, value: approve.value }],
      }),
    );
    assert.equal((await savedTask()).status, status);
    const told = calls.find((call) => call.method === "chat.postMessage").args;
    assert.equal(told.thread_ts, "100.1");
    assert.equal(told.text, said);
    assert.equal(calls.at(-1).args.ts, "100.8");
    assert.ok(!calls.some((call) => call.method === "chat.getPermalink"));
  }
});

test("/cade resync <link> redraws a task's card, with its menu, and tells only whoever sent it", async (t) => {
  // A task at a timestamp a Slack link can name.
  const ts = "1700000000.000100";
  const task = { ...ownTask(), ts };
  task.task.link = "https://slack.example/p100";
  const calls = mockSlack(t, { stored: [task] });
  // A link to a reply in the task's thread stands for the task.
  const link = "https://acme.slack.com/archives/CDEV/p1700000000000500?thread_ts=1700000000.000100&amp;cid=CDEV";
  const { now, later } = await runTasksCommand(`resync <${link}>`, "COTHER");
  assert.equal(now, "");
  assert.equal(later.text, "Resynced the task <https://slack.example/p100|Fix login>.");
  const card = calls.find((call) => call.method === "chat.update" && call.args.ts === ts).args;
  assert.equal(cardMenu(card).action_id, "task:menu");
  assert.ok(!calls.some((call) => ["chat.postMessage", "chat.postEphemeral"].includes(call.method)));
});

test("/cade remove <link> asks privately, then removes what the link points at", async (t) => {
  // A task at a timestamp a Slack link can name.
  const ts = "1700000000.000100";
  const removing = (responses = {}) =>
    mockSlack(t, {
      stored: [{ ...ownTask(), ts }],
      "conversations.replies": { messages: [{ ts: "1700000000.000500", bot_id: "BCADE" }] },
      ...responses,
    });

  // The task's root: its card and Cade's replies, asked privately.
  let calls = removing();
  let { now, later } = await runTasksCommand("remove <https://acme.slack.com/archives/CDEV/p1700000000000100>", "COTHER");
  assert.equal(now, "");
  assert.match(later.text, /^<@UACTOR>, should I delete the task \*Fix login\*\?/);
  const [cancel, button] = later.blocks[1].elements;
  // Cancel is first and prominent; Delete is plain, and asks again.
  assert.deepEqual([cancel.action_id, cancel.style], ["delete:cancel", "primary"]);
  assert.deepEqual([button.action_id, button.style, Boolean(button.confirm)], ["delete:confirm", undefined, true]);
  assert.deepEqual(JSON.parse(button.value), { kind: "task", channel: "CDEV", ts });
  let responses = await answerPrivately(t, later, "delete:confirm");
  assert.equal(await savedTask("CDEV", ts), null);
  assert.deepEqual(responses, [{ response_type: "ephemeral", replace_original: true, text: "Done, it's gone." }]);

  // A reply: just that message.
  calls = removing();
  ({ later } = await runTasksCommand(
    "remove <https://acme.slack.com/archives/CDEV/p1700000000000900?thread_ts=1700000000.000100&cid=CDEV>",
    "COTHER",
  ));
  assert.equal(later.text, "<@UACTOR>, should I remove that message? There's no undo.");
  assert.equal(later.blocks[1].elements[1].text.text, "Delete message");
  responses = await answerPrivately(t, later, "delete:confirm");
  assert.deepEqual(calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts), ["1700000000.000900"]);
  assert.equal(responses[0].text, "Done, that message is gone.");
  assert.ok(await savedTask("CDEV", ts));

  // Someone else's reply stays.
  removing({ "chat.delete": { ok: false, error: "cant_delete_message" } });
  ({ later } = await runTasksCommand(
    "remove <https://acme.slack.com/archives/CDEV/p1700000000000900?thread_ts=1700000000.000100&cid=CDEV>",
    "COTHER",
  ));
  responses = await answerPrivately(t, later, "delete:confirm");
  assert.equal(responses[0].text, "I can only remove my own messages, so that one stays.");

  // Any other message: Cade's replies in its thread, and the message if it's
  // Cade's.
  calls = removing({
    "chat.delete": (args) => (args.ts === "1700000000.000700" ? { ok: false, error: "cant_delete_message" } : {}),
  });
  ({ later } = await runTasksCommand("remove <https://acme.slack.com/archives/CDEV/p1700000000000700>", "COTHER"));
  assert.equal(later.text, "<@UACTOR>, should I remove my messages in that thread? There's no undo.");
  responses = await answerPrivately(t, later, "delete:confirm");
  assert.deepEqual(calls.filter((call) => call.method === "chat.delete").map((call) => call.args.ts), ["1700000000.000500", "1700000000.000700"]);
  assert.equal(responses[0].text, "Done, my replies are gone. The message itself isn't mine, so it stays.");

  // Cancel just drops the question.
  removing();
  ({ later } = await runTasksCommand("remove <https://acme.slack.com/archives/CDEV/p1700000000000700>", "COTHER"));
  responses = await answerPrivately(t, later, "delete:cancel");
  assert.deepEqual(responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("/cade remove needs a link", async (t) => {
  mockSlack(t);
  const { now } = await runTasksCommand("remove", "CDEV");
  assert.match(JSON.parse(now).text, /^Paste the link to what to remove/);
});

test("/cade replace changes what one of Cade's messages says, from anywhere", async (t) => {
  const REPLY = "1700000000.000200";
  const link = `<${messageLink("CDEV", REPLY, "?thread_ts=1700000000.000100&cid=CDEV")}>`;
  for (const [text, said] of [
    [`replace ${link} "The *deposit* goes live on Friday, <@UBOB>"`, "The *deposit* goes live on Friday, <@UBOB>"],
    [`replace ${link} No quotes needed`, "No quotes needed"],
  ] as const) {
    const calls = mockSlack(t);
    const { now, later } = await runTasksCommand(text, "CRANDOM");
    assert.equal(now, "");
    const update = calls.find((call) => call.method === "chat.update").args;
    assert.deepEqual(update, {
      channel: "CDEV",
      ts: REPLY,
      text: said,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: said } }],
      attachments: [],
    });
    assert.equal(later.text, "Done, the message says that now.");
  }
});

test("/cade replace leaves task cards and other people's messages alone, and needs a link and text", async (t) => {
  // A task's card is drawn from the task.
  let calls = mockSlack(t, { stored: [devTask(TARGET, "Fix login", "TODO")] });
  let { later } = await runTasksCommand(`replace <${messageLink("CDEV", TARGET)}> New title`, "CDEV");
  assert.ok(!calls.some((call) => call.method === "chat.update"));
  assert.match(later.text, /^That's a task's card/);

  // Slack won't let Cade change someone else's message.
  calls = mockSlack(t, { "chat.update": { ok: false, error: "cant_update_message" } });
  ({ later } = await runTasksCommand(`replace <${messageLink("CDEV", TARGET)}> Hello`, "CDEV"));
  assert.equal(later.text, "I can only change my own messages, so that one stays as it is.");

  for (const text of ["replace", `replace <${messageLink("CDEV", TARGET)}>`, `replace <${messageLink("CDEV", TARGET)}> ""`, "replace just words"]) {
    mockSlack(t);
    const { now } = await runTasksCommand(text, "CDEV");
    assert.match(JSON.parse(now).text, /^Paste the link to my message, then what it should say/, text);
  }
});

// ---- Suggestions read with AI (see ai.js and ai-suggest.js) ----

// An environment with AI on, whose model answers `answer` (an object, as the
// changes it read) or throws it (an Error). The model's inputs are kept in
// `asked`.
function aiEnv(answer: unknown) {
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
const aiRead = (fields = {}) => ({
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

const aiClick = (button, extra = {}) =>
  interaction({
    type: "block_actions",
    user: { id: "UACTOR" },
    channel: { id: "CDEV" },
    trigger_id: "T1",
    container: { is_ephemeral: true },
    response_url: RESPONSE_URL,
    actions: [{ action_id: button.action_id, value: button.value }],
    ...extra,
  });

test("a task with subtasks only moves to DONE, and only for a message about the whole", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const people = { owner: [], reviewer: [], tester: [] };
  const allowed = { roles: [], status: true, details: false };
  const status = (task, text, to) => checkChanges(aiRead({ status: to }), { task, message: { user: "UACTOR", mentions: [], text }, allowed })?.status ?? null;
  const parts = { status: "IN_PROGRESS", people, subtaskCounts: { open: 1, closed: 1 } };
  assert.equal(status(parts, "we can close this as done", "DONE"), "DONE");
  assert.equal(status(parts, "all subtasks are done", "DONE"), "DONE");
  assert.equal(status(parts, "subtask 2 is done", "DONE"), null);
  assert.equal(status(parts, "backend merged, we're done here", "DONE"), null);
  assert.equal(status(parts, "everything is ready for review", "IN_REVIEW"), null);
  assert.equal(status(parts, "lgtm", "DONE"), null);
  // Work begun on any part starts the task, but only from TODO.
  assert.equal(status({ ...parts, status: "TODO" }, "started on subtask 1", "IN_PROGRESS"), "IN_PROGRESS");
  assert.equal(status(parts, "started on subtask 2", "IN_PROGRESS"), null);
  assert.equal(status({ ...parts, status: "TODO" }, "ready for review", "IN_REVIEW"), null);
  // Without subtasks the same words move it as before, even for a task the old "Has subtasks" box was
  // ticked on: only real subtasks make a task done in parts now.
  assert.equal(status({ ...parts, subtaskCounts: undefined }, "ready for review", "IN_REVIEW"), "IN_REVIEW");
  assert.equal(status({ ...parts, subtaskCounts: undefined, subtasks: true }, "ready for review", "IN_REVIEW"), "IN_REVIEW");
});

test("AI's changes are checked against the message and the task", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const task = fake<StoredTask>({ status: "IN_PROGRESS", priority: "High", dueDate: "31/10/2026", people: { owner: ["UBOB"], reviewer: [], tester: [] } });
  const message = fake<PlainMessage>({ user: "UACTOR", mentions: ["UREX", "UMIA"] });
  const allowed: Allowed = { roles: ["owner", "reviewer", "tester"], status: true, details: true };
  const raw = aiRead({
    // UZED wasn't mentioned, and UBOB is an owner already.
    owner: { add: ["UREX", "UZED", "UBOB"], remove: ["UMIA"] },
    reviewer: { add: ["UMIA", "UMIA"], remove: [] },
    tester: { add: [], remove: ["UTOM"] },
    status: "IN_REVIEW",
    priority: "High",
    dueDate: "2026-02-30",
  });
  assert.deepEqual(checkChanges(raw, { task, message, allowed }), {
    people: { owner: { add: ["UREX"], remove: [] }, reviewer: { add: ["UMIA"], remove: [] } },
    status: "IN_REVIEW",
  });
  assert.deepEqual(checkChanges(aiRead({ priority: "Urgent", dueDate: "2026-11-06" }), { task, message, allowed }), {
    priority: "Urgent",
    dueDate: "06/11/2026",
  });
  assert.deepEqual(checkChanges(aiRead({ dueDate: "clear" }), { task, message, allowed }), { dueDate: "" });
  // What isn't allowed is dropped; with nothing left, nothing changes.
  const narrow: Allowed = { roles: ["reviewer"], status: false, details: false, author: false };
  assert.equal(checkChanges(aiRead({ owner: { add: ["UREX"], remove: [] }, status: "DONE" }), { task, message, allowed: narrow }), null);
  // The author is added only when allowed.
  assert.deepEqual(
    checkChanges(aiRead({ reviewer: { add: ["UACTOR", "UREX"], remove: [] } }), { task, message, allowed: narrow }),
    { people: { reviewer: { add: ["UREX"], remove: [] } } },
  );
  assert.equal(checkChanges(aiRead({ status: "IN_PROGRESS", priority: "Loud" }), { task, message, allowed }), null);
});

test("with AI on, a message is read for every change and confirmed privately", async (t) => {
  const { environment, asked } = aiEnv(
    aiRead({
      owner: { add: ["UREX"], remove: ["UBOB"] },
      reviewer: { add: ["UMIA"], remove: [] },
      status: "IN_PROGRESS",
      priority: "Urgent",
      dueDate: "2026-10-30",
    }),
  );
  const calls = mockSlack(t, { ...slackUsers, stored: [ownTask({ owners: ["UBOB"] })] });
  calls.responses = recordResponses(t);
  const text = "<@UREX> can you take this over from <@UBOB>? <@UMIA> please review. Need it by Friday, it's blocking the release";
  await send("/slack/events", threadEvent(text), {}, environment);

  assert.equal(asked[0].model, "@cf/zai-org/glm-4.7-flash");
  assert.deepEqual(asked[0].input.chat_template_kwargs, { enable_thinking: false });
  const input = JSON.parse(asked[0].input.messages[1].content);
  assert.deepEqual(input.mentioned, ["UREX", "UBOB", "UMIA"]);
  assert.equal(input.task.status, "TODO");

  const question = ephemeral(calls);
  assert.equal(question.user, "UACTOR");
  assert.equal(question.text, "Should I update the task? From your message:");
  assert.equal(
    question.blocks[1].text.text,
    [
      "*Owners:* <@UREX> (Add) · <@UBOB> (Remove)",
      "*Reviewers:* <@UMIA> (Add)",
      "*Status:* :memo: To do → :arrow_forward: In progress",
      "*Priority:* :large_orange_circle: High → :red_circle: Urgent",
      "*Due:* 31/10/2026 → 30/10/2026",
    ].join("\n"),
  );
  const [confirm, change, skip] = question.blocks[2].elements;
  assert.deepEqual([confirm.text.text, change.text.text, skip.text.text], ["Accept", "Edit…", "Reject"]);

  // Accept applies it all, and the thread hears it as one message. Everyone
  // it names was mentioned in the message, so they're named, not notified
  // again, and asked nothing.
  await send("/slack/interactions", aiClick(confirm), {}, environment);
  const saved = await savedTask();
  assert.deepEqual(saved.people, { owner: ["UREX"], reviewer: ["UMIA"], tester: [] });
  assert.deepEqual([saved.status, saved.priority, saved.dueDate], ["IN_PROGRESS", "Urgent", "30/10/2026"]);
  const posts = calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1");
  assert.equal(posts.length, 1);
  assert.equal(
    posts[0].args.text,
    [
      "<@UACTOR> assigned <@UREX> as owner.",
      "<@UACTOR> removed <@UBOB> as owner.",
      "<@UACTOR> assigned <@UMIA> as reviewer.",
      "<@UACTOR> set the priority to :red_circle: Urgent.",
      "<@UACTOR> set the due date to 30/10/2026.",
      "<@UACTOR> set the status to :arrow_forward: In progress.",
    ].join("\n"),
  );
  assert.deepEqual(calls.responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("Edit… opens the task's Edit form filled in with what AI read, and saving it applies the form", async (t) => {
  const { environment } = aiEnv(aiRead({ tester: { add: ["UTESS"], remove: [] }, status: "IN_TESTING" }));
  const calls = mockSlack(t, { ...slackUsers, stored: [ownTask({ testers: ["UTOM"] })] });
  calls.responses = recordResponses(t);
  await send("/slack/events", threadEvent("<@UTESS> can you test this now?"), {}, environment);
  const [, change] = ephemeral(calls).blocks[2].elements;

  await send("/slack/interactions", aiClick(change), {}, environment);
  const form = calls.at(-1).args.view;
  assert.equal(calls.at(-1).method, "views.open");
  assert.equal(form.callback_id, "task:edit");
  assert.deepEqual(form.blocks.map((block) => block.block_id), ["owner", "reviewer", "tester", "status", "priority", "due_date", "blocked", "blocked_reason"]);
  assert.deepEqual(form.blocks[2].element.initial_users, ["UTOM", "UTESS"]);
  assert.equal(form.blocks[3].element.initial_option.value, "IN_TESTING");
  assert.equal(form.blocks[5].element.initial_date, "2026-10-31");

  // Whoever saved it changed their mind about UTOM, and moved the due date.
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
            owner: { value: { selected_users: [] } },
            reviewer: { value: { selected_users: [] } },
            tester: { value: { selected_users: ["UTESS"] } },
            status: { value: { selected_option: { value: "IN_TESTING" } } },
            priority: { value: { selected_option: { value: "High" } } },
            due_date: { value: { selected_date: "2026-11-02" } },
            prs: { value: { value: "" } },
          },
        },
      },
    }),
    {},
    environment,
  );
  const saved = await savedTask();
  assert.deepEqual(saved.people.tester, ["UTESS"]);
  assert.deepEqual([saved.status, saved.dueDate], ["IN_TESTING", "02/11/2026"]);
  assert.equal(
    calls.filter((call) => call.method === "chat.postMessage").at(-1).args.text,
    [
      // Tess was mentioned in the message; Tom, removed in the form, wasn't.
      "<@UACTOR> assigned <@UTESS> as tester.",
      "<@UACTOR> removed <@UTOM> as tester.",
      "<@UACTOR> set the due date to 02/11/2026.",
      "<@UACTOR> set the status to :test_tube: In testing.",
    ].join("\n"),
  );
  // The private question goes once the form is saved.
  assert.deepEqual(calls.responses, [{ response_type: "ephemeral", delete_original: true }]);
});

test("AI isn't asked about the priority and due date of an incident", async (t) => {
  const { environment } = aiEnv(aiRead({ priority: "Low", dueDate: "2026-10-30" }));
  const calls = mockSlack(t, { stored: [incidentTask()] });
  await send("/slack/events", threadEvent("This is urgent, need it by Friday"), {}, environment);
  assert.equal(ephemeral(calls), undefined);
});

test("with AI on, a message saying the task is blocked, or no longer, is read and asked about", async (t) => {
  const blockedTask = () => {
    const record = storedTask({ status: "IN_PROGRESS" });
    record.task.blocked = true;
    record.task.blockedReason = "waiting on design";
    return record;
  };
  for (const [text, record, raw, changes, line] of [
    // None of these words were in the phrases that decide what AI reads before.
    ["we're waiting on the API keys", storedTask({ status: "IN_PROGRESS" }), { blocked: "block", blockedReason: "waiting on the API keys" }, { blocked: { on: true, reason: "waiting on the API keys" } }, "*Blocked:* no → yes (waiting on the API keys)"],
    ["design arrived, unblocked", blockedTask(), { blocked: "unblock" }, { blocked: { on: false } }, "*Blocked:* yes → no"],
  ] as const) {
    const { environment, asked } = aiEnv(aiRead(raw));
    const calls = mockSlack(t, { stored: [record] });
    await send("/slack/events", threadEvent(text), {}, environment);
    assert.equal(asked.length, 1, text);
    const question = ephemeral(calls);
    assert.deepEqual(suggestedChanges(question), changes, text);
    assert.match(JSON.stringify(question.blocks), new RegExp(line.replace(/[*()]/g, "\\$&")), text);
  }
});

test("the model isn't asked about pull requests, and what it says of them is ignored", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const people = { owner: [], reviewer: [], tester: [] };
  const task = fake<StoredTask>({ status: "IN_PROGRESS", people, prs: [MR] });
  const message = fake<PlainMessage>({ user: "UA", mentions: [], text: `closed ${MR}, new PR is ${PR}` });
  const allowed: Allowed = { roles: [], status: true };
  // As an older model's answer might still say.
  const answer = { ...aiRead(), prs: { add: [PR], remove: [MR] } };
  assert.equal(checkChanges(answer, { task, message, allowed }), null);
});

test("with AI on, a pasted pull request is linked whatever the model reads, and nothing is suggested about it", async (t) => {
  const withMr = () => {
    const record = storedTask({ status: "IN_PROGRESS" });
    record.task.prs = [MR];
    return record;
  };
  for (const [text, prs] of [
    [`PR is up: ${PR}`, [MR, PR]],
    // A link pasted for reference is linked too: Unlink on the note takes it off.
    [`see ${PR} for how they did it`, [MR, PR]],
    [`${MR} is abandoned`, [MR]],
  ] as const) {
    const { calls, asked } = await aiSuggestion(t, text, withMr(), {});
    assert.deepEqual((await savedTask()).prs, prs, text);
    assert.equal(suggestion(calls), undefined, text);
    // The model is told nothing of pull requests.
    assert.doesNotMatch(JSON.stringify(asked), /pullRequests/, text);
  }
  // The model failing: the link is still linked, from the text.
  const { environment } = aiEnv(new Error("model unavailable"));
  const calls = mockSlack(t, { stored: [withMr()] });
  await send("/slack/events", threadEvent(`PR is up: ${PR}`), {}, environment);
  assert.deepEqual((await savedTask()).prs, [MR, PR]);
  assert.equal(suggestion(calls), undefined);
});

test("with AI on, a message that changes nothing gets no question", async (t) => {
  const { environment, asked } = aiEnv(aiRead());
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("cc <@UREX>, thanks for the review earlier"), {}, environment);
  assert.equal(asked.length, 1);
  assert.equal(ephemeral(calls), undefined);
});

test("AI doesn't read messages in a task that's Done", async (t) => {
  const { environment, asked } = aiEnv(aiRead({ reviewer: { add: ["UMIA"], remove: [] } }));
  const calls = mockSlack(t, { stored: [withStatus("DONE")] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, environment);
  assert.equal(asked.length, 0);
  assert.equal(ephemeral(calls), undefined);
});

test("when AI fails, nothing is suggested from the words, but a pull request link is still linked, and who it mentions offered as reviewer", async (t) => {
  const { environment } = aiEnv(new Error("model unavailable"));
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, environment);
  assert.equal(suggestion(calls), undefined);

  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent(`<@UMIA> please review ${PR}`), {}, environment);
  assert.deepEqual((await savedTask()).prs, [PR]);
  assert.deepEqual(noteValue(calls).changes, { people: { reviewer: { add: ["UMIA"], remove: [] } } });
});

test("with suggestions off, AI isn't asked and only commands work", async (t) => {
  const { environment, asked } = aiEnv(aiRead({ reviewer: { add: ["UMIA"], remove: [] } }));
  const calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, { ...environment, TASK_CHANGE_DETECTION: "false" });
  assert.equal(asked.length, 0);
  assert.equal(ephemeral(calls), undefined);
});

test("AI reads messages whenever the binding is there, with aiModel naming the one model", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = (settings) => [{ name: "acme", channel: "C0000000002", ...settings }];
  const config = (top, settings) => readConfig(JSON.stringify({ projects: projects(settings), ...top }));
  // The model is one for every project, at the top of the file; without it, the secret is empty.
  assert.equal(config({ aiModel: "@cf/qwen/qwen3-30b-a3b-fp8" }, {}).AI_MODEL_NAME, "@cf/qwen/qwen3-30b-a3b-fp8");
  assert.equal(config({}, {}).AI_MODEL_NAME, "");
  assert.throws(() => config({ aiModel: "gpt" }, {}), /aiModel is a Workers AI/);
  assert.throws(() => config({}, { aiModel: "@cf/x/y" }), /acme's aiModel is set once at the top of the file/);
  const { aiModel } = await import("../src/ai.ts");
  assert.equal(aiModel(fake({ AI: {} })), "@cf/zai-org/glm-4.7-flash");
  assert.equal(aiModel(fake({ AI: {}, AI_MODEL_NAME: "@cf/x/y" })), "@cf/x/y");
  assert.equal(aiModel(fake({ AI_MODEL_NAME: "@cf/x/y" })), null, "no binding");
});

test("suggestions can be set per group, over the setting for every group", async (t) => {
  const pairs = (acme) => (env.PROJECTS as Project[]).map((pair) => (pair.name === "acme" ? { ...pair, ...acme } : pair));

  // acme turns the proactive agent off, though it's on for every group.
  let calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, { ...env, PROJECTS: pairs({ taskChangeDetection: false }) });
  assert.equal(ephemeral(calls), undefined);

  // acme turns it on, with a kind, though it's off for every group.
  const { environment, asked } = aiEnv(aiRead({ reviewer: { add: ["UMIA"], remove: [] } }));
  calls = mockSlack(t, { stored: [storedTask()] });
  await send("/slack/events", threadEvent("<@UMIA> can you review this?"), {}, { ...environment, TASK_CHANGE_DETECTION: "false", PROJECTS: pairs({ taskChangeDetection: true }) });
  assert.equal(asked.length, 1);
  assert.equal(ephemeral(calls).text, "Should I update the task? From your message:");

  // Another group keeps the setting for every group.
  const { suggesting } = await import("../src/intents.ts");
  const split = fake<AppEnv>({ AI: {}, TASK_CHANGE_DETECTION: "false", PROJECTS: pairs({ taskChangeDetection: ["hand-offs"] }) });
  assert.equal(suggesting(split, "hand-offs", "CDEV"), true);
  assert.equal(suggesting(split, "progress", "CDEV"), false);
  assert.equal(suggesting(split, "hand-offs", "CTESTDEV"), false);
});

test("npm run github stores a classic token with the repo scope, warns about a fine-grained one, and refuses others", async () => {
  const { checkToken, NEW_TOKEN_URL } = await import("../scripts/github.ts");
  const asked: { url: string; authorization: string | null }[] = [];
  const github = (status: number, scopes: string | null, body: unknown = { login: "isuru" }) =>
    (async (url, init) => {
      asked.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(body), { status, headers: scopes === null ? {} : { "x-oauth-scopes": scopes } });
    }) as typeof fetch;

  assert.deepEqual(await checkToken("ghp_ok", github(200, "read:org, repo")), { login: "isuru" });
  assert.deepEqual(asked[0], { url: "https://api.github.com/user", authorization: "bearer ghp_ok" });
  assert.deepEqual(await checkToken("github_pat_x", github(200, null)), { login: "isuru", narrow: true });
  assert.match((await checkToken("ghp_public", github(200, "public_repo"))).problem!, /doesn't have the repo scope/);
  assert.match((await checkToken("ghp_bad", github(401, null))).problem!, /doesn't accept that token/);
  assert.match((await checkToken("ghp_down", github(503, null))).problem!, /HTTP 503/);
  // The page it opens asks for a classic token with repo ticked.
  assert.match(NEW_TOKEN_URL, /^https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo&/);
});

test("npm run config checks each group's suggestions", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const projects = [
    { name: "acme", channel: "C0000000002", taskChangeDetection: true },
    { name: "test", channel: "C0000000003", taskChangeDetection: false },
  ];
  assert.deepEqual(JSON.parse(readConfig(JSON.stringify({ projects })).PROJECTS), [
    projects[0],
    projects[1],
  ]);
  assert.throws(() => readConfig(JSON.stringify({ projects: [{ ...projects[1], taskChangeDetection: ["nope"] }] })), /test's taskChangeDetection is true or false/);
});

test("the card's Edit opens one form with everything, and saving it applies what changed as one message", async (t) => {
  const record = ownTask({ owners: ["UREX"], reviewers: ["UMIA"] });
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/interactions", cardMenuClick("edit"));
  assert.deepEqual(calls.map((call) => call.method), ["views.open"]);
  const form = calls[0].args.view;
  assert.equal(form.callback_id, "task:edit");
  assert.deepEqual(form.blocks.map((block) => block.block_id), ["owner", "reviewer", "tester", "status", "priority", "due_date", "blocked", "blocked_reason"]);
  assert.deepEqual(form.blocks[0].element.initial_users, ["UREX"]);
  assert.equal(form.blocks[3].element.initial_option.value, "TODO");

  // A tester added with the status left alone keeps it. The pull requests box of a form opened
  // before they had a form of their own is ignored.
  const values = {
    owner: { value: { selected_users: ["UREX"] } },
    reviewer: { value: { selected_users: ["UMIA"] } },
    tester: { value: { selected_users: ["UTESS"] } },
    status: { value: { selected_option: { value: "TODO" } } },
    priority: { value: { selected_option: { value: "High" } } },
    due_date: { value: { selected_date: "2026-10-31" } },
    prs: { value: { value: "https://github.com/acme/web/pull/12" } },
  };
  const submit = (state) =>
    send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values: state } } }));
  await submit(values);
  const saved = await savedTask();
  assert.deepEqual([saved.status, saved.prs, saved.people.tester], ["TODO", [], ["UTESS"]]);
  const posts = calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].args.text, "<@UACTOR> assigned <@UTESS> as tester.");
});

test("AI only adds the author to a role when their message speaks of themselves", async (t) => {
  // The model adds the author to whatever the message is about.
  for (const [text, suggested] of [
    ["this is urgent, client needs it by Friday", false],
    ["lgtm, approved", false],
    ["<@UREX> can you build this? I'll do the review", true],
    ["on it", true],
  ] as const) {
    const { environment } = aiEnv(aiRead({ reviewer: { add: ["UACTOR"], remove: [] } }));
    const calls = mockSlack(t, { stored: [ownTask()] });
    await send("/slack/events", threadEvent(text), {}, environment);
    assert.equal(Boolean(ephemeral(calls)), suggested, text);
  }
});

test("AI is given the dates of the coming week, for deadlines like Friday", async () => {
  const { comingDays } = await import("../src/ai.ts");
  const days = comingDays("2026-10-27");
  assert.equal(days.Friday, "2026-10-30");
  assert.equal(days.Tuesday, "2026-11-03");
  assert.equal(Object.keys(days).length, 7);
});

test("AI is given the dates of next week's days too, for deadlines like next Friday", async () => {
  const { nextWeekDays } = await import("../src/ai.ts");
  const days = nextWeekDays("2026-10-27");
  assert.equal(days["next Friday"], "2026-11-06");
  assert.equal(days["in a week"], "2026-11-03");
  assert.equal(days["in two weeks"], "2026-11-10");
});

test("the Edit form of a suggestion shows the task as it will be, with its people and status, and no pull requests", () => {
  const { task } = storedTask({ reviewers: ["URIA"] });
  task.status = "IN_PROGRESS";
  task.prs = [MR];
  const field = (view, id) => view.blocks.find((block) => block.block_id === id)?.element;

  // One suggested before pull requests stopped being suggested still has them; the form leaves them out.
  const form = editForm({ channel: "CDEV", ts: "100.1" }, task, {
    changes: { prs: { add: [PR], remove: [MR] }, people: { reviewer: { add: ["UREX"], remove: [] } } },
  });
  assert.equal(field(form, "status").initial_option.value, "IN_PROGRESS");
  assert.deepEqual(field(form, "reviewer").initial_users, ["URIA", "UREX"]);
  assert.equal(field(form, "prs"), undefined);

  // As the task stands, without a suggestion.
  const plain = editForm({ channel: "CDEV", ts: "100.1" }, task);
  assert.equal(field(plain, "status").initial_option.value, "IN_PROGRESS");
});

test("Edit saves a new status and a tester who is the person saving, in one update, and posts the log", async (t) => {
  const task = storedTask({ reviewers: ["UMIA"] });
  task.task.status = "IN_REVIEW";
  const calls = mockSlack(t, { stored: [task] });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "task:edit",
        private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", details: false }),
        state: {
          values: {
            owner: { value: { selected_users: [] } },
            reviewer: { value: { selected_users: ["UMIA"] } },
            tester: { value: { selected_users: ["UACTOR"] } },
            status: { value: { selected_option: { value: "IN_TESTING" } } },
            prs: { value: { value: "" } },
          },
        },
      },
    }),
  );
  const saved = await savedTask();
  assert.deepEqual([saved.status, saved.people.tester], ["IN_TESTING", ["UACTOR"]]);
  // One update of the card, for all of it.
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 1);
  const post = calls.find((call) => call.method === "chat.postMessage");
  assert.equal(post.args.text, "<@UACTOR> assigned themselves as tester.\n<@UACTOR> set the status to :test_tube: In testing.");
});

test("someone removed from several roles at once is told only for the roles they had been asked in", async (t) => {
  const root = storedTask({ owners: ["UALICE"], reviewers: ["UALICE"] });
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send("/slack/events", threadEvent("<@UBOT> unassign <@UALICE>"));
  assert.deepEqual(drafts(calls), ["<@UALICE>, there's no need to work on this anymore."]);
});

test("people assigned in several roles are asked only for the one the task is at, and people asked alike share a note", async (t) => {
  const root = storedTask();
  root.task.prs = [PR];
  const calls = mockSlack(t, { stored: [root] });
  await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: {
        callback_id: "task:edit",
        private_metadata: JSON.stringify({ channel: "CDEV", ts: "100.1", details: false }),
        state: {
          values: {
            owner: { value: { selected_users: ["UBOB", "UREX"] } },
            reviewer: { value: { selected_users: ["UBOB"] } },
            tester: { value: { selected_users: [] } },
            status: { value: { selected_option: { value: "TODO" } } },
            prs: { value: { value: PR } },
          },
        },
      },
    }),
  );
  // It is To do: owners are asked, and the reviewer waits for In review.
  assert.deepEqual(drafts(calls), ["<@UBOB>, <@UREX>, could you pick this up?"]);
});

// ---- The update engine: what actually changed ----

test("changeTask blocks and unblocks a task, keeping its status, and the thread is told", async (t) => {
  mockSlack(t, { stored: [storedTask({ status: "IN_PROGRESS" })] });
  const blocked = await changeTask(env, where, { blocked: { on: true, reason: "  waiting on\nAPI keys " } }, "UACTOR");
  assert.deepEqual(blocked.blocked, { to: true, reason: "waiting on API keys" });
  assert.deepEqual(changeLog(blocked), ["<@UACTOR> marked this as blocked: waiting on API keys"]);
  const stored = await savedTask();
  assert.deepEqual([stored.status, stored.blocked, stored.blockedReason], ["IN_PROGRESS", true, "waiting on API keys"]);
  // The same again changes nothing; a new reason does.
  assert.equal(await changeTask(env, where, { blocked: { on: true, reason: "waiting on API keys" } }, "UACTOR"), null);
  assert.equal((await changeTask(env, where, { blocked: { on: true, reason: "waiting on design" } }, "UACTOR")).blocked.reason, "waiting on design");
  const unblocked = await changeTask(env, where, { blocked: { on: false } }, "UACTOR");
  assert.deepEqual(changeLog(unblocked), ["<@UACTOR> unblocked this."]);
  assert.equal(await changeTask(env, where, { blocked: { on: false } }, "UACTOR"), null);
});

test("a blocked task's card and the Home tab show it, with its reason", async () => {
  const { blockedLine, cleanReason, MAX_BLOCKED_REASON } = await import("../src/tasks.ts");
  assert.equal(blockedLine({ blocked: false, blockedReason: "x" }), "");
  assert.equal(blockedLine({ blocked: true }), ":no_entry: *Blocked*");
  assert.equal(blockedLine({ blocked: true, blockedReason: "waiting on <keys>" }), ":no_entry: *Blocked*: waiting on &lt;keys&gt;");
  assert.equal(cleanReason("x".repeat(500)).length, MAX_BLOCKED_REASON);
});

test("AI blocks and unblocks only when the task's state and the message agree", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const people = { owner: [], reviewer: [], tester: [] };
  const allowed = { roles: [], blocked: true };
  const run = (task, text, raw) => checkChanges(aiRead(raw), { task: { status: "IN_PROGRESS", people, ...task }, message: { user: "UA", mentions: [], text }, allowed })?.blocked ?? null;
  assert.deepEqual(run({}, "blocked on the API keys", { blocked: "block", blockedReason: "waiting on the API keys" }), { on: true, reason: "waiting on the API keys" });
  assert.deepEqual(run({ blocked: true }, "keys arrived, unblocked", { blocked: "unblock" }), { on: false });
  // Already in that state, or a question: nothing.
  assert.equal(run({ blocked: true }, "still blocked", { blocked: "block" }), null);
  assert.equal(run({}, "unblocked", { blocked: "unblock" }), null);
  assert.equal(run({}, "are we blocked on design?", { blocked: "block" }), null);
  // Off when blocked suggestions are.
  assert.equal(checkChanges(aiRead({ blocked: "block" }), { task: fake<StoredTask>({ status: "TODO", people }), message: { user: "UA", mentions: [], text: "blocked" }, allowed: { roles: [] } }), null);
});

const where = { channel: "CDEV", ts: "100.1" };

test("changeTask returns only what differs from the stored task", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
  const change = await changeTask(
    env,
    where,
    {
      // @alice is an owner already; @bob is new.
      people: { owner: { add: ["UALICE", "UBOB"] }, tester: { remove: ["UTOM"] } },
      // The priority is as it is; the due date is not.
      priority: "High",
      dueDate: "02/11/2026",
      status: "TODO",
    },
    "UACTOR",
  );
  assert.deepEqual(change.people, [{ role: "owner", added: ["UBOB"], removed: [] }]);
  assert.deepEqual([change.prs, change.priority, change.status], [null, null, null]);
  assert.deepEqual(change.dueDate, { from: "31/10/2026", to: "02/11/2026" });
  // Stored, and the card updated once, for all of it.
  const saved = await savedTask();
  assert.deepEqual([saved.people.owner, saved.dueDate], [["UALICE", "UBOB"], "02/11/2026"]);
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 1);
});

test("changeTask returns what each kind of change was from and to", async (t) => {
  const root = storedTask({ reviewers: ["UMIA"] });
  root.task.prs = [MR];
  mockSlack(t, { stored: [root] });
  const change = await changeTask(
    env,
    where,
    { prs: { add: [PR, MR], remove: [MR, "https://github.com/acme/other/pull/1"] }, priority: "Low", status: "IN_REVIEW" },
    "UACTOR",
  );
  assert.deepEqual(change.prs, { added: [PR], removed: [MR] });
  assert.deepEqual(change.priority, { from: "High", to: "Low" });
  assert.deepEqual(change.status, { from: "TODO", to: "IN_REVIEW" });
  assert.equal(change.task.status, "IN_REVIEW");
});

test("changeTask returns null, and saves nothing, when nothing differs", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask({ owners: ["UALICE"] })] });
  const change = await changeTask(
    env,
    where,
    { people: { owner: { add: ["UALICE"] } }, priority: "High", dueDate: "31/10/2026", status: "TODO", prs: { remove: [PR] } },
    "UACTOR",
  );
  assert.equal(change, null);
  assert.deepEqual(calls.map((call) => call.method), []);
});

test("changeTask leaves an incident's priority and due date, and a task that is gone", async (t) => {
  mockSlack(t, { stored: [incidentTask({})] });
  assert.equal(await changeTask(env, where, { priority: "Low", dueDate: "01/01/2027" }, "UACTOR"), null);
  assert.equal(await changeTask(env, { channel: "CDEV", ts: "999.9" }, { priority: "Low" }, "UACTOR"), null);
});

test("changeTask leaves the status when the task moved on from where the suggestion saw it", async (t) => {
  const root = storedTask();
  root.task.status = "IN_PROGRESS";
  mockSlack(t, { stored: [root] });
  const change = await changeTask(env, where, { status: "IN_REVIEW", priority: "Low" }, "UACTOR", { from: "TODO" });
  assert.equal(change.status, null);
  assert.equal(change.priority.to, "Low");
  assert.equal((await savedTask()).status, "IN_PROGRESS");
});

// ---- The acknowledgement engine: what is said about a change ----

// A change as changeTask returns it, with `task` as it now is.
// A change as notify.ts reads it, with only what a test sets; the task is a stand-in, with what notify reads of it.
const changed = ({ people = [], prs = null, status = null, priority = null, dueDate = null, told = {}, task = {} }: Partial<Omit<Change, "task">> & { task?: Partial<StoredTask> } = {}): Change => fake<Change>({
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
const team = (owner = [], reviewer = [], tester = []) => ({ owner, reviewer, tester });

test("the change log has a line for each thing that changed, in order", () => {
  const change = changed({
    people: [
      { role: "owner", added: ["UBOB"], removed: [] },
      { role: "tester", added: [], removed: ["UTOM"] },
    ],
    prs: { added: [PR], removed: [MR] },
    priority: { from: "High", to: "Low" },
    dueDate: { from: "31/10/2026", to: "" },
    status: { from: "TODO", to: "IN_PROGRESS" },
  });
  assert.deepEqual(changeLog(change), [
    `<@UACTOR> linked <${PR}|cade/42>.`,
    `<@UACTOR> unlinked <${MR}|web-app/118>.`,
    "<@UACTOR> assigned <@UBOB> as owner.",
    "<@UACTOR> removed <@UTOM> as tester.",
    "<@UACTOR> set the priority to :large_green_circle: Low.",
    "<@UACTOR> removed the due date.",
    "<@UACTOR> set the status to :arrow_forward: In progress.",
  ]);
  assert.deepEqual(changeLog(changed()), []);
});

test("a person assigned in two roles is asked only for the one the task is at", () => {
  const change = (status) =>
    changed({
      people: [
        { role: "owner", added: ["UBOB", "UREX"], removed: [] },
        { role: "reviewer", added: ["UBOB"], removed: [] },
      ],
      prs: { added: [PR], removed: [] },
      task: { status, people: team(["UBOB", "UREX"], ["UBOB"]) },
    });
  // Owners work on it while it is To do or In progress, and reviewers review it while it is In review.
  assert.deepEqual(changeRequests(change("IN_PROGRESS")), ["<@UBOB>, <@UREX>, could you pick this up?"]);
  assert.deepEqual(changeRequests(change("IN_REVIEW")), [`<@UBOB>, could you review this?`]);
  assert.deepEqual(changeRequests(change("IN_TESTING")), []);
});

test("people asked alike share a note, and reviewers kept are asked about new pull requests only while it is In review", () => {
  const change = (status) =>
    changed({
      people: [{ role: "owner", added: ["UBOB", "UREX"], removed: [] }],
      prs: { added: [PR], removed: [] },
      task: { status, people: team(["UBOB", "UREX"], ["UMIA", "UZOE"]) },
    });
  assert.deepEqual(changeRequests(change("IN_REVIEW")), [`<@UMIA>, <@UZOE>, could you review this?`]);
  // Before it, the reviewers wait: they are asked when it gets to In review.
  assert.deepEqual(changeRequests(change("IN_PROGRESS")), ["<@UBOB>, <@UREX>, could you pick this up?"]);
});

test("moving to In review asks every reviewer once, those just added too, about the pull requests pending", () => {
  const pending = changed({
    people: [{ role: "reviewer", added: ["UMIA"], removed: [] }],
    status: { from: "IN_PROGRESS", to: "IN_REVIEW" },
    task: { prs: [PR, MR], people: team([], ["UZOE", "UMIA", "UACTOR"]) },
  });
  assert.deepEqual(changeRequests(pending), [`<@UZOE>, <@UMIA>, could you review this?`]);
  // With no pull requests there is nothing to list: they are asked to review it.
  const none = changed({ status: { from: "IN_PROGRESS", to: "IN_REVIEW" }, task: { people: team([], ["UZOE"]) } });
  assert.deepEqual(changeRequests(none), ["<@UZOE>, could you review this?"]);
  // Pull requests all merged or closed leave nothing to review.
  const settled = changed({ status: { from: "IN_PROGRESS", to: "IN_REVIEW" }, task: { prs: [PR, MR], prStates: { [PR]: "MERGED", [MR]: "CLOSED" }, people: team([], ["UZOE"]) } });
  assert.deepEqual(changeRequests(settled), []);
});

test("an owner is asked only while the task is To do or In progress", () => {
  const owner = (status) => changed({ people: [{ role: "owner", added: ["UBOB"], removed: [] }], task: { status, people: team(["UBOB"]) } });
  for (const status of ["TODO", "IN_PROGRESS"]) assert.deepEqual(changeRequests(owner(status)), ["<@UBOB>, could you pick this up?"], status);
  for (const status of ["IN_REVIEW", "IN_TESTING", "CLIENT_REVIEW", "DONE"]) assert.deepEqual(changeRequests(owner(status)), [], status);
});

test("no one is asked who made the change, was told already, or has nothing to do yet", () => {
  const people = (role, ...ids) => [{ role, added: ids, removed: [] }];
  // Made the change, or told by the message the suggestion came from.
  assert.deepEqual(changeRequests(changed({ people: people("owner", "UACTOR"), task: { people: team(["UACTOR"]) } })), []);
  assert.deepEqual(changeRequests(changed({ people: people("owner", "UBOB"), told: { UBOB: null }, task: { people: team(["UBOB"]) } })), []);
  // A reviewer before In review, a tester before In testing, an owner once Done.
  assert.deepEqual(changeRequests(changed({ people: people("reviewer", "UMIA"), task: { prs: [PR], people: team([], ["UMIA"]) } })), []);
  assert.deepEqual(changeRequests(changed({ people: people("tester", "UTOM"), task: { people: team([], [], ["UTOM"]) } })), []);
  assert.deepEqual(changeRequests(changed({ people: people("owner", "UBOB"), task: { status: "DONE", people: team(["UBOB"]) } })), []);
  // Pull requests all merged are not for reviewers to review.
  const merged = fake<StoredTask>({ status: "IN_REVIEW", people: team([], ["UMIA"]), prs: [PR], prStates: { [PR]: "MERGED" } });
  assert.deepEqual(changeRequests(changed({ people: people("reviewer", "UMIA"), task: merged })), []);
});

test("moving to In testing asks every tester once, those just added too", () => {
  const notes = changeRequests(
    changed({
      people: [{ role: "tester", added: ["UTESS"], removed: [] }],
      status: { from: "IN_REVIEW", to: "IN_TESTING" },
      task: { people: team([], [], ["UTOM", "UTESS", "UACTOR"]) },
    }),
  );
  assert.deepEqual(notes, ["<@UTESS>, <@UTOM>, could you give this a test?"]);
});

test("people removed are told only if they had been asked, and once", () => {
  // Removed from two roles: told only for the one they had been asked in, by the stage it was at.
  const both = (status) =>
    changed({
      people: [
        { role: "owner", added: [], removed: ["UALICE"] },
        { role: "reviewer", added: [], removed: ["UALICE"] },
      ],
      task: { status, prs: [PR] },
    });
  assert.deepEqual(changeRequests(both("IN_PROGRESS")), ["<@UALICE>, there's no need to work on this anymore."]);
  assert.deepEqual(changeRequests(both("IN_REVIEW")), ["<@UALICE>, there's no need to review this anymore."]);

  // A tester removed as it moves to In testing was never asked to test it.
  const testing = changed({
    people: [{ role: "tester", added: [], removed: ["UTOM"] }],
    status: { from: "IN_REVIEW", to: "IN_TESTING" },
  });
  assert.deepEqual(changeRequests(testing), []);

  // Nor a reviewer removed as the only pull request goes, or when it is Done.
  const noPrs = changed({ people: [{ role: "reviewer", added: [], removed: ["UMIA"] }] });
  assert.deepEqual(changeRequests(noPrs), []);
  const done = changed({ people: [{ role: "owner", added: [], removed: ["UBOB"] }], task: { status: "DONE" } });
  assert.deepEqual(changeRequests(done), []);
});

test("changes that are not about people ask no one", () => {
  assert.deepEqual(changeRequests(changed({ priority: { from: "High", to: "Low" }, dueDate: { from: "", to: "01/01/2027" } })), []);
  assert.deepEqual(changeRequests(changed({ status: { from: "TODO", to: "IN_PROGRESS" } })), []);
});

test("the Home tab's Refresh button draws it again", async (t) => {
  const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored: [storedTask({ owners: ["UME"] })] });
  const body = interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:refresh" }] });
  assert.equal((await send("/slack/interactions", body)).status, 200);
  const [publish] = calls.filter((call) => call.method === "views.publish");
  assert.equal(publish.args.user_id, "UME");
  assert.match(publish.args.view.blocks.map((block) => blockText(block) ?? "").join("\n"), /Fix login/);

  // npm run setup reads the Worker's URL from the deploy, and .
  const { workerUrlIn } = await import("../scripts/setup.ts");
  assert.equal(workerUrlIn("Deployed cade (1s)\n  https://cade.acme.workers.dev\n"), "https://cade.acme.workers.dev");

  // …and offers the Cloudflare accounts by name, from wrangler whoami's table.
  const { accountsIn } = await import("../scripts/setup.ts");
  const a = "0123456789abcdef0123456789abcdef";
  const b = "fedcba9876543210fedcba9876543210";
  const whoami = [
    "┌────────────────┬──────────────────────────────────┐",
    "│ Account Name   │ Account ID                       │",
    "├────────────────┼──────────────────────────────────┤",
    `│ Acme's Account │ ${a} │`,
    `│ XTECHLK        │ ${b} │`,
    "└────────────────┴──────────────────────────────────┘",
  ].join("\n");
  assert.deepEqual(accountsIn(whoami), [{ id: a, name: "Acme's Account" }, { id: b, name: "XTECHLK" }]);
  assert.deepEqual(accountsIn(`Account ID: ${a}`), [{ id: a, name: a }]);
});

test("AI moves a task's status forward only, never back or sideways", async () => {
  const { checkChanges, laterStatuses } = await import("../src/ai.ts");
  const message = fake<PlainMessage>({ user: "UACTOR", mentions: [] });
  const allowed: Allowed = { roles: [], status: true, details: false };
  const at = (status: Status) => fake<StoredTask>({ status, priority: "High", dueDate: "", people: { owner: [], reviewer: [], tester: [] } });
  assert.deepEqual(laterStatuses("IN_REVIEW"), ["IN_TESTING", "CLIENT_REVIEW", "DONE"]);
  assert.deepEqual(laterStatuses("DONE"), []);
  // Forward, even by several steps, is offered.
  assert.deepEqual(checkChanges(aiRead({ status: "IN_TESTING" }), { task: at("IN_REVIEW"), message, allowed }), { status: "IN_TESTING" });
  assert.deepEqual(checkChanges(aiRead({ status: "DONE" }), { task: at("IN_PROGRESS"), message, allowed }), { status: "DONE" });
  // Back, or the same status, is not.
  for (const [from, to] of [["IN_REVIEW", "IN_PROGRESS"], ["IN_TESTING", "TODO"], ["DONE", "IN_REVIEW"], ["IN_REVIEW", "IN_REVIEW"]] as const) {
    assert.equal(checkChanges(aiRead({ status: to }), { task: at(from), message, allowed }), null, `${from} -> ${to}`);
  }
});

test("AI doesn't move a task's status for work done on only a part of it", async () => {
  const { checkChanges } = await import("../src/ai.ts");
  const allowed: Allowed = { roles: [], status: true, details: false };
  const task = fake<StoredTask>({ status: "IN_PROGRESS", priority: "High", dueDate: "", people: { owner: [], reviewer: [], tester: [] } });
  const read = (text: string) => checkChanges(aiRead({ status: "IN_TESTING" }), { task, message: { user: "UACTOR", mentions: [], text }, allowed });
  for (const text of ["the login part is done", "subtask 2 is in testing", "backend merged, frontend pending", "finished the first step", "half of it is ready for QA", "the API is done"]) {
    assert.equal(read(text), null, text);
  }
  assert.deepEqual(read("all done, ready for QA"), { status: "IN_TESTING" });
});

test("a task with subtasks gets no status suggestion for a part, but its pull requests and people are still suggested", async (t) => {
  // A real subtask of the task (100.1), which makes it done in parts.
  const withSubtasks = (record) => [record, subtaskOf("100.2")];
  for (const [text, record, raw, changes] of [
    // A part reaching a stage isn't the whole task reaching it.
    ["lgtm", withSubtasks(taskWith("IN_REVIEW", { reviewers: ["UACTOR"] })), { status: "IN_TESTING" }, null],
    // People still are, and the status that would come with asking for a test is left out.
    ["<@UTOM> please test it", withSubtasks(taskWith("IN_PROGRESS")), { tester: add("UTOM"), status: "IN_TESTING" }, { people: { tester: add("UTOM") } }],
    // Without subtasks the same answer moves the status.
    ["lgtm", taskWith("IN_REVIEW", { reviewers: ["UACTOR"] }), { status: "IN_TESTING" }, { status: "IN_TESTING" }],
  ] as const) {
    const { question } = await aiSuggestion(t, text, record, raw);
    assert.deepEqual(question ? suggestedChanges(question) : null, changes, text);
  }
});

test("the Edit form has no Has subtasks box, and a form opened before it went changes nothing for it", async (t) => {
  const record = ownTask({ owners: ["UREX"] });
  const calls = mockSlack(t, { stored: [record] });
  await send("/slack/interactions", cardMenuClick("edit"));
  const form = calls[0].args.view;
  assert.equal(form.blocks.some((block) => block.block_id === "subtasks"), false);
  // An Edit form opened before the box went still sends it; it's ignored.
  const values = {
    owner: { value: { selected_users: ["UREX"] } },
    reviewer: { value: { selected_users: [] } },
    tester: { value: { selected_users: [] } },
    status: { value: { selected_option: { value: "TODO" } } },
    priority: { value: { selected_option: { value: "High" } } },
    due_date: { value: { selected_date: null } },
    prs: { value: { value: "" } },
    subtasks: { value: { selected_options: [{ value: "subtasks" }] } },
  };
  await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: { callback_id: form.callback_id, private_metadata: form.private_metadata, state: { values } } }));
  assert.equal("subtasks" in (await savedTask()), false);
  assert.ok(!calls.some((call) => /Has subtasks|having subtasks/.test(JSON.stringify(call.args))));
});

test("scripts keep a deployment's files in CADE_DEPLOY_DIR, and in the checkout without it", async () => {
  const { execFileSync } = await import("node:child_process");
  const show = (env) =>
    JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", 'import {HOME,ROOT} from "./scripts/paths.ts"; console.log(JSON.stringify({HOME,ROOT}))'], {
        env: { ...process.env, CADE_DEPLOY_DIR: "", ...env },
        encoding: "utf8",
      }),
    );
  const alone = show({});
  assert.equal(alone.HOME, alone.ROOT);
  assert.equal(show({ CADE_DEPLOY_DIR: "/tmp/acme-deploy" }).HOME, "/tmp/acme-deploy/");
});

// ---- Buttons and forms from older messages ----

// A button's or form's payload that no longer fits what the handler reads (see payloads.ts) is told
// to whoever used it, and nothing is done.
const OUTDATED = /from an older message, and doesn't work anymore/;

test("a button whose value no longer fits is said to be out of date, privately, and does nothing", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask()] });
  for (const value of ["not json", JSON.stringify({ channel: "CDEV", ts: "100.1" }), JSON.stringify({ kind: "everything", channel: "CDEV", ts: "100.1" })]) {
    calls.length = 0;
    const response = await send(
      "/slack/interactions",
      interaction({ type: "block_actions", user: { id: "UACTOR" }, message: { ts: "100.9" }, response_url: RESPONSE_URL, actions: [{ action_id: "delete:confirm", value }] }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(calls.map((call) => call.method), ["respond"], value);
    assert.match(calls[0].args.text, OUTDATED);
    assert.equal(calls[0].args.response_type, "ephemeral");
  }
  assert.ok(await getTask(env, "CDEV", "100.1"), "the task is still there");
});

test("a button read in the background is said to be out of date too", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  // A standup's status menu reads its block_id after Slack has been answered.
  await send(
    "/slack/interactions",
    interaction({
      type: "block_actions",
      user: { id: "ULEAD" },
      response_url: RESPONSE_URL,
      actions: [{ action_id: "standup:status:0", block_id: JSON.stringify({ c: "CDEV", t: "100.1" }), selected_option: { value: "DONE" } }],
    }),
  );
  assert.deepEqual(calls.map((call) => call.method), ["respond"]);
  assert.match(calls[0].args.text, OUTDATED);
  assert.equal((await getTask(env, "CDEV", "100.1")).status, "TODO");
});

test("a form whose metadata no longer fits says so in its window, and changes nothing", async (t) => {
  const calls = mockSlack(t, { stored: [storedTask()] });
  const response = await send(
    "/slack/interactions",
    interaction({
      type: "view_submission",
      user: { id: "UACTOR" },
      view: { id: "V1", callback_id: "task:edit", private_metadata: JSON.stringify({ ts: "100.1" }), state: { values: {} } },
    }),
  );
  const answer = await response.json<any>();
  assert.equal(answer.response_action, "update");
  assert.equal(answer.view.title.text, "Out of date");
  assert.match(answer.view.blocks[0].text.text, OUTDATED);
  assert.deepEqual(calls, []);
});

test("npm run config refuses what cade.config.json can't say, such as a misspelt setting, which would do nothing", async () => {
  const { readConfig } = await import("../scripts/config.ts");
  const acme = { name: "acme", channel: "C0000000002" };
  for (const [config, problem] of [
    // A setting on a project the Worker doesn't read, misspelt or from an older format.
    [{ projects: [{ ...acme, summaryCanvass: true }] }, /project acme: summaryCanvass isn't something this takes; it takes name, channel, taskChangeDetection/],
    [{ projects: [{ ...acme, sheet: "https://docs.google.com/spreadsheets/d/x/edit" }] }, /project acme: sheet isn't something this takes/],
    // A project's people are its channel's, so they aren't listed.
    [{ projects: [{ ...acme, members: ["UANN"] }] }, /project acme: members isn't something this takes/],
    [{ projects: [{ ...acme, name: 7 }] }, /must list \{ name, channel \}|project 7: name is text\./],
    // The top of the file.
    [{ projects: [acme], timezone: 5 }, /timezone|isn't a time zone/],
    [{ projects: [acme], aiModel: 42 }, /aiModel is a Workers AI/],
  ] as const) {
    assert.throws(() => readConfig(JSON.stringify(config)), problem, JSON.stringify(config));
  }
  // What it does take is uploaded as it was.
  const members = { ...acme, summaryCanvas: true };
  assert.deepEqual(JSON.parse(readConfig(JSON.stringify({ projects: [members], mcp: true })).PROJECTS), [members]);
});

test("what Slack sends is checked for what Cade routes it by, and answered 400 if it can't be read", async (t) => {
  const calls = mockSlack(t);
  for (const [path, body, problem] of [
    ["/slack/events", "not json", /event isn't JSON/],
    ["/slack/events", JSON.stringify({ type: "event_callback" }), /Give event\./],
    ["/slack/interactions", interaction({ type: "block_actions", user: { id: "UACTOR" }, actions: [] }), /actions needs at least 1 entry/],
    ["/slack/interactions", interaction({ type: "view_submission", user: { id: "UACTOR" }, view: {} }), /Give view\.callback_id\./],
    ["/slack/interactions", interaction({ type: "block_actions", actions: [{ action_id: "home:refresh" }] }), /Give user\./],
    ["/slack/commands", new URLSearchParams({ command: "/cade", text: "help" }).toString(), /Give user_id\./],
  ] as const) {
    const logged = t.mock.method(console, "warn", () => {});
    const response = await send(path, body);
    assert.equal(response.status, 400, body);
    assert.match(String(logged.mock.calls.at(-1)?.arguments[1]?.problem), problem, body);
    logged.mock.restore();
  }
  assert.deepEqual(calls, []);
});

// ---- Subtasks ----

// A subtask of the task at CDEV/100.1 ("Fix login"), at `ts`, as historyTask.
const subtaskOf = (ts: string, fields: Record<string, unknown> = {}) => historyTask(ts, { title: "Fails on Safari", parent: { ts: "100.1", title: "Fix login" }, ...fields });

// A card's text, every block's, a line each.
const cardText = (args) => allBlocks(args).map((block) => blockText(block) ?? "").join("\n");

// The choices on the ⋯ menu of a card Cade posted or updated.
const menuChoices = (args) => cardMenu(args).options.map((option) => option.text.text);

test("Add subtask, under the card's list of subtasks, makes a subtask with the task's people, in its own thread, and the task's card counts it", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask({ owners: ["UREX"], testers: ["UTESS"] })],
    "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: args.channel, ts: "200.1" }),
    "chat.getPermalink": { permalink: "https://slack.example/p200" },
    "conversations.replies": { messages: [] },
  });
  // Subtasks opens the list, empty for now, with Add subtask under it.
  await send("/slack/interactions", subtasksClick());
  const list = calls.find((call) => call.method === "views.open").args.view;
  assert.match(list.blocks.map((block) => blockText(block) ?? "").join("\n"), /No subtasks yet\./);
  assert.equal(list.blocks.at(-1).elements[0].text.text, "Add subtask");
  // Add subtask opens the form over the list.
  await send("/slack/interactions", addFromList(list));
  const pushed = calls.find((call) => call.method === "views.push").args;
  assert.equal(pushed.trigger_id, "T2");
  const form = pushed.view;
  assert.equal(form.callback_id, "subtask:add");
  assert.match(blockText(form.blocks[0]), /Subtask of \*Fix login\*/);
  // It starts with the task's due date, which can be changed, and has its priority, which can't.
  assert.match(blockText(form.blocks[0]), /with its priority, :large_orange_circle: High/);
  const field = (id) => form.blocks.find((block) => block.block_id === id)?.element;
  assert.equal(field("due_date").initial_date, "2026-10-31");
  assert.equal(field("priority"), undefined);

  calls.length = 0;
  const values = { title: { value: { value: "Fails on Safari" } }, due_date: { value: { selected_date: "2026-11-20" } } };
  // Sending it closes the form and the list under it.
  const sent = await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UTESS" }, view: { callback_id: "subtask:add", private_metadata: form.private_metadata, state: { values } } }));
  assert.deepEqual(await sent.json(), { response_action: "clear" });

  // Its own card, naming the task, with no Subtasks button: they go one level deep.
  const card = calls.find((call) => call.method === "chat.postMessage" && !call.args.thread_ts).args;
  assert.match(cardText(card), /^\[HIGH\] \*Fails on Safari\*\n:arrow_right_hook: Subtask of \*Fix login\*\n/);
  assert.deepEqual(cardButtons(card).map((element) => element.action_id), ["task:edit", "task:prs", "task:menu"]);
  assert.deepEqual(menuChoices(card), ["Archive"]);
  const subtask = (await getTask(env, "CDEV", "200.1"))!;
  assert.deepEqual([subtask.parent?.ts, subtask.priority, subtask.dueDate, subtask.people.owner, subtask.people.tester], ["100.1", "High", "20/11/2026", ["UREX"], ["UTESS"]]);
  // The task's thread hears of it, and its card counts it.
  const told = calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").args;
  assert.equal(told.text, "<@UTESS> added a subtask: <https://slack.example/p200|Fails on Safari>. It's tracked in its own thread.");
  const parent = calls.filter((call) => call.method === "chat.update" && call.args.ts === "100.1").at(-1).args;
  assert.match(cardText(parent), /\nSubtasks: 1 open  ·  0 closed\n/);
  assert.deepEqual(menuChoices(parent), ["Archive"]);
});

test("Add subtask on a subtask, from an older card's menu or a list opened before, says they go one level deep", async (t) => {
  const subtask = subtaskOf("100.2");
  const calls = mockSlack(t, { stored: [ownTask(), subtask] });
  await send("/slack/interactions", interaction({ ...JSON.parse(new URLSearchParams(cardMenuClick("subtask")).get("payload")!), message: { ts: "100.2" } }));
  assert.deepEqual(calls.map((call) => call.method), ["chat.postEphemeral"]);
  assert.match(calls[0].args.text, /subtasks don't have their own/);
  // Add subtask in a list naming a task that has since become a subtask says so over the list.
  calls.length = 0;
  const list = { blocks: [{ type: "actions", elements: [{ action_id: "subtasks:add", value: JSON.stringify({ channel: "CDEV", ts: "100.2" }) }] }] };
  await send("/slack/interactions", addFromList(list));
  assert.deepEqual(calls.map((call) => call.method), ["views.push"]);
  assert.match(blockText(calls[0].args.view.blocks[0]), /subtasks don't have their own/);
});

test("a subtask moving to Done moves it from open to closed on its task's card", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask(), subtaskOf("100.2", { status: "IN_TESTING" }), subtaskOf("100.3", { title: "Wrong total" })] });
  await send("/slack/events", threadEvent("<@UBOT> status done", { thread_ts: "100.2" }));
  const parent = calls.filter((call) => call.method === "chat.update" && call.args.ts === "100.1").at(-1).args;
  assert.match(cardText(parent), /\nSubtasks: 1 open  ·  1 closed\n/);
});

test("Subtasks lists a task's subtasks, open first, each linking to its thread, then Add subtask", async (t) => {
  const calls = mockSlack(t, {
    stored: [
      ownTask(),
      subtaskOf("100.2", { title: "Closed one", status: "DONE", link: "https://slack.example/p1002" }),
      subtaskOf("100.3", { title: "Open one", status: "IN_PROGRESS", owners: ["UREX"], link: "https://slack.example/p1003" }),
    ],
  });
  await send("/slack/interactions", subtasksClick());
  const view = calls.find((call) => call.method === "views.open").args.view;
  assert.equal(view.title.text, "Subtasks");
  assert.deepEqual(JSON.parse(view.blocks.at(-1).elements[0].value), { channel: "CDEV", ts: "100.1" });
  const text = view.blocks.map((block) => blockText(block) ?? "").join("\n");
  assert.match(text, /Subtasks: 1 open  ·  1 closed/);
  // Each in three lines, as on the Home tab: its title; its priority, status and due date; its people.
  assert.match(text, /\*Open \(1\)\*\n\*<https:\/\/slack\.example\/p1003\|Open one>\*\n:[a-z_]+: \w+  ·  :arrow_forward: In progress[^\n]*\nOwner <@UREX>\n\n\*Closed \(1\)\*\n\*<https:\/\/slack\.example\/p1002\|Closed one>\*\n[^\n]+  ·  :white_check_mark: Done/);
});

test("the summary lists subtasks under their task, wherever its urgency puts it", async (t) => {
  const calls = mockSlack(t, {
    ...canvasResponses,
    stored: [
      historyTask("100.1", { title: "Parent", priority: "Low" }),
      historyTask("100.2", { title: "Other", priority: "High" }),
      subtaskOf("100.3", { title: "Done part", status: "DONE", completedAt: "2026-10-10T09:00:00.000Z" }),
      subtaskOf("100.4", { title: "Urgent part", priority: "Urgent" }),
    ],
  });
  await runTasksCommand("resync summary", "CDEV");
  const markdown = canvasMarkdown(calls.find((call) => call.method === "conversations.canvases.create"));
  const titles = (section) => summaryRows(markdown, section).map((row) => row.match(/^\| (↳ )?\[([^\]]+)\]/).slice(1).join(""));
  assert.deepEqual(titles("Open"), ["Other", "Parent", "↳ Urgent part", "↳ Done part"]);
  assert.deepEqual(titles("Closed"), []);
});

test("the Home tab lists subtasks under their task, which a subtask of yours brings to My Tasks", async (t) => {
  const stored = [
    historyTask("100.1", { title: "Checkout redesign", owners: ["UOTHER"], status: "IN_TESTING" }),
    subtaskOf("100.2", { title: "Payment fails", owners: ["UME"], status: "IN_PROGRESS" }),
    subtaskOf("100.3", { title: "Fixed already", owners: ["UME"], status: "DONE" }),
    subtaskOf("100.4", { title: "Someone else's part", owners: ["UOTHER"] }),
  ];
  const view = async (action_id: string) => {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id }] }));
    const { blocks } = calls.find((call) => call.method === "views.publish").args.view;
    assert.deepEqual(duplicateActionIds(blocks), []);
    return blocks.map((block) => blockText(block) ?? "").join("\n");
  };
  // My Tasks: the task, though not theirs, with only their subtask under it.
  const mine = await view("home:tab:mine");
  // Each subtask as a card of its own under it: ↪ and its title, then its details, then its people.
  assert.match(mine, /:hammer_and_wrench: To work on \(1\)\n\*<[^|]+\|Checkout redesign>\*\n[^\n]+\nOwner <@UOTHER>\n_Your subtasks:_\n:arrow_right_hook: \*<[^|]+\|Payment fails>\*\n:large_orange_circle: High  ·  :arrow_forward: In progress  ·  [^\n]*\nOwner you\n/);
  assert.doesNotMatch(mine, /Someone else's part|Fixed already/);
  // All Tasks: each subtask once, under its task, with how many are done.
  const all = await view("home:tab:all");
  assert.equal(all.match(/\|Payment fails>/g)?.length, 1);
  assert.match(all, /\|Checkout redesign>\*\n[^]*\|Payment fails>[^]*\|Someone else's part>[^]*_\+1 done_/);

  // The task's owner sees all its open subtasks under it, whoever's they are.
  stored[0] = historyTask("100.1", { title: "Checkout redesign", owners: ["UME"], status: "IN_TESTING" });
  const owner = await view("home:tab:mine");
  assert.match(owner, /\|Checkout redesign>\*\n[^\n]+\nOwner you\n:arrow_right_hook: \*<[^|]+\|Payment fails>\*\n[^\n]+\nOwner you\n:arrow_right_hook: \*<[^|]+\|Someone else's part>\*\n[^\n]+\nOwner <@UOTHER>\n_\+1 done_/);
  assert.doesNotMatch(owner, /Your subtasks/);
  assert.equal(owner.match(/\|Payment fails>/g)?.length, 1);
});

test("a task done in parts by its subtasks is moved by no message about a part", async () => {
  const { statusFits } = await import("../src/ai.ts");
  const task = (subtaskCounts?: { open: number; closed: number }) => fake<StoredTask>({ status: "IN_PROGRESS", subtaskCounts });
  assert.equal(statusFits("IN_REVIEW", task(), "PR is up"), true);
  assert.equal(statusFits("IN_REVIEW", task({ open: 1, closed: 0 }), "PR is up"), false);
});

test("a subtask of an incident is an incident too, asking only for its title, Urgent and due Immediate for good", async (t) => {
  const calls = mockSlack(t, {
    stored: [incidentTask({ owners: ["UREX"] })],
    "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: args.channel, ts: "200.1" }),
    "chat.getPermalink": { permalink: "https://slack.example/p200" },
    "conversations.replies": { messages: [] },
  });
  await send("/slack/interactions", cardMenuClick("subtask"));
  const form = calls.find((call) => call.method === "views.open").args.view;
  assert.deepEqual(form.blocks.filter((block) => block.type === "input").map((block) => block.block_id), ["title"]);
  assert.match(blockText(form.blocks[0]), /Urgent and due Immediate/);
  const values = { title: { value: { value: "Restart the payment worker" } } };
  await send("/slack/interactions", interaction({ type: "view_submission", user: { id: "UREX" }, view: { callback_id: "subtask:add", private_metadata: form.private_metadata, state: { values } } }));
  const subtask = (await getTask(env, "CDEV", "200.1"))!;
  assert.deepEqual([subtask.priority, subtask.dueDate, subtask.incident, subtask.parent?.ts], ["Urgent", "Immediate", true, "100.1"]);
  // Its Edit form leaves out the priority and due date, as an incident's does.
  const edit = editForm({ channel: "CDEV", ts: "200.1" }, subtask);
  assert.deepEqual(edit.blocks.map((block) => block.block_id).filter((id) => id === "priority" || id === "due_date"), []);
});

test("a subtask with no owner of its own shows its task's owner, on its card and the Home tab, until it has one", async (t) => {
  const stored = [historyTask("100.1", { title: "Checkout redesign", owners: ["UME"] }), subtaskOf("100.2", { title: "Payment fails", testers: ["UTESS"] })];
  const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
  await send("/slack/events", threadEvent("<@UBOT> status in progress", { thread_ts: "100.2" }));
  const card = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.2").args;
  assert.equal(footerLines(card)[0], "Owner <@UME>  ·  Test <@UTESS>");
  // It isn't stored as theirs, so it follows the task's owner: a new one redraws the subtask's card.
  assert.deepEqual((await getTask(env, "CDEV", "100.2"))!.people.owner, []);
  calls.length = 0;
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UREX>", { thread_ts: "100.1" }));
  const redrawn = calls.find((call) => call.method === "chat.update" && call.args.ts === "100.2").args;
  assert.match(footerLines(redrawn)[0], /^Owner <@UME>, <@UREX>/);
});

test("Unassigned on the Home tab lists only tasks with no one on them, with their subtasks under them", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [
      historyTask("100.1", { title: "Taken task", owners: ["UOTHER"] }),
      subtaskOf("100.2", { title: "Ownerless part" }),
      historyTask("100.3", { title: "Nobody's task" }),
      subtaskOf("100.4", { title: "Its part", owners: ["UOTHER"], parent: { ts: "100.3", title: "Nobody's task" } }),
    ],
  });
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:unassigned" }] }));
  const { blocks } = calls.find((call) => call.method === "views.publish").args.view;
  const text = blocks.map((block) => blockText(block) ?? "").join("\n");
  assert.doesNotMatch(text, /Taken task|Ownerless part/);
  assert.match(text, /\|Nobody's task>\*\n[^]*:arrow_right_hook: \*<[^|]+\|Its part>\*\n[^\n]+\nOwner <@UOTHER>/);
  const buttons = blocks.flatMap((block) => block.elements ?? []).filter((element) => element.type === "button" && element.action_id.startsWith("home:claim"));
  assert.deepEqual(buttons.map((button) => [button.action_id, button.text.text]), [["home:claim:CDEV:100.3", "Assign to me"]]);
});

test("Coming up on My Tasks lists a task's subtasks under it, so they need no label", async (t) => {
  const calls = mockSlack(t, {
    "auth.test": { url: "https://acme.slack.com/" },
    stored: [historyTask("100.1", { title: "Checkout redesign", owners: ["UOTHER"] }), subtaskOf("100.2", { title: "Payment fails", testers: ["UME"], status: "IN_PROGRESS" })],
  });
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id: "home:tab:mine" }] }));
  const text = calls.find((call) => call.method === "views.publish").args.view.blocks.map((block) => blockText(block) ?? "").join("\n");
  assert.match(text, /\*Coming up\*\n<[^|]+\|Checkout redesign>  ·  :memo: To do\n:arrow_right_hook: <[^|]+\|Payment fails>  ·  :arrow_forward: In progress/);
  assert.doesNotMatch(text, /subtask of/i);
});

test("a task with open subtasks doesn't move to Client review or Done: whoever tried is warned, privately", async (t) => {
  for (const status of ["done", "client review"]) {
    const calls = mockSlack(t, { stored: [ownTask({ status: "IN_TESTING" }), subtaskOf("100.2", { title: "Payment fails", link: "https://slack.example/p1002" }), subtaskOf("100.3", { status: "DONE" })] });
    await send("/slack/events", threadEvent(`<@UBOT> status ${status}`));
    assert.equal((await savedTask())!.status, "IN_TESTING");
    // No ✅, and nothing in the thread: only the warning, to them.
    assert.ok(!calls.some((call) => call.method === "reactions.add" || call.method === "chat.postMessage" || call.method === "chat.update"));
    const warning = calls.find((call) => call.method === "chat.postEphemeral").args;
    assert.deepEqual([warning.user, warning.thread_ts], ["UACTOR", "100.1"]);
    assert.match(warning.text, /^:warning: 1 subtask is still open: <https:\/\/slack\.example\/p1002\|Payment fails>\. A task moves to .* only once all its subtasks are done/);
    assert.deepEqual(warning.blocks[1].elements.map((button) => button.text.text), ["Close all subtasks", "Cancel"]);
  }
  // Any other status, and a task with every subtask done, move as before.
  mockSlack(t, { stored: [ownTask({ status: "IN_TESTING" }), subtaskOf("100.3", { status: "DONE" })] });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  assert.equal((await savedTask())!.status, "DONE");
});

test("Edit saves the rest when its status waits for subtasks, and says so in the warning", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask({ status: "IN_TESTING" }), subtaskOf("100.2")] });
  await seeded;
  await changeTask(env, { channel: "CDEV", ts: "100.1" }, { status: "DONE", priority: "Low" }, "UACTOR");
  const task = (await savedTask())!;
  assert.deepEqual([task.status, task.priority], ["IN_TESTING", "Low"]);
  assert.match(calls.find((call) => call.method === "chat.postEphemeral").args.text, /Your other changes are saved\.$/);
});

test("Close all subtasks moves each to Done, then the task where it was going; Cancel just removes the warning", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask({ status: "IN_TESTING" }), subtaskOf("100.2"), subtaskOf("100.3", { title: "Wrong total", status: "IN_PROGRESS" })] });
  await send("/slack/events", threadEvent("<@UBOT> status done"));
  const warning = calls.find((call) => call.method === "chat.postEphemeral").args;
  calls.length = 0;
  const responses = await answerPrivately(t, warning, "subtasks:close");
  for (const ts of ["100.2", "100.3"]) assert.equal((await getTask(env, "CDEV", ts))!.status, "DONE", ts);
  assert.equal((await savedTask())!.status, "DONE");
  // Each subtask's thread hears it, then the task's, once for all of them, then that it moved.
  const told = calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.args.thread_ts, call.args.text]);
  assert.deepEqual(told.map(([ts]) => ts), ["100.2", "100.3", "100.1", "100.1"]);
  assert.equal(told[2]![1], "<@UACTOR> closed all its subtasks: *Fails on Safari*, *Wrong total*.");
  assert.deepEqual(responses.at(-1), { response_type: "ephemeral", replace_original: true, text: "Closed 2 subtasks and moved the task to :white_check_mark: Done." });

  mockSlack(t, { stored: [ownTask({ status: "IN_TESTING" }), subtaskOf("100.2")] });
  const cancelled = await answerPrivately(t, warning, "subtasks:cancel");
  assert.deepEqual(cancelled.at(-1), { response_type: "ephemeral", delete_original: true });
  assert.equal((await savedTask())!.status, "IN_TESTING");
});

test("@Cade subtask <title> adds a subtask with the task's due date and priority, and links it in the thread", async (t) => {
  const calls = mockSlack(t, {
    stored: [ownTask({ owners: ["UREX"] })],
    "chat.postMessage": (args) => (args.thread_ts ? { ts: "300.1" } : { channel: args.channel, ts: "200.1" }),
    "chat.getPermalink": { permalink: "https://slack.example/p200" },
    "conversations.replies": { messages: [] },
  });
  await send("/slack/events", threadEvent("<@UBOT> subtask Fails on   Safari"));
  const subtask = (await getTask(env, "CDEV", "200.1"))!;
  assert.deepEqual([subtask.title, subtask.dueDate, subtask.priority, subtask.people.owner, subtask.parent?.ts], ["Fails on Safari", "31/10/2026", "High", ["UREX"], "100.1"]);
  assert.ok(calls.some((call) => call.method === "reactions.add" && call.args.name === "white_check_mark"));
  const told = calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").args;
  assert.equal(told.text, "<@UACTOR> added a subtask: <https://slack.example/p200|Fails on Safari>. It's tracked in its own thread.");

  // Without a title it says what to send; in a subtask's thread, that they go one level deep.
  const empty = mockSlack(t, { stored: [ownTask()] });
  await send("/slack/events", threadEvent("<@UBOT> subtask"));
  assert.match(empty.find((call) => call.method === "chat.postMessage").args.text, /Give the subtask a title/);
  const nested = mockSlack(t, { stored: [ownTask(), subtaskOf("100.2")] });
  await send("/slack/events", threadEvent("<@UBOT> subtask Another", { thread_ts: "100.2" }));
  assert.match(nested.find((call) => call.method === "chat.postMessage").args.text, /subtasks don't have their own/);
});

// Cards with timestamps a Slack link can name, for the commands that take links.
const [T1, T2, T3] = ["1700000000.000100", "1700000000.000200", "1700000000.000300"];
// A message link to the card at `ts` in CDEV, as Copy link gives it.
const cardLink = (ts: string) => `<${messageLink("CDEV", ts)}>`;
// A subtask of the task at T1 ("Main"), at `ts`.
const subtaskOfT1 = (ts: string, fields: Record<string, unknown> = {}) => subtaskOf(ts, { parent: { ts: T1, title: "Main" }, ...fields });
// As an admin may send them.
const asAdmin = { ...env, ADMINS: JSON.stringify(["UACTOR"]) } as AppEnv;

test("/cade subtask link makes an older task a subtask, for admins only, and isn't in help", async (t) => {
  const calls = mockSlack(t, { stored: [historyTask(T1, { title: "Checkout redesign", owners: ["UMIA"] }), historyTask(T2, { title: "Payment fails", priority: "Low", dueDate: "01/12/2026", owners: ["UREX"], link: "https://slack.example/p2" })] });
  const { later } = await runTasksCommand(`subtask link ${cardLink(T2)} ${cardLink(T1)}`, "CDEV", asAdmin);
  assert.equal(later.text, "Made <https://slack.example/p2|Payment fails> a subtask of *Checkout redesign*.");
  // It keeps its own due date and people, and takes the main task's priority; both cards show the link.
  const subtask = (await getTask(env, "CDEV", T2))!;
  assert.deepEqual([subtask.parent?.ts, subtask.priority, subtask.dueDate, subtask.people.owner], [T1, "High", "01/12/2026", ["UREX"]]);
  const card = (ts) => cardText(calls.filter((call) => call.method === "chat.update" && call.args.ts === ts).at(-1).args);
  assert.match(card(T2), /:arrow_right_hook: Subtask of \*Checkout redesign\*/);
  assert.match(card(T1), /Subtasks: 1 open  ·  0 closed/);
  // The main task's thread hears it as it does a new subtask.
  assert.equal(calls.find((call) => call.method === "chat.postMessage" && call.args.thread_ts === T1).args.text, "<@UACTOR> added a subtask: <https://slack.example/p2|Payment fails>. It's tracked in its own thread.");

  // Unlinked, it is a task of its own again.
  calls.length = 0;
  const undone = await runTasksCommand(`subtask unlink ${cardLink(T2)}`, "CDEV", asAdmin);
  assert.equal(undone.later.text, "Made <https://slack.example/p2|Payment fails> a task of its own again.");
  assert.equal((await getTask(env, "CDEV", T2))!.parent, undefined);
  assert.doesNotMatch(card(T1), /Subtasks:/);

  // Not for anyone else, and not listed.
  const refused = await runTasksCommand(`subtask link ${cardLink(T2)} ${cardLink(T1)}`, "CDEV", { ...env, ADMINS: "[]" } as AppEnv);
  assert.equal(JSON.parse(refused.now).text, "Only Cade's admins can do that.");
  const help = await runTasksCommand("help", "CDEV", asAdmin);
  assert.doesNotMatch(help.now, /subtask link/);
});

test("/cade subtask link keeps the rules a new subtask follows", async (t) => {
  const tryLink = async (stored: Stored[], child: string, parent: string) => {
    mockSlack(t, { stored });
    return (await runTasksCommand(`subtask link ${cardLink(child)} ${cardLink(parent)}`, "CDEV", asAdmin)).later.text;
  };
  const main = historyTask(T1, { title: "Main" });
  const other = historyTask(T3, { title: "Other" });
  assert.match(await tryLink([main, subtaskOfT1(T2), other], T3, T2), /is a subtask itself/);
  assert.match(await tryLink([main, subtaskOfT1(T2), other], T1, T3), /has subtasks of its own/);
  assert.match(await tryLink([historyTask(T1, { title: "Main", status: "DONE" }), other], T3, T1), /waits for all its subtasks to be done/);
  assert.match(await tryLink([main, incidentHistoryTask(T3, { title: "Down" })], T3, T1), /an incident's main task must be one too/);
  // Under an incident, a task becomes one.
  assert.match(await tryLink([incidentHistoryTask(T1, { title: "Down" }), other], T3, T1), /It's an incident now/);
  const made = (await getTask(env, "CDEV", T3))!;
  assert.deepEqual([made.incident, made.priority, made.dueDate], [true, "Urgent", "Immediate"]);
});

test("closing or reopening a subtask tells its task's thread how its subtasks stand; other moves don't", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask({ status: "IN_TESTING" }), subtaskOf("100.2", { link: "https://slack.example/p2" }), subtaskOf("100.3", { title: "Wrong total" })] });
  const told = () => calls.filter((call) => call.method === "chat.postMessage" && call.args.thread_ts === "100.1").map((call) => call.args.text);
  await send("/slack/events", threadEvent("<@UBOT> status in progress", { thread_ts: "100.2" }));
  assert.deepEqual(told(), []);
  await send("/slack/events", threadEvent("<@UBOT> status done", { thread_ts: "100.2" }));
  assert.deepEqual(told(), ["<@UACTOR> closed the subtask <https://slack.example/p2|Fails on Safari>. Subtasks: 1 open  ·  1 closed."]);
  calls.length = 0;
  await send("/slack/events", threadEvent("<@UBOT> status in testing", { thread_ts: "100.2" }));
  assert.deepEqual(told(), ["<@UACTOR> reopened the subtask <https://slack.example/p2|Fails on Safari>. Subtasks: 2 open  ·  0 closed."]);
});

test("the admin commands, and their buttons, are only for Cade's admins", async (t) => {
  const notAdmin = { ...env, ADMINS: JSON.stringify(["USOMEONE"]) } as AppEnv;
  for (const command of [`remove <${messageLink("CDEV", T1)}>`, `replace <${messageLink("CDEV", T1)}> New text`, `resync <${messageLink("CDEV", T1)}>`, "resync summary", "resync all", `retry <${messageLink("CDEV", T1)}>`, `subtask link ${cardLink(T2)} ${cardLink(T1)}`]) {
    const calls = mockSlack(t, { stored: [historyTask(T1, { title: "Main" })] });
    const { now, later } = await runTasksCommand(command, "CDEV", notAdmin);
    assert.equal(JSON.parse(now).text, "Only Cade's admins can do that.", command);
    assert.equal(later, undefined, command);
    assert.deepEqual(calls, [], command);
  }
  // A Delete button sent to an admin does nothing for anyone else.
  mockSlack(t, { stored: [historyTask(T1, { title: "Main" })] });
  const responses = recordResponses(t);
  const value = JSON.stringify({ channel: "CDEV", ts: T1, kind: "task" });
  await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UOTHER" }, response_url: RESPONSE_URL, actions: [{ action_id: "delete:confirm", value }] }), {}, notAdmin);
  assert.deepEqual(responses, [{ response_type: "ephemeral", text: "Only Cade's admins can do that." }]);
  assert.ok(await getTask(env, "CDEV", T1));
  // The `@Cade subtask` form stays for everyone: only `/cade subtask` is for admins.
  mockSlack(t, { stored: [ownTask()] });
  await send("/slack/events", threadEvent("<@UBOT> subtask"), {}, notAdmin);
  assert.match(lastCalls.find((call) => call.method === "chat.postMessage").args.text, /Give the subtask a title/);
});

test("a subtask has its task's priority: not on its forms, nor changed by a command, and it follows the task's", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask(), subtaskOf("100.2", { priority: "High" })] });
  await seeded;
  // Its Edit form has the due date but not the priority.
  const ids = editForm({ channel: "CDEV", ts: "100.2" }, (await getTask(env, "CDEV", "100.2"))!).blocks.map((block) => block.block_id);
  assert.ok(ids.includes("due_date") && !ids.includes("priority"));
  // @Cade priority in its thread says where to change it, and changes nothing.
  await send("/slack/events", threadEvent("<@UBOT> priority low", { thread_ts: "100.2" }));
  assert.match(calls.find((call) => call.method === "chat.postMessage").args.text, /A subtask has its task's priority/);
  assert.equal((await getTask(env, "CDEV", "100.2"))!.priority, "High");
  // The task's priority changing brings it along, and redraws its card.
  calls.length = 0;
  await send("/slack/events", threadEvent("<@UBOT> priority urgent"));
  assert.equal((await getTask(env, "CDEV", "100.2"))!.priority, "Urgent");
  assert.match(cardText(calls.find((call) => call.method === "chat.update" && call.args.ts === "100.2").args), /^\[URGENT\] \*Fails on Safari\*/);
});

test("the Home tab never has more than Slack's 100 blocks, however many subtasks there are", async (t) => {
  const stored: Stored[] = [];
  for (let i = 1; i <= 12; i++) {
    const ts = `${100 + i}.1`;
    stored.push(historyTask(ts, { title: `Task ${i}`, owners: ["UME"] }));
    for (let j = 1; j <= 8; j++) stored.push(subtaskOf(`${100 + i}.${j + 1}`, { title: `Part ${i}.${j}`, parent: { ts, title: `Task ${i}` } }));
  }
  for (const action_id of ["home:tab:mine", "home:tab:all"]) {
    const calls = mockSlack(t, { "auth.test": { url: "https://acme.slack.com/" }, stored });
    await send("/slack/interactions", interaction({ type: "block_actions", user: { id: "UME" }, actions: [{ action_id }] }));
    const { blocks } = calls.find((call) => call.method === "views.publish").args.view;
    assert.ok(blocks.length <= 100, `${action_id}: ${blocks.length} blocks`);
    // What doesn't fit is counted rather than left out without a word.
    assert.match(blocks.map((block) => blockText(block) ?? "").join("\n"), /more/, action_id);
  }
});

test("a subtask's card has its Subtask of line and its page links in one block, as close as its people and who tracked it", async () => {
  const { taskMessage } = await import("../src/tasks.ts");
  const task = { ...subtaskOf("100.2").task, export: { url: "https://cade.example/t/1" } };
  const [first] = taskMessage(task).attachments![0]!.blocks as { elements: { text: string }[] }[];
  assert.equal(first!.elements[0]!.text, ":arrow_right_hook: Subtask of *Fix login*\nFull history <https://cade.example/t/1|here>");
});

test("a task's card is in three parts: its pages and subtasks' and PRs' counts, its work (status and people), and who tracked it", async () => {
  const { taskMessage } = await import("../src/tasks.ts");
  const task = { ...storedTask({ owners: ["UREX"] }).task, prs: [PR, MR, PR3], prStates: { [MR]: "MERGED" as const, [PR3]: "CLOSED" as const }, export: { url: "https://cade.example/t/1" }, subtaskCounts: { open: 1, closed: 2 } };
  const blocks = taskMessage(task).attachments![0]!.blocks as { elements: { text: string }[] }[];
  assert.deepEqual(blocks.map((block) => block.elements[0]!.text.split("\n")), [
    // A closed one is neither open nor merged.
    ["Full history <https://cade.example/t/1|here>", "Subtasks: 1 open  ·  2 closed", "Pull requests: 1 open  ·  1 merged"],
    [":memo: To do  ·  Due 31/10/2026", "Owner <@UREX>"],
    ["Tracked by <@UCREATOR>"],
  ]);
});

test("/cade resync all redraws every card in the channel, Done ones and subtasks too, quietly", async (t) => {
  const calls = mockSlack(t, { stored: [historyTask("100.1", { title: "Main" }), subtaskOf("100.2"), historyTask("100.3", { title: "Finished", status: "DONE" })] });
  const { later } = await runTasksCommand("resync all", "CDEV");
  assert.equal(later.text, "Redrew cards 1–3 of 3: every card in this channel is up to date.");
  assert.deepEqual(calls.filter((call) => call.method === "chat.update").map((call) => call.args.ts), ["100.1", "100.2", "100.3"]);
  // Only the cards: nothing in any thread.
  assert.ok(!calls.some((call) => call.method === "chat.postMessage"));

  // Outside a project's channel, it says where to send it.
  const elsewhere = await runTasksCommand("resync all", "CELSEWHERE");
  assert.match(JSON.parse(elsewhere.now).text, /in a project's dev channel/);
});

test("/cade resync reads its tasks' GitHub pull requests again, all in one request, and draws the cards with them", async (t) => {
  const withToken = { ...env, GITHUB_TOKEN: "ghp_test" };
  const tasks = () => [historyTask("1700000000.000100", { title: "Main", prs: [PR, MR] }), historyTask("1700000000.000300", { title: "Finished", status: "DONE", prs: [PR4] })];
  const prLine = (calls, ts) => prsLineOf(calls.find((call) => call.method === "chat.update" && call.args.ts === ts).args);

  // Several links: one request for every link's pull requests (the GitLab one isn't GitHub's).
  let calls = mockSlack(t, { stored: tasks() });
  let asked = mockGitHub({ 42: "MERGED", 9: "CLOSED" });
  await runTasksCommand(`resync ${messageLink("CDEV", "1700000000.000100")} ${messageLink("CDEV", "1700000000.000300")}`, "CDEV", withToken);
  assert.equal(asked.length, 1);
  assert.match(asked[0]!.query, /number: 42\)/);
  assert.match(asked[0]!.query, /number: 9\)/);
  assert.equal(prLine(calls, "1700000000.000100"), "Pull requests: 1 open  ·  1 merged");
  assert.equal(prLine(calls, "1700000000.000300"), "Pull requests: 0 open  ·  0 merged");

  // All: one request for every card's in the channel, Done ones too, before they're drawn.
  calls = mockSlack(t, { stored: tasks() });
  asked = mockGitHub({ 42: "MERGED", 9: "MERGED" });
  const { later } = await runTasksCommand("resync all", "CDEV", withToken);
  assert.equal(later.text, "Redrew cards 1–2 of 2: every card in this channel is up to date.");
  assert.equal(asked.length, 1);
  assert.equal(prLine(calls, "1700000000.000100"), "Pull requests: 1 open  ·  1 merged");
  assert.equal(prLine(calls, "1700000000.000300"), "Pull requests: 0 open  ·  1 merged");

  // Without a token, nothing is asked, and the cards are still drawn.
  calls = mockSlack(t, { stored: tasks() });
  asked = mockGitHub({ 42: "MERGED" });
  await runTasksCommand("resync all", "CDEV");
  assert.equal(asked.length, 0);
  assert.equal(prLine(calls, "1700000000.000100"), "Pull requests: 2 open  ·  0 merged");
});

test("/cade resync all goes 40 cards a run, and says what to send for the next, or where to start again when Slack slows it", async (t) => {
  const stored = Array.from({ length: 42 }, (_, i) => historyTask(`${101 + i}.1`, { title: `Task ${i + 1}` }));
  let calls = mockSlack(t, { stored });
  assert.equal((await runTasksCommand("resync all", "CDEV")).later.text, "Redrew cards 1–40 of 42. In a minute, send `/cade resync all 40` for the next ones.");
  assert.equal(calls.filter((call) => call.method === "chat.update").length, 40);
  calls = mockSlack(t, { stored });
  assert.equal((await runTasksCommand("resync all 40", "CDEV")).later.text, "Redrew cards 41–42 of 42: every card in this channel is up to date.");
  assert.deepEqual(calls.filter((call) => call.method === "chat.update").map((call) => call.args.ts), ["141.1", "142.1"]);

  mockSlack(t, { stored: stored.slice(0, 3), "chat.update": (args) => (args.ts === "102.1" ? { ok: false, error: "ratelimited" } : {}) });
  assert.equal((await runTasksCommand("resync all", "CDEV")).later.text, "Redrew card 1 of 3 before Slack asked me to slow down. In a minute, send `/cade resync all 1` for the next ones.");
});
