import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { hashToken, newToken } from "../src/access.ts";
import { groupSetting, projects } from "../src/channels.ts";
import { putWebToken } from "../src/db.ts";
import worker from "../src/index.ts";
import { fakeD1 } from "./d1.ts";
import type { AppEnv } from "../src/env.ts";
import type { TestContext } from "node:test";
import { context } from "./helpers.ts";
import type { ViewValues } from "../src/types.ts";

const SIGNING_SECRET = "test-signing-secret";
const DB = fakeD1();
beforeEach(() => DB.reset());
// The Worker's environment for the tests: the settings they need, and no AI binding unless a test adds one.
const env = {
  DB,
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  PROJECTS: [{ name: "acme", channel: "CDEV", summaryCanvas: true }],
  // Only these can add projects and open the settings form.
  ADMINS: JSON.stringify(["UADMIN"]),
} as unknown as AppEnv;
const ORIGIN = "https://worker.example.net";

async function sign(body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": `v0=${hex}` };
}

// A fake Slack API: `slack` maps a method to its result (or a function of its arguments).
function mock(t: TestContext, slack: Record<string, unknown> = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = new URL(url).pathname.split("/").pop();
    const args = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ method, args });
    const result = typeof slack[method] === "function" ? slack[method](args) : slack[method];
    if (result instanceof Error) return Response.json({ ok: false, error: result.message });
    return Response.json({ ok: true, ...result });
  };
  t.after(() => (globalThis.fetch = original));
  return calls;
}

// A signed-in session for `user`, as a cookie header.
async function session(user) {
  const code = newToken();
  await putWebToken(env, await hashToken(code), user, "session", 60);
  return `cade_session=${code}`;
}

// The page that needs a signed-in session, for the logout test.
const page = (cookie) => worker.fetch(new Request(`${ORIGIN}/t/CDEV/1.1`, { headers: { cookie } }), env, context());

// An interaction as Slack sends it: a button or a form submitted.
async function interact(payload, environment = env) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const waits: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request(`${ORIGIN}/slack/interactions`, { method: "POST", headers: await sign(body), body }), environment, context((promise) => { waits.push(promise); }));
  await Promise.all(waits);
  return response.text();
}

// The Add project form (see commands/project.js), submitted as `user`: what its fields hold.
const addForm = ({ channel = "CNEW", name = "", choices = {} } = {}, user = "UADMIN") => ({
  type: "view_submission",
  user: { id: user },
  view: {
    id: "VADD",
    callback_id: "project:add",
    state: {
      values: {
        channel: { value: { selected_conversation: channel } },
        name: { value: { value: name } },
        ...Object.fromEntries(Object.entries(choices).map(([key, value]) => [`s_${key}`, { value: { selected_option: { value } } }])),
      },
    },
  },
});
const textOf = (view) => view.blocks.map((block) => block.text?.text ?? "").join("\n");
// What the form said last: Cade turns it into "Adding…" and then into how it went.
const lastNotice = (calls) => textOf(JSON.parse(calls.findLast((call) => call.method === "views.update" && call.args.view_id === "VADD").args.view));
const answer = async (payload: unknown, environment?: AppEnv) => JSON.parse((await interact(payload, environment)) || "{}");
const ADDING = { "views.update": {}, "views.publish": {}, "auth.test": { url: "https://acme.slack.com/" } };

test("Add project makes the channel a project, named after it, tells the admin, and shows it on the Home tab", async (t) => {
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, ...ADDING });
  const reply = await answer(addForm());
  // The form turns into a message that it is working, and then says how it went.
  assert.equal(reply.response_action, "update");
  assert.match(textOf(reply.view), /Adding \*payments\*/);
  assert.match(lastNotice(calls), /<#CNEW> is now the project \*payments\*/);
  // The Worker reads it as a project from then on (see withSettings in settings.js).
  const { withSettings } = await import("../src/settings.ts");
  assert.deepEqual(projects(await withSettings(env)).map((project) => [project.name, project.channel]), [["acme", "CDEV"], ["payments", "CNEW"]]);
  // It is the project the Home tab shows, drawn again for the admin.
  assert.equal((await DB.prepare("SELECT home_project FROM user_preferences WHERE user_id = ?").bind("UADMIN").first()).home_project, "payments");
  assert.ok(calls.some((call) => call.method === "views.publish" && call.args.user_id === "UADMIN"));
  // The same channel again is refused on its field.
  assert.deepEqual((await answer(addForm())).errors, { channel: "This channel is the project payments already." });
  assert.deepEqual((await answer(addForm({ channel: "CDEV" }))).errors, { channel: "This channel is the project acme already." });
});

test("Add project keeps the switches picked in the form, and no list of people", async (t) => {
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, ...ADDING });
  await answer(addForm({ choices: { summaryCanvas: "on", newTaskDetection: "off", taskChangeDetection: "config" } }));
  assert.match(lastNotice(calls), /is now the project/);
  const { withSettings } = await import("../src/settings.ts");
  const added = projects(await withSettings(env)).find((project) => project.channel === "CNEW");
  assert.equal("members" in added, false);
  assert.equal(added.summaryCanvas, true);
  assert.equal(added.newTaskDetection, false);
  assert.equal("taskChangeDetection" in added, false);
});

test("Add project refuses a non-admin, a taken or bad name and a private channel Cade isn't in, each on its field; a public one is joined", async (t) => {
  const calls = mock(t, {
    "conversations.info": (args) => ({ channel: args.channel === "CPRIV" ? { name: "secret", is_private: true, is_member: false } : { name: "general", is_member: false } }),
    "conversations.join": {},
    ...ADDING,
  });
  assert.deepEqual(await answer(addForm({}, "UMEMBER")), { response_action: "clear" });
  assert.equal(calls.some((call) => call.method === "conversations.info"), false);
  assert.match((await answer(addForm({ name: "Acme" }))).errors.name, /project called Acme already/);
  assert.match((await answer(addForm({ name: "$$$" }))).errors.name, /up to 40 letters/);
  assert.match((await answer(addForm({ channel: "CPRIV" }))).errors.channel, /invite me with \/invite @Cade/i);
  // A public channel Cade isn't in yet is joined.
  await answer(addForm({ name: "Billing team" }));
  assert.ok(calls.some((call) => call.method === "conversations.join" && call.args.channel === "CNEW"));
  assert.match(lastNotice(calls), /now the project \*Billing team\*/);
});

test("Add project adds nothing, saying why, when the channel can't be joined", async (t) => {
  const failing = { "conversations.info": { channel: { name: "payments", is_member: false } }, ...ADDING, "conversations.join": new Error("is_archived") };
  const calls = mock(t, failing);
  const { withSettings } = await import("../src/settings.ts");
  await answer(addForm());
  assert.match(lastNotice(calls), /:x: I couldn't add \*payments\*: .*is_archived.*Nothing was added/);
  assert.deepEqual(projects(await withSettings(env)).map((p) => p.name), ["acme"]);
  // If the form was closed before then, the admin is told in a message from Cade instead.
  const closed = mock(t, { ...failing, "views.update": new Error("not_found"), "chat.postMessage": {} });
  await answer(addForm());
  const message = closed.find((call) => call.method === "chat.postMessage");
  assert.match(message.args.text, /couldn't add \*payments\*/);
  assert.equal(message.args.channel, "UADMIN");
});

// The Project settings button in Configure on the Home tab (see home.js), pressed as `user`.
const openSettings = (channel, user = "UADMIN") =>
  interact({ type: "block_actions", user: { id: user }, trigger_id: "T1", actions: [{ action_id: "home:settings", value: channel }] });

const select = (view, key) => view.blocks.find((block) => block.block_id === `s_${key}`);
const chosen = (view, key) => select(view, key).element.initial_option.value;
const submitted = (channel: string, picks: Record<string, string>) => ({
  type: "view_submission",
  user: { id: "UADMIN" },
  view: {
    callback_id: "project:settings",
    private_metadata: channel,
    state: { values: Object.fromEntries(Object.entries(picks).map(([key, value]) => [`s_${key}`, { value: { selected_option: { value } } }])) as ViewValues },
  },
});

test("the Project settings button opens a form with the channel's project, its name and channel not editable, for an admin only", async (t) => {
  const calls = mock(t, { "views.open": {} });
  await openSettings("CDEV", "UMEMBER");
  assert.equal(calls.some((call) => call.method === "views.open"), false);
  await openSettings("CDEV");
  const { args } = calls.find((call) => call.method === "views.open");
  assert.equal(args.trigger_id, "T1");
  const view = JSON.parse(args.view);
  assert.equal(view.callback_id, "project:settings");
  assert.equal(view.private_metadata, "CDEV");
  // The project it was opened for, by name, with no list to pick another, and a choice for each switch.
  assert.equal(view.blocks[0].text.text, "*acme*");
  assert.equal(view.blocks.some((block) => block.accessory?.type === "static_select"), false);
  assert.deepEqual(view.blocks.filter((block) => block.type === "input").map((block) => block.block_id), ["s_taskChangeDetection", "s_newTaskDetection", "s_summaryCanvas"]);
  assert.equal(view.blocks.some((block) => /name|channel/.test(block.block_id ?? "") && block.type === "input"), false);
  // The config says summaryCanvas is on; the choice starts as following it.
  assert.equal(chosen(view, "summaryCanvas"), "config");
  assert.deepEqual(select(view, "summaryCanvas").element.options.map((option) => option.text.text), ["Use the config (on)", "On", "Off"]);
  assert.match(select(view, "summaryCanvas").hint.text, /Now on\./);
});

test("saving the form keeps a setting over the config, and 'Use the config' puts it back", async (t) => {
  const calls = mock(t, { "chat.postEphemeral": {} });
  const { withSettings } = await import("../src/settings.ts");
  const setting = async (key) => groupSetting(await withSettings(env), "CDEV", key);
  assert.equal(await setting("summaryCanvas"), true);

  assert.equal(await interact(submitted("CDEV", { summaryCanvas: "off", newTaskDetection: "off", taskChangeDetection: "config" })), JSON.stringify({ response_action: "clear" }));
  assert.equal(await setting("summaryCanvas"), false);
  assert.equal(await setting("newTaskDetection"), false);
  assert.match(calls.find((call) => call.method === "chat.postEphemeral").args.text, /Saved 2 settings for the project \*acme\*/);

  // Opening the form again shows what is chosen, and what the config says.
  const reopened = mock(t, { "views.open": {} });
  await openSettings("CDEV");
  const view = JSON.parse(reopened.find((call) => call.method === "views.open").args.view);
  assert.equal(chosen(view, "summaryCanvas"), "off");
  assert.equal(chosen(view, "newTaskDetection"), "off");
  assert.deepEqual(select(view, "summaryCanvas").element.options.map((option) => option.text.text), ["Use the config (on)", "On", "Off"]);

  // The same again changes nothing; "config" goes back to the config.
  mock(t, { "chat.postEphemeral": (args) => (void (globalThis.lastText = args.text), {}) });
  await interact(submitted("CDEV", { summaryCanvas: "off" }));
  assert.match(globalThis.lastText, /Nothing changed/);
  await interact(submitted("CDEV", { summaryCanvas: "config", newTaskDetection: "config" }));
  assert.equal(await setting("summaryCanvas"), true);
  assert.equal(await setting("newTaskDetection"), undefined);

  // A non-admin's submission changes nothing, and an unknown value or project is ignored.
  await interact({ ...submitted("CDEV", { summaryCanvas: "off" }), user: { id: "UMEMBER" } });
  await interact(submitted("CDEV", { summaryCanvas: "maybe" }));
  await interact(submitted("CNOPE", { summaryCanvas: "off" }));
  assert.equal(await setting("summaryCanvas"), true);
  assert.deepEqual(projects(await withSettings(env)).map((project) => project.name), ["acme"]);
});

test("the settings form shows the people in the project's channel, as Cade keeps no list of its own", async (t) => {
  const calls = mock(t, { "conversations.members": { members: ["UBOB", "UANN"] }, "views.open": {} });
  await openSettings("CDEV");
  const view = JSON.parse(calls.findLast((call) => call.method === "views.open").args.view);
  assert.equal(view.blocks.find((block) => block.block_id === "members"), undefined, "nothing to pick");
  const people = view.blocks.find((block) => block.text?.text?.startsWith("*People*"));
  assert.equal(people.text.text, "*People*\n<@UBOB>, <@UANN>");
  assert.equal(calls.find((call) => call.method === "conversations.members").args.channel, "CDEV");

  // A big channel is cut short; one Slack won't say about says so.
  const many = mock(t, { "conversations.members": { members: Array.from({ length: 45 }, (_, i) => `U${i}`) }, "views.open": {} });
  await openSettings("CDEV");
  assert.match(JSON.stringify(JSON.parse(many.findLast((call) => call.method === "views.open").args.view).blocks), /and 5 more/);
  const hidden = mock(t, { "conversations.members": new Error("channel_not_found"), "views.open": {} });
  await openSettings("CDEV");
  assert.match(JSON.stringify(JSON.parse(hidden.findLast((call) => call.method === "views.open").args.view).blocks), /couldn't read who is in the channel/);
});

test("a project added from the Home tab opens its own settings, as one kept in Cade's database", async (t) => {
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, "views.update": {}, "views.open": {}, "views.publish": {}, "auth.test": { url: "https://acme.slack.com/" } });
  await interact(addForm());
  await openSettings("CNEW");
  const view = JSON.parse(calls.filter((call) => call.method === "views.open").at(-1).args.view);
  assert.equal(view.private_metadata, "CNEW");
  assert.equal(view.blocks[0].text.text, "*payments*");
  assert.match(select(view, "newTaskDetection").element.options[0].text.text, /^Use the default \(/);
  assert.match(view.blocks[1].elements[0].text, /kept in Cade's database/);
});

test("the web pages modal's sign-out button ends every browser session of the person, and no one else's", async (t) => {
  const calls = mock(t);
  const mine = [await session("UADMIN"), await session("UADMIN")];
  const other = await session("UMEMBER");
  assert.equal((await page(mine[0])).status, 404);
  // Presses a button in the modal (see commands/configure.js) and reads what Cade drew in answer.
  const press = async (actionId, user = "UADMIN") => {
    const before = calls.length;
    await interact({ type: "block_actions", user: { id: user }, trigger_id: "T1", view: { id: "V1" }, actions: [{ action_id: actionId, value: "" }] });
    const drawn = calls.slice(before).find((call) => call.method === "views.update" || call.method === "views.open");
    return JSON.parse(drawn.args.view).blocks.map((block) => block.text?.text ?? "").join("\n");
  };
  assert.match(await press("home:web:logout"), /Signed out of 2 browser sessions/);
  // Both sessions are gone, so the page asks to sign in; the other person's stays (a task page they can't find).
  assert.equal((await page(mine[0])).status, 401);
  assert.equal((await page(mine[1])).status, 401);
  assert.equal((await page(other)).status, 404);
  assert.match(await press("home:web:logout"), /weren't signed in/);
  assert.match(await press("home:web:login"), /<https:\/\/worker\.example\.net\/login\/[\w-]+\|Sign in/);
  // Opening the modal only explains and offers the buttons; it makes no link.
  const opened = await press("home:web");
  assert.match(opened, /Sign in once in each browser/);
  assert.doesNotMatch(opened, /\/login\//);
});

