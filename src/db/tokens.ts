// Sign-in links and sessions for the web pages (see web.ts), and people's MCP API keys (see mcp-keys.ts).
// Only a hash of each is kept.
import type { DbEnv } from "./common.ts";

export type WebTokenKind = "login" | "session";

// Keeps the hash of a web sign-in token for `user`: a 'login' for `minutes`,
// a 'session' for `minutes` too. Old and used ones are cleared as new are made.
export async function putWebToken(env: DbEnv, hash: string, user: string, kind: WebTokenKind, minutes: number) {
  await env.DB.prepare("DELETE FROM web_tokens WHERE expires_at < datetime('now')").run();
  if (kind === "login")
    await env.DB.prepare("DELETE FROM web_tokens WHERE user_id = ? AND kind = 'login'").bind(user).run();
  await env.DB.prepare(
    "INSERT INTO web_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, datetime('now', ?))",
  )
    .bind(hash, user, kind, `+${minutes} minutes`)
    .run();
}

// The user a live token of this kind belongs to, or null. A 'login' is used
// up by being looked up.
export async function webTokenUser(env: DbEnv, hash: string, kind: WebTokenKind) {
  const sql =
    kind === "login"
      ? "DELETE FROM web_tokens WHERE token_hash = ? AND kind = ? AND expires_at > datetime('now') RETURNING user_id"
      : "SELECT user_id FROM web_tokens WHERE token_hash = ? AND kind = ? AND expires_at > datetime('now')";
  const row = await env.DB.prepare(sql).bind(hash, kind).first<{ user_id: string }>();
  return row ? row.user_id : null;
}

export async function deleteWebToken(env: DbEnv, hash: string) {
  await env.DB.prepare("DELETE FROM web_tokens WHERE token_hash = ?").bind(hash).run();
}

// How many browsers `user` is signed in on: their live sessions.
export async function webSessionsOf(env: DbEnv, user: string) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM web_tokens WHERE user_id = ? AND kind = 'session' AND expires_at > datetime('now')",
  )
    .bind(user)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// Ends every sign-in of `user`, the browsers' sessions and any sign-in link not used yet;
// returns how many sessions there were.
export async function deleteWebTokensOf(env: DbEnv, user: string) {
  const { results } = await env.DB.prepare("DELETE FROM web_tokens WHERE user_id = ? RETURNING kind")
    .bind(user)
    .all<{ kind: WebTokenKind }>();
  return results.filter((row) => row.kind === "session").length;
}

// Keeps `hash` as the MCP token of `user`, in place of any they had.
export async function putMcpToken(env: DbEnv, user: string, hash: string) {
  await env.DB.prepare(
    `INSERT INTO mcp_tokens (user_id, token_hash) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = CURRENT_TIMESTAMP`,
  )
    .bind(user, hash)
    .run();
}

// Whether the user has an MCP token.
// When the user's API key was made, in SQLite's datetime form, or null.
export async function mcpTokenCreated(env: DbEnv, user: string) {
  return (
    (
      await env.DB.prepare("SELECT created_at FROM mcp_tokens WHERE user_id = ?")
        .bind(user)
        .first<{ created_at: string }>()
    )?.created_at ?? null
  );
}

export async function hasMcpToken(env: DbEnv, user: string) {
  return Boolean(await env.DB.prepare("SELECT 1 AS found FROM mcp_tokens WHERE user_id = ?").bind(user).first());
}

// The user whose MCP token has this hash, or null.
export async function mcpTokenUser(env: DbEnv, hash: string) {
  const row = await env.DB.prepare("SELECT user_id FROM mcp_tokens WHERE token_hash = ?")
    .bind(hash)
    .first<{ user_id: string }>();
  return row ? row.user_id : null;
}

// Removes the user's MCP token, and returns whether they had one.
export async function deleteMcpToken(env: DbEnv, user: string) {
  const row = await env.DB.prepare("DELETE FROM mcp_tokens WHERE user_id = ? RETURNING user_id").bind(user).first();
  return Boolean(row);
}
