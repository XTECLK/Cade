import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";
import { getTask } from "../src/db.ts";
import { context, fake } from "./helpers.ts";
import {
  RESPONSE_URL,
  createdTask,
  env,
  interaction,
  mockSlack,
  ownTask,
  send,
  sign,
  storedTask,
  submission,
  threadEvent,
  withStatus,
} from "./app.ts";

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
  const response = await send("/slack/events", JSON.stringify({ type: "url_verification", challenge: "abc" }));
  assert.deepEqual(await response.json(), { challenge: "abc" });
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
    context((promise) => {
      pending.push(promise);
    }),
  );
  await Promise.all(pending);
  assert.equal(calls[0].args.text, "Hmm, I'm not tracking a task in this thread.");
});

test("Cade's messages never preview the messages they link to", async (t) => {
  const calls = mockSlack(t, {
    stored: [withStatus("DONE")],
    ...createdTask,
  });
  await send("/slack/interactions", interaction(submission({ title: "Fix login", priority: "High" })));
  await send("/slack/events", threadEvent("<@UBOT> status in progress"));
  await send("/slack/events", threadEvent("<@UBOT> assign owner <@UBOB>"));

  const posts = calls.filter((call) => ["chat.postMessage", "chat.update"].includes(call.method));
  assert.ok(posts.length >= 3);
  for (const call of posts) {
    assert.deepEqual(call.previews, { links: "false", media: "false" }, call.method);
  }
});

test("the Worker answers only POSTs to its routes, and needs the signing secret", async () => {
  const get = await worker.fetch(new Request("https://worker.example.net/slack/events"), env, context());
  assert.equal(get.status, 405);
  const missing = await worker.fetch(
    new Request("https://worker.example.net/nowhere", { method: "POST" }),
    env,
    context(),
  );
  assert.equal(missing.status, 404);
  await assert.rejects(
    worker.fetch(
      new Request("https://worker.example.net/slack/events", { method: "POST", body: "{}" }),
      { ...env, SLACK_SIGNING_SECRET: "" },
      context(),
    ),
    /SLACK_SIGNING_SECRET is not configured/,
  );
});

test("events other than messages, and interactions Cade has no handler for, are acknowledged and ignored", async (t) => {
  const calls = mockSlack(t);
  const reaction = JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: "UBOT" }],
    event: { type: "reaction_added" },
  });
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

// ---- Buttons and forms from older messages ----

// A button's or form's payload that no longer fits what the handler reads (see payloads.ts) is told
// to whoever used it, and nothing is done.
const OUTDATED = /from an older message, and doesn't work anymore/;

test("a button whose value no longer fits is said to be out of date, privately, and does nothing", async (t) => {
  const calls = mockSlack(t, { stored: [ownTask()] });
  for (const value of [
    "not json",
    JSON.stringify({ channel: "CDEV", ts: "100.1" }),
    JSON.stringify({ kind: "everything", channel: "CDEV", ts: "100.1" }),
  ]) {
    calls.length = 0;
    const response = await send(
      "/slack/interactions",
      interaction({
        type: "block_actions",
        user: { id: "UACTOR" },
        message: { ts: "100.9" },
        response_url: RESPONSE_URL,
        actions: [{ action_id: "delete:confirm", value }],
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["respond"],
      value,
    );
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
      actions: [
        {
          action_id: "standup:status:0",
          block_id: JSON.stringify({ c: "CDEV", t: "100.1" }),
          selected_option: { value: "DONE" },
        },
      ],
    }),
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["respond"],
  );
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
      view: {
        id: "V1",
        callback_id: "task:edit",
        private_metadata: JSON.stringify({ ts: "100.1" }),
        state: { values: {} },
      },
    }),
  );
  const answer = await response.json<any>();
  assert.equal(answer.response_action, "update");
  assert.equal(answer.view.title.text, "Out of date");
  assert.match(answer.view.blocks[0].text.text, OUTDATED);
  assert.deepEqual(calls, []);
});

test("what Slack sends is checked for what Cade routes it by, and answered 400 if it can't be read", async (t) => {
  const calls = mockSlack(t);
  for (const [path, body, problem] of [
    ["/slack/events", "not json", /event isn't JSON/],
    ["/slack/events", JSON.stringify({ type: "event_callback" }), /Give event\./],
    [
      "/slack/interactions",
      interaction({ type: "block_actions", user: { id: "UACTOR" }, actions: [] }),
      /actions needs at least 1 entry/,
    ],
    [
      "/slack/interactions",
      interaction({ type: "view_submission", user: { id: "UACTOR" }, view: {} }),
      /Give view\.callback_id\./,
    ],
    [
      "/slack/interactions",
      interaction({ type: "block_actions", actions: [{ action_id: "home:refresh" }] }),
      /Give user\./,
    ],
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
