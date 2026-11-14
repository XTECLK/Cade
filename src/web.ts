import { hashToken, newToken, readableName } from "./access.ts";
import { deleteWebToken, putWebToken, taskTitleOf, threadMessages, webTokenUser } from "./db.ts";
import { nameMap, plain, userIds } from "./export.ts";
import { publicUrl } from "./links.ts";
import { formatTime } from "./format.ts";
import type { AppEnv } from "./env.ts";

// The Worker's own page, for what is kept in the database rather than in
// Slack:
//
//   /t/<channel>/<ts>   a task's thread, from the first message to the latest
//
// It is for people who can read the task's channel (a private one's
// members; anyone in a public one), signed in with a link the Home tab's Web pages button gives
// in Slack: it is used once within ten minutes and sets a cookie that lasts
// thirty days. Only hashes of the link and the cookie are kept (web_tokens).
const COOKIE = "cade_session";
const LOGIN_MINUTES = 10;
const SESSION_MINUTES = 30 * 24 * 60;

const CHANNEL = /^[CGD][A-Z0-9]+$/;
const TS = /^\d{1,12}\.\d{1,8}$/;

// Makes a sign-in link for `user`, on the Worker, replacing any they hadn't used.
export async function loginLink(env: AppEnv, user: string) {
  const code = newToken();
  await putWebToken(env, await hashToken(code), user, "login", LOGIN_MINUTES);
  return `${publicUrl(env)}/login/${code}`;
}

export async function handleWeb(request: Request, env: AppEnv) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  // Each is there by the time it is used: the checks below go by how many parts there are.
  const [kind, channel, ts] = parts as [string, string, string];

  if (kind === "login" && parts.length === 2) return signIn(request, env, parts[1]!);
  if (kind === "logout" && parts.length === 1) return signOut(request, env);
  if (kind !== "t" || parts.length !== 3 || !CHANNEL.test(channel) || !TS.test(ts)) return page(404, "Not found", "<p>There's no page here.</p>");

  const user = await currentUser(request, env);
  if (!user) return page(401, "Sign in", SIGN_IN);
  const title = await taskTitleOf(env, channel, ts);
  // Someone who can't read the channel is told no more than that there's nothing for them.
  const where = title === null ? null : await readableName(env, channel, user);
  if (where === null) return page(404, "Not found", "<p>There's no such task, or you can't read its channel.</p>");

  if (request.method !== "GET") return methodNotAllowed("GET");
  return threadPage(env, channel, ts, title!, where);
}

// The signed-in user, or null.
async function currentUser(request: Request, env: AppEnv) {
  const cookie = sessionToken(request);
  return cookie ? await webTokenUser(env, await hashToken(cookie), "session") : null;
}

const SIGN_IN = "<p>In Slack, open Cade's Home tab, press <b>Web pages</b>, then <b>Get a sign-in link</b>. The link signs you in here for thirty days; then open this page again.</p>";

function sessionToken(request: Request) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return null;
}

async function signIn(request: Request, env: AppEnv, code: string) {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const user = /^[A-Za-z0-9_-]{43}$/.test(code) ? await webTokenUser(env, await hashToken(code), "login") : null;
  if (!user) return page(401, "Link expired", "<p>This sign-in link was used already or has expired. In Slack, open Cade's Home tab and press <b>Web pages</b> for a new one.</p>");
  const session = newToken();
  await putWebToken(env, await hashToken(session), user, "session", SESSION_MINUTES);
  return page(200, "Signed in", "<p>You're signed in for thirty days. Open the task's link in Slack again.</p>", {
    "set-cookie": `${COOKIE}=${session}; Max-Age=${SESSION_MINUTES * 60}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  });
}

async function signOut(request: Request, env: AppEnv) {
  const cookie = sessionToken(request);
  if (cookie) await deleteWebToken(env, await hashToken(cookie));
  return page(200, "Signed out", "<p>You're signed out.</p>", { "set-cookie": `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` });
}

async function threadPage(env: AppEnv, channel: string, ts: string, title: string, where: string) {
  const messages = await threadMessages(env, channel, ts);
  const names = await nameMap(env, userIds(messages));
  const items = messages.map((message) => {
    const who = message.user ? names.get(message.user) : (message.username ?? "Someone");
    const when = formatTime(env, new Date(Number(message.ts) * 1000));
    let text = plain(message.text ?? "", names);
    if (message.files?.length) text += `${text ? "\n" : ""}(attachment: ${message.files.map((file) => file.name).join(", ")})`;
    return `<article><header><strong>${escapeHtml(who!)}</strong> <time>${escapeHtml(when)}</time></header><p>${escapeHtml(text || "(no text)")}</p></article>`;
  });
  const body = items.length ? items.join("") : "<p>No messages are stored for this task yet. A workspace admin can send <code>/cade resync</code> with the task's link to read them from Slack.</p>";
  return page(200, `Thread: ${title}`, `<p class="meta">#${escapeHtml(where)} · ${messages.length} message${messages.length === 1 ? "" : "s"}</p>${body}`);
}

const methodNotAllowed = (allow: string) => new Response("Method not allowed", { status: 405, headers: { allow } });

export function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[char]!);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1d1c1d;--muted:#616061;--line:#ddd;--accent:#1264a3;--card:#f8f8f8}
@media (prefers-color-scheme:dark){:root{--bg:#1a1d21;--fg:#d1d2d3;--muted:#ababad;--line:#35383d;--accent:#5eb3f0;--card:#222529}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0 0 4px}
a{color:var(--accent)}code{background:var(--card);padding:1px 5px;border-radius:4px}
.meta{color:var(--muted);font-size:.9rem;margin:2px 0 12px}
article{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:10px 14px;margin:10px 0}
article header{font-size:.9rem}article time{color:var(--muted);margin-left:6px}
article p{white-space:pre-wrap;margin:4px 0 0;overflow-wrap:anywhere}
`;

function page(status: number, title: string, content: string, headers: Record<string, string> = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
}
