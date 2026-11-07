import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { hashToken, newToken } from "../src/access.js";
import { groupSetting, projects } from "../src/channels.js";
import { putWebToken } from "../src/db.js";
import worker from "../src/index.js";
import { fakeD1 } from "./d1.js";

const SIGNING_SECRET = "test-signing-secret";
const DB = fakeD1();
beforeEach(() => DB.reset());
const env = {
  DB,
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  PROJECTS: [{ name: "acme", channel: "CDEV", summaryCanvas: true }],
  // Every project has a Google Doc, which the Add project button has the web app make.
  GOOGLE_URL: "https://script.google.com/macros/s/test/exec",
  GOOGLE_SECRET: "g",
  // Only these can add projects and open the settings form.
  ADMINS: JSON.stringify(["UADMIN"]),
};
const ORIGIN = "https://worker.example.net";

async function sign(body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": `v0=${hex}` };
}

// A fake Slack API: `slack` maps a method to its result (or a function of its arguments).
function mock(t, slack = {}, google = () => ({ ok: true, id: "1NewDocNewDocNewDocNewDocNewDoc" })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url === env.GOOGLE_URL) {
      const body = JSON.parse(init.body);
      calls.push({ method: `google:${body.action}`, args: body });
      return Response.json(google(body));
    }
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

const people = { users: { info: null } };

async function slash(text, { user = "UADMIN", channel = "CNEW" } = {}) {
  const body = new URLSearchParams({ command: "/cade", text: `project ${text}`.trim(), user_id: user, channel_id: channel, trigger_id: "T1", response_url: "https://hooks.example/x" }).toString();
  const response = await worker.fetch(new Request(`${ORIGIN}/slack/commands`, { method: "POST", headers: await sign(body), body }), env, { waitUntil() {} });
  const answer = await response.text();
  return answer ? JSON.parse(answer).text : undefined;
}

// A signed-in session for `user`, as a cookie header.
async function session(user) {
  const code = newToken();
  await putWebToken(env, await hashToken(code), user, "session", 60);
  return `cade_session=${code}`;
}

// The page that needs a signed-in session, for the logout test.
const notes = (cookie) => worker.fetch(new Request(`${ORIGIN}/n/CDEV/1.1`, { headers: { cookie } }), env, { waitUntil() {} });

// An interaction as Slack sends it: a button or a form submitted.
async function interact(payload, environment = env) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const waits = [];
  const response = await worker.fetch(new Request(`${ORIGIN}/slack/interactions`, { method: "POST", headers: await sign(body), body }), environment, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  return response.text();
}

// The Add project form (see commands/project.js), submitted as `user`: what its fields hold.
const addForm = ({ channel = "CNEW", name = "", members = [], choices = {} } = {}, user = "UADMIN") => ({
  type: "view_submission",
  user: { id: user },
  view: {
    id: "VADD",
    callback_id: "project:add",
    state: {
      values: {
        channel: { value: { selected_conversation: channel } },
        name: { value: { value: name } },
        members: { value: { selected_users: members } },
        ...Object.fromEntries(Object.entries(choices).map(([key, value]) => [`s_${key}`, { value: { selected_option: { value } } }])),
      },
    },
  },
});
const textOf = (view) => view.blocks.map((block) => block.text?.text ?? "").join("\n");
// What the form said last: Cade turns it into "Adding…" and then into how it went.
const lastNotice = (calls) => textOf(JSON.parse(calls.findLast((call) => call.method === "views.update" && call.args.view_id === "VADD").args.view));
const answer = async (payload, environment) => JSON.parse((await interact(payload, environment)) || "{}");
const ADDING = { "views.update": {}, "views.publish": {}, "auth.test": { url: "https://acme.slack.com/" } };

test("Add project makes the channel a project, named after it, tells the admin, and shows it on the Home tab", async (t) => {
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, ...ADDING });
  const reply = await answer(addForm());
  // The form turns into a message that it is working, and then says how it went.
  assert.equal(reply.response_action, "update");
  assert.match(textOf(reply.view), /Adding \*payments\*/);
  assert.match(lastNotice(calls), /<#CNEW> is now the project \*payments\*/);
  // The Worker reads it as a project from then on (see withSettings in settings.js).
  const { withSettings } = await import("../src/settings.js");
  assert.deepEqual(projects(await withSettings(env)).map((project) => [project.name, project.channel]), [["acme", "CDEV"], ["payments", "CNEW"]]);
  // It is the project the Home tab shows, drawn again for the admin.
  assert.equal((await DB.prepare("SELECT home_project FROM user_preferences WHERE user_id = ?").bind("UADMIN").first()).home_project, "payments");
  assert.ok(calls.some((call) => call.method === "views.publish" && call.args.user_id === "UADMIN"));
  // The same channel again is refused on its field.
  assert.deepEqual((await answer(addForm())).errors, { channel: "This channel is the project payments already." });
  assert.deepEqual((await answer(addForm({ channel: "CDEV" }))).errors, { channel: "This channel is the project acme already." });
});

test("Add project keeps the people and the switches picked in the form", async (t) => {
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, ...ADDING });
  await answer(addForm({ members: ["UANN", "UBOB"], choices: { summaryCanvas: "on", newTaskDetection: "off", activeTasksPinning: "config" } }));
  assert.match(lastNotice(calls), /is now the project/);
  const { withSettings } = await import("../src/settings.js");
  const added = projects(await withSettings(env)).find((project) => project.channel === "CNEW");
  assert.deepEqual(added.members, ["UANN", "UBOB"]);
  assert.equal(added.summaryCanvas, true);
  assert.equal(added.newTaskDetection, false);
  assert.equal("activeTasksPinning" in added, false);
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
  assert.equal(calls.some((call) => call.method === "google:doc.create"), false);
  // A public channel Cade isn't in yet is joined.
  await answer(addForm({ name: "Billing team" }));
  assert.ok(calls.some((call) => call.method === "conversations.join" && call.args.channel === "CNEW"));
  assert.match(lastNotice(calls), /now the project \*Billing team\*/);
});

test("Add project makes the project's Google Doc first, and keeps it with the project", async (t) => {
  const docId = "1PaymentsDocPaymentsDocPayments";
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, ...ADDING }, () => ({ ok: true, id: docId }));
  await answer(addForm());
  assert.match(lastNotice(calls), new RegExp(`https://docs\\.google\\.com/document/d/${docId}/edit\\|a Google Doc`));
  assert.deepEqual(calls.filter((call) => call.method.startsWith("google:")).map((call) => [call.method, call.args.title]), [["google:doc.create", "payments executive summaries"]]);
  const { withSettings } = await import("../src/settings.js");
  assert.equal(projects(await withSettings(env)).find((p) => p.channel === "CNEW").workDoc, docId);
});

test("Add project needs Google set up, and adds nothing, saying why, when the doc can't be made", async (t) => {
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, ...ADDING }, () => ({ ok: false, error: "quota" }));
  const { withSettings } = await import("../src/settings.js");
  // The doc can't be made: the project isn't added, and the admin is told in the form.
  await answer(addForm());
  assert.match(lastNotice(calls), /:x: I couldn't add \*payments\*: I couldn't make the project's Google Doc just now \(Google web app refused doc\.create: quota\)\. Nothing was added/);
  assert.deepEqual(projects(await withSettings(env)).map((p) => p.name), ["acme"]);
  // If the form was closed before then, the admin is told in a message from Cade instead.
  const closed = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, ...ADDING, "views.update": new Error("not_found"), "chat.postMessage": {} }, () => ({ ok: false, error: "quota" }));
  await answer(addForm());
  const message = closed.find((call) => call.method === "chat.postMessage");
  assert.match(message.args.text, /couldn't add \*payments\*/);
  assert.equal(message.args.channel, "UADMIN");
  // Without Google, it does not work, and nothing else is asked of Slack.
  const bare = mock(t);
  assert.match((await answer(addForm(), { ...env, GOOGLE_URL: undefined })).errors.channel, /Google web app isn't set up yet: run `npm run google:create`/);
  assert.equal(bare.length, 0);
});

// The Project settings button in Configure on the Home tab (see home.js), pressed as `user`.
const openSettings = (channel, user = "UADMIN") =>
  interact({ type: "block_actions", user: { id: user }, trigger_id: "T1", actions: [{ action_id: "home:settings", value: channel }] });

const select = (view, key) => view.blocks.find((block) => block.block_id === `s_${key}`);
const chosen = (view, key) => select(view, key).element.initial_option.value;
const submitted = (channel, picks) => ({
  type: "view_submission",
  user: { id: "UADMIN" },
  view: {
    callback_id: "project:settings",
    private_metadata: channel,
    state: { values: Object.fromEntries(Object.entries(picks).map(([key, value]) => [`s_${key}`, { value: { selected_option: { value } } }])) },
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
  // The project list, with this channel's project chosen, and a choice for each switch.
  const picker = view.blocks[0].accessory;
  assert.deepEqual(picker.options.map((option) => option.text.text), ["acme"]);
  assert.equal(picker.initial_option.value, "CDEV");
  assert.deepEqual(view.blocks.filter((block) => block.type === "input").map((block) => block.block_id), ["members", "s_taskChangeDetection", "s_newTaskDetection", "s_activeTasksPinning", "s_summaryCanvas", "s_aiAgentSummary"]);
  assert.equal(view.blocks.some((block) => /name|channel/.test(block.block_id ?? "") && block.type === "input"), false);
  // The config says summaryCanvas is on; the choice starts as following it.
  assert.equal(chosen(view, "summaryCanvas"), "config");
  assert.deepEqual(select(view, "summaryCanvas").element.options.map((option) => option.text.text), ["Use the config (on)", "On", "Off"]);
  assert.match(select(view, "summaryCanvas").hint.text, /Now on\./);
});

test("saving the form keeps a setting over the config, and 'Use the config' puts it back", async (t) => {
  const calls = mock(t, { "chat.postEphemeral": {} });
  const { withSettings } = await import("../src/settings.js");
  const setting = async (key) => groupSetting(await withSettings(env), "CDEV", key);
  assert.equal(await setting("summaryCanvas"), true);

  assert.equal(await interact(submitted("CDEV", { summaryCanvas: "off", activeTasksPinning: "on", taskChangeDetection: "config" })), JSON.stringify({ response_action: "clear" }));
  assert.equal(await setting("summaryCanvas"), false);
  assert.equal(await setting("activeTasksPinning"), true);
  assert.match(calls.find((call) => call.method === "chat.postEphemeral").args.text, /Saved 2 settings for the project \*acme\*/);

  // Opening the form again shows what is chosen, and what the config says.
  const reopened = mock(t, { "views.open": {} });
  await openSettings("CDEV");
  const view = JSON.parse(reopened.find((call) => call.method === "views.open").args.view);
  assert.equal(chosen(view, "summaryCanvas"), "off");
  assert.equal(chosen(view, "activeTasksPinning"), "on");
  assert.deepEqual(select(view, "summaryCanvas").element.options.map((option) => option.text.text), ["Use the config (on)", "On", "Off"]);

  // The same again changes nothing; "config" goes back to the config.
  mock(t, { "chat.postEphemeral": (args) => (void (globalThis.lastText = args.text), {}) });
  await interact(submitted("CDEV", { summaryCanvas: "off" }));
  assert.match(globalThis.lastText, /Nothing changed/);
  await interact(submitted("CDEV", { summaryCanvas: "config", activeTasksPinning: "config" }));
  assert.equal(await setting("summaryCanvas"), true);
  assert.equal(await setting("activeTasksPinning"), undefined);

  // A non-admin's submission changes nothing, and an unknown value or project is ignored.
  await interact({ ...submitted("CDEV", { summaryCanvas: "off" }), user: { id: "UMEMBER" } });
  await interact(submitted("CDEV", { summaryCanvas: "maybe" }));
  await interact(submitted("CNOPE", { summaryCanvas: "off" }));
  assert.equal(await setting("summaryCanvas"), true);
  assert.deepEqual(projects(await withSettings(env)).map((project) => project.name), ["acme"]);
});

test("the project's people are picked in the form and kept, and emptying the list puts it back", async (t) => {
  const calls = mock(t, { "chat.postEphemeral": {}, "views.open": {} });
  const { withSettings, projectMembers } = await import("../src/settings.js");
  const members = async () => projectMembers(await withSettings(env), "CDEV");
  assert.deepEqual(await members(), []);
  const withPeople = (selected_users) => {
    const payload = submitted("CDEV", {});
    payload.view.state.values.members = { value: { selected_users } };
    return payload;
  };
  await interact(withPeople(["UBOB", "UANN"]));
  assert.deepEqual(await members(), ["UANN", "UBOB"]);
  assert.match(calls.find((call) => call.method === "chat.postEphemeral").args.text, /Saved 1 setting for the project \*acme\*/);
  await openSettings("CDEV");
  const view = JSON.parse(calls.findLast((call) => call.method === "views.open").args.view);
  assert.deepEqual(view.blocks.find((block) => block.block_id === "members").element.initial_users, ["UANN", "UBOB"]);
  // A submission that doesn't carry the field leaves them alone; an empty list clears them.
  await interact(submitted("CDEV", {}));
  assert.deepEqual(await members(), ["UANN", "UBOB"]);
  await interact(withPeople([]));
  assert.deepEqual(await members(), []);
});

test("picking another project in the form shows its settings, and a project added from the Home tab is one", async (t) => {
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, "views.update": {}, "views.publish": {}, "auth.test": { url: "https://acme.slack.com/" } });
  await interact(addForm());
  const pick = { type: "block_actions", user: { id: "UADMIN" }, view: { id: "V1", hash: "H1" }, actions: [{ action_id: "project:pick", selected_option: { value: "CNEW" } }] };
  await interact(pick);
  const update = calls.find((call) => call.method === "views.update" && call.args.view_id === "V1");
  assert.equal(update.args.view_id, "V1");
  assert.equal(update.args.hash, "H1");
  const view = JSON.parse(update.args.view);
  assert.equal(view.private_metadata, "CNEW");
  assert.deepEqual(view.blocks[0].accessory.options.map((option) => option.text.text), ["acme", "payments"]);
  assert.equal(view.blocks[0].accessory.initial_option.value, "CNEW");
  assert.match(select(view, "activeTasksPinning").element.options[0].text.text, /^Use the default \(/);
  assert.match(view.blocks[1].elements[0].text, /kept in Cade's database/);
  // A non-admin's pick does nothing.
  const before = calls.length;
  await interact({ ...pick, user: { id: "UMEMBER" } });
  assert.equal(calls.length, before);
});

test("the web pages modal's sign-out button ends every browser session of the person, and no one else's", async (t) => {
  const calls = mock(t);
  const mine = [await session("UADMIN"), await session("UADMIN")];
  const other = await session("UMEMBER");
  assert.equal((await notes(mine[0])).status, 404);
  // Presses a button in the modal (see commands/configure.js) and reads what Cade drew in answer.
  const press = async (actionId, user = "UADMIN") => {
    const before = calls.length;
    await interact({ type: "block_actions", user: { id: user }, trigger_id: "T1", view: { id: "V1" }, actions: [{ action_id: actionId, value: "" }] });
    const drawn = calls.slice(before).find((call) => call.method === "views.update" || call.method === "views.open");
    return JSON.parse(drawn.args.view).blocks.map((block) => block.text?.text ?? "").join("\n");
  };
  assert.match(await press("home:web:logout"), /Signed out of 2 browser sessions/);
  // Both sessions are gone, so the page asks to sign in; the other person's stays (a task page they can't find).
  assert.equal((await notes(mine[0])).status, 401);
  assert.equal((await notes(mine[1])).status, 401);
  assert.equal((await notes(other)).status, 404);
  assert.match(await press("home:web:logout"), /weren't signed in/);
  assert.match(await press("home:web:login"), /<https:\/\/worker\.example\.net\/login\/[\w-]+\|Sign in/);
  // Opening the modal only explains and offers the buttons; it makes no link.
  const opened = await press("home:web");
  assert.match(opened, /Sign in once in each browser/);
  assert.doesNotMatch(opened, /\/login\//);
});

