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
  // Only these can run /cade project and open the projects page.
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
function mock(t, slack = {}) {
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

const people = { users: { info: null } };

async function slash(text, { user = "UADMIN", channel = "CNEW" } = {}) {
  const body = new URLSearchParams({ command: "/cade", text: `project ${text}`.trim(), user_id: user, channel_id: channel, trigger_id: "T1", response_url: "https://hooks.example/x" }).toString();
  const response = await worker.fetch(new Request(`${ORIGIN}/slack/commands`, { method: "POST", headers: await sign(body), body }), env, { waitUntil() {} });
  return (await response.json()).text;
}

// A signed-in session for `user`, as a cookie header.
async function session(user) {
  const code = newToken();
  await putWebToken(env, await hashToken(code), user, "session", 60);
  return `cade_session=${code}`;
}

const admin = (cookie, init = {}) => worker.fetch(new Request(`${ORIGIN}/admin`, { ...init, headers: { cookie, ...init.headers } }), env, { waitUntil() {} });
const form = (values) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }, body: new URLSearchParams(values).toString() });

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
  // settings gives the page's link, and a sign-in link.
  const settings = await slash("settings");
  assert.match(settings, /<https:\/\/worker\.example\.net\/admin\|Project settings>/);
  assert.match(settings, /<https:\/\/worker\.example\.net\/login\/[\w-]+\|use this link>/);
  assert.match(await slash("settings", { user: "UMEMBER" }), /Only an admin can use `\/cade project`/);
});

test("the admin page is for workspace admins, and lists each project with its settings", async (t) => {
  mock(t, {});
  assert.equal((await admin("")).status, 401);
  assert.equal((await admin(await session("UMEMBER"))).status, 403);
  const page = await admin(await session("UADMIN"));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<h2>acme<\/h2>/);
  assert.match(html, /Channel <code>CDEV<\/code>/);
  assert.match(html, /name and channel are set in cade\.config\.json/);
  assert.match(html, /Summary canvas<\/strong>/);
  // The config says summaryCanvas is on; the others follow the default.
  assert.match(html, /Use the config \(on\)/);
  assert.doesNotMatch(html, /name="CDEV\|(aiModel|name|channel)"/);
});

test("saving the admin page keeps a setting over the config, and 'Use the config' puts it back", async (t) => {
  mock(t, {});
  const cookie = await session("UADMIN");
  const { withSettings } = await import("../src/settings.js");
  const setting = async () => groupSetting(await withSettings(env), "CDEV", "summaryCanvas");
  assert.equal(await setting(), true);

  const saved = await admin(cookie, form({ "CDEV|summaryCanvas": "off", "CDEV|activeTasksPinning": "on" }));
  assert.equal(saved.status, 200);
  assert.match(await saved.text(), /Saved: 2 settings changed/);
  assert.equal(await setting(), false);
  assert.equal(groupSetting(await withSettings(env), "CDEV", "activeTasksPinning"), true);
  // The page shows what the config says, and what is chosen.
  const html = await (await admin(cookie)).text();
  assert.match(html, /Use the config \(on\)/);
  assert.match(html, /<option value="off" selected>/);

  // Saving the same again changes nothing; "" goes back to the config.
  assert.match(await (await admin(cookie, form({ "CDEV|summaryCanvas": "off" }))).text(), /Nothing changed/);
  await admin(cookie, form({ "CDEV|summaryCanvas": "", "CDEV|activeTasksPinning": "" }));
  assert.equal(await setting(), true);
  assert.equal(groupSetting(await withSettings(env), "CDEV", "activeTasksPinning"), undefined);

  // A non-admin can't save, nor can another site.
  assert.equal((await admin(await session("UMEMBER"), form({ "CDEV|summaryCanvas": "off" }))).status, 403);
  assert.equal((await admin(cookie, { ...form({ "CDEV|summaryCanvas": "off" }), headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" } })).status, 403);
  assert.equal(await setting(), true);
  // Name and channel can't be sent: unknown fields are ignored.
  await admin(cookie, form({ "CDEV|name": "hijacked", "CNOPE|summaryCanvas": "on" }));
  assert.deepEqual(projects(await withSettings(env)).map((project) => project.name), ["acme"]);
});

test("a project added with /cade project init has settings on the page, which default to the instance's", async (t) => {
  mock(t, { "conversations.info": { channel: { name: "payments", is_member: true } } });
  await slash("init");
  const cookie = await session("UADMIN");
  const html = await (await admin(cookie)).text();
  assert.match(html, /<h2>payments<\/h2>/);
  assert.match(html, /added with \/cade project init/);
  assert.match(html, /Use the default \(/);
  await admin(cookie, form({ "CNEW|activeTasksPinning": "on" }));
  const { withSettings } = await import("../src/settings.js");
  assert.equal(groupSetting(await withSettings(env), "CNEW", "activeTasksPinning"), true);
});

test("/cade web logout ends every browser session of the person, and no one else's", async (t) => {
  mock(t);
  const mine = [await session("UADMIN"), await session("UADMIN")];
  const other = await session("UMEMBER");
  assert.equal((await admin(mine[0])).status, 200);
  const reply = async (text, user = "UADMIN") => {
    const body = new URLSearchParams({ command: "/cade", text, user_id: user, channel_id: "CDEV", trigger_id: "T1", response_url: "https://hooks.example/x" }).toString();
    return (await (await worker.fetch(new Request(`${ORIGIN}/slack/commands`, { method: "POST", headers: await sign(body), body }), env, { waitUntil() {} })).json()).text;
  };
  assert.match(await reply("web logout"), /Signed out of 2 browser sessions/);
  // Both sessions are gone, so the page asks to sign in; the other person's stays.
  assert.equal((await admin(mine[0])).status, 401);
  assert.equal((await admin(mine[1])).status, 401);
  assert.equal((await admin(other)).status, 403);
  assert.match(await reply("web logout"), /weren't signed in/);
  assert.match(await reply("web login"), /<https:\/\/worker\.example\.net\/login\/[\w-]+\|Sign in/);
  assert.match(await reply("web"), /\/cade web logout/);
});
