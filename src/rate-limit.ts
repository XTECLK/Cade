import type { AppEnv } from "./env.ts";

// The MCP rate limit: how many tool calls one person's AI agent may make a minute. An agent stuck in a
// loop would otherwise make Slack calls without end, and Slack's own limits are the workspace's, so
// everyone's Cade would slow down. A minute's allowance is generous for a person working with their
// agent, who waits for each answer. Change it here.
export const MCP_CALLS_PER_MINUTE = 60;
const WINDOW_SECONDS = 60;

// Counts a tool call by `user`, and gives how many seconds to wait before the next one when they're
// over the limit, or 0 to go ahead. The count is kept in the database (mcp_calls), so it holds across
// the Worker's instances; each minute starts again from nothing. `now` is for the tests.
export async function mcpCallWait(env: Pick<AppEnv, "DB">, user: string, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const window = seconds - (seconds % WINDOW_SECONDS);
  // One statement, so two calls at once can't both read the old count.
  const row = await env.DB.prepare(
    `INSERT INTO mcp_calls (user_id, window_start, calls) VALUES (?, ?, 1)
     ON CONFLICT (user_id) DO UPDATE SET
       calls = CASE WHEN window_start = excluded.window_start THEN calls + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING calls`,
  )
    .bind(user, window)
    .first<{ calls: number }>();
  return (row?.calls ?? 0) > MCP_CALLS_PER_MINUTE ? window + WINDOW_SECONDS - seconds : 0;
}
