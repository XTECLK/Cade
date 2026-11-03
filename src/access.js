import { callSlack } from "./slack.js";

const MEMBER_PAGES = 5;

// Whether `user` is in the private channel `channel`.
export async function isMember(env, channel, user) {
  let cursor;
  for (let page = 0; page < MEMBER_PAGES; page++) {
    const data = await callSlack(env, "conversations.members", { channel, limit: 1000, cursor });
    if (data.members?.includes(user)) return true;
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) return false;
  }
  return false;
}

// Whether `user` may read what is said in `channel`, as everyone may in a
// public one and only its members in a private one; never a direct message.
// Returns the channel's name if so, or null.
export async function readableName(env, channel, user) {
  let info;
  try {
    ({ channel: info } = await callSlack(env, "conversations.info", { channel }));
  } catch (error) {
    console.warn("Could not look up the channel", { channel, error: error.message });
    return null;
  }
  if (info.is_im || info.is_mpim) return null;
  if (info.is_private && !(await isMember(env, channel, user))) return null;
  return info.name ?? channel;
}

const encoder = new TextEncoder();

// The SHA-256 of a token as hex: only this is kept of one, so it can't be read back.
export async function hashToken(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A new random token: 43 URL-safe characters.
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
