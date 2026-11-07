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
  // Every project has a Google Doc, which /cade project init has the web app make.
  GOOGLE_URL: "https://script.google.com/macros/s/test/exec",
  GOOGLE_SECRET: "g",
  // Only these can run /cade project and open the settings form.
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
async function interact(payload) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const waits = [];
  const response = await worker.fetch(new Request(`${ORIGIN}/slack/interactions`, { method: "POST", headers: await sign(body), body }), env, { waitUntil: (promise) => waits.push(promise) });
  await Promise.all(waits);
  return response.text();
}

test("/cade project init makes the channel a project, named after it, for a workspace admin", async (t) => {
  mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } } });
  const reply = await slash("init");
  assert.match(reply, /<#CNEW> is now the project \*payments\*/);
  // The Worker reads it as a project from then on (see withSettings in settings.js).
  const { withSettings } = await import("../src/settings.js");
  assert.deepEqual(projects(await withSettings(env)).map((project) => [project.name, project.channel]), [["acme", "CDEV"], ["payments", "CNEW"]]);
  // Again in the same channel, or in a project of the config, only warns.
  assert.match(await slash("init"), /already the project \*payments\*, so there is nothing to add/);
  assert.match(await slash("init", { channel: "CDEV" }), /already the project \*acme\*/);
  assert.match(await slash("", { channel: "CNEW" }), /This channel is the project \*payments\*/);
  assert.match(await slash("", { channel: "COTHER" }), /isn't a project yet/);
});

test("/cade project init takes a name, and refuses a non-admin, a taken name, a bad name and a direct message", async (t) => {
  const calls = mock(t, {
    "conversations.info": (args) => ({ channel: args.channel === "CDM" ? { is_im: true } : args.channel === "CPRIV" ? { name: "secret", is_private: true, is_member: false } : { name: "general", is_member: false } }),
    "conversations.join": {},
  });
  assert.match(await slash("init", { user: "UMEMBER" }), /Only an admin can use `\/cade project`/);
  assert.match(await slash("init Acme"), /project called \*Acme\* already/);
  assert.match(await slash("init $$$"), /up to 40 letters/);
  assert.match(await slash("init", { channel: "CDM" }), /not a direct message/);
  assert.match(await slash("init", { channel: "CPRIV" }), /invite me with `\/invite @Cade`/i);
  // A public channel Cade isn't in yet is joined.
  assert.match(await slash("init Billing team"), /now the project \*Billing team\*/);
  assert.ok(calls.some((call) => call.method === "conversations.join" && call.args.channel === "CNEW"));
  assert.match(await slash("nope"), /Send `\/cade project init`/);
  assert.match(await slash("settings", { user: "UMEMBER" }), /Only an admin can use `\/cade project`/);
});

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

test("/cade project settings opens a form with the channel's project, its name and channel not editable", async (t) => {
  const calls = mock(t, { "views.open": {} });
  assert.equal(await slash("settings", { channel: "CDEV" }), undefined);
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
  await slash("settings", { channel: "CDEV" });
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
  await slash("settings", { channel: "CDEV" });
  const view = JSON.parse(calls.findLast((call) => call.method === "views.open").args.view);
  assert.deepEqual(view.blocks.find((block) => block.block_id === "members").element.initial_users, ["UANN", "UBOB"]);
  // A submission that doesn't carry the field leaves them alone; an empty list clears them.
  await interact(submitted("CDEV", {}));
  assert.deepEqual(await members(), ["UANN", "UBOB"]);
  await interact(withPeople([]));
  assert.deepEqual(await members(), []);
});

test("picking another project in the form shows its settings, and a project added with /cade project init is one", async (t) => {
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } }, "views.update": {} });
  await slash("init");
  const pick = { type: "block_actions", user: { id: "UADMIN" }, view: { id: "V1", hash: "H1" }, actions: [{ action_id: "project:pick", selected_option: { value: "CNEW" } }] };
  await interact(pick);
  const update = calls.find((call) => call.method === "views.update");
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

test("/cade web logout ends every browser session of the person, and no one else's", async (t) => {
  mock(t);
  const mine = [await session("UADMIN"), await session("UADMIN")];
  const other = await session("UMEMBER");
  assert.equal((await notes(mine[0])).status, 404);
  const reply = async (text, user = "UADMIN") => {
    const body = new URLSearchParams({ command: "/cade", text, user_id: user, channel_id: "CDEV", trigger_id: "T1", response_url: "https://hooks.example/x" }).toString();
    return (await (await worker.fetch(new Request(`${ORIGIN}/slack/commands`, { method: "POST", headers: await sign(body), body }), env, { waitUntil() {} })).json()).text;
  };
  assert.match(await reply("web logout"), /Signed out of 2 browser sessions/);
  // Both sessions are gone, so the page asks to sign in; the other person's stays (a task page they can't find).
  assert.equal((await notes(mine[0])).status, 401);
  assert.equal((await notes(mine[1])).status, 401);
  assert.equal((await notes(other)).status, 404);
  assert.match(await reply("web logout"), /weren't signed in/);
  assert.match(await reply("web login"), /<https:\/\/worker\.example\.net\/login\/[\w-]+\|Sign in/);
  assert.match(await reply("web"), /\/cade web logout/);
});

test("/cade project init makes the project's Google Doc first, and keeps it with the project", async (t) => {
  const docId = "1PaymentsDocPaymentsDocPayments";
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } } }, () => ({ ok: true, id: docId }));
  const reply = await slash("init");
  assert.match(reply, /now the project \*payments\*/);
  assert.match(reply, new RegExp(`https://docs\\.google\\.com/document/d/${docId}/edit\\|a Google Doc`));
  assert.deepEqual(calls.filter((call) => call.method.startsWith("google:")).map((call) => [call.method, call.args.title]), [["google:doc.create", "payments executive summaries"]]);
  const { withSettings } = await import("../src/settings.js");
  assert.equal(projects(await withSettings(env)).find((p) => p.channel === "CNEW").workDoc, docId);
});

test("/cade project init needs Google set up, and adds nothing when the doc can't be made", async (t) => {
  const calls = mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } } }, () => ({ ok: false, error: "quota" }));
  const { withSettings } = await import("../src/settings.js");
  // The doc can't be made: the project isn't added.
  assert.match(await slash("init"), /couldn't make the project's Google Doc just now \(Google web app refused doc\.create: quota\), so I haven't added it/);
  assert.deepEqual(projects(await withSettings(env)).map((p) => p.name), ["acme"]);
  // Without Google, it does not work.
  const bare = { ...env, GOOGLE_URL: undefined };
  const run = async (text) => {
    const body = new URLSearchParams({ command: "/cade", text: `project ${text}`, user_id: "UADMIN", channel_id: "CNEW", trigger_id: "T1", response_url: "https://hooks.example/x" }).toString();
    return (await (await worker.fetch(new Request(`${ORIGIN}/slack/commands`, { method: "POST", headers: await sign(body), body }), bare, { waitUntil() {} })).json()).text;
  };
  const before = calls.length;
  assert.match(await run("init"), /Google web app isn't set up yet: run `npm run google:create`/);
  assert.equal(calls.length, before);
});
