// Each person's own settings and state: the Home tab's project and view, suggestions on or off, their run of
// rejected suggestions, and the names kept for people (see export.ts).
import type { DbEnv } from "./common.ts";

// The id of the canvas Cade keeps the channel's summary in, or null.
// The group name the person's Home tab shows, or null for every group.
export async function getHomeProject(env: DbEnv, user: string) {
  const row = await env.DB.prepare("SELECT home_project FROM user_preferences WHERE user_id = ?")
    .bind(user)
    .first<{ home_project: string | null }>();
  return row?.home_project ?? null;
}

export async function setHomeProject(env: DbEnv, user: string, project: string | null) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, home_project) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET home_project = excluded.home_project`,
  )
    .bind(user, project)
    .run();
}

// The Home tab view the person last used, or null.
export async function getHomeTab(env: DbEnv, user: string) {
  const row = await env.DB.prepare("SELECT home_tab FROM user_preferences WHERE user_id = ?")
    .bind(user)
    .first<{ home_tab: string | null }>();
  return row?.home_tab ?? null;
}

export async function setHomeTab(env: DbEnv, user: string, tab: string | null) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, home_tab) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET home_tab = excluded.home_tab`,
  )
    .bind(user, tab)
    .run();
}

// Whether the suggestions Cade offers the person from their own messages are on: they are unless
// the person turned them off.
export async function suggestionsOn(env: DbEnv, user: string) {
  const row = await env.DB.prepare("SELECT suggestions FROM user_preferences WHERE user_id = ?")
    .bind(user)
    .first<{ suggestions: number }>();
  return row ? Boolean(row.suggestions) : true;
}

// Turning them on or off starts the count of rejects in a row again.
export async function setSuggestions(env: DbEnv, user: string, on: boolean) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, suggestions) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET suggestions = excluded.suggestions, suggestion_rejects = 0`,
  )
    .bind(user, on ? 1 : 0)
    .run();
}

// Counts one more suggestion the person rejected, and returns how many that makes in a row. While
// the count is paused (see pauseRejects) nothing is counted, and it returns 0.
export async function countReject(env: DbEnv, user: string) {
  const row = await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, suggestion_rejects) VALUES (?, 1)
     ON CONFLICT (user_id) DO UPDATE SET suggestion_rejects =
       CASE WHEN rejects_paused_until > datetime('now') THEN 0 ELSE suggestion_rejects + 1 END
     RETURNING suggestion_rejects`,
  )
    .bind(user)
    .first<{ suggestion_rejects: number }>();
  return row?.suggestion_rejects ?? 0;
}

// Starts the count of rejects in a row again, as accepting or editing a suggestion does.
export async function resetRejects(env: DbEnv, user: string) {
  await env.DB.prepare(
    "UPDATE user_preferences SET suggestion_rejects = 0 WHERE user_id = ? AND suggestion_rejects != 0",
  )
    .bind(user)
    .run();
}

// Stops counting rejects for `days`, after the person chose to keep suggestions when offered to turn them off.
export async function pauseRejects(env: DbEnv, user: string, days: number) {
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, rejects_paused_until) VALUES (?, datetime('now', ?))
     ON CONFLICT (user_id) DO UPDATE SET suggestion_rejects = 0, rejects_paused_until = excluded.rejects_paused_until`,
  )
    .bind(user, `+${days} days`)
    .run();
}

// Names of Slack users, as a Map of the ones kept: the name, and whether it was looked up more than
// `staleAfterDays` ago and so is worth asking Slack about again.
export async function keptNames(env: DbEnv, ids: Iterable<string>, staleAfterDays = Infinity) {
  const names = new Map<string, { name: string; stale: boolean }>();
  for (const id of ids) {
    const row = await env.DB.prepare(
      "SELECT name, updated_at < datetime('now', ?) AS stale FROM user_names WHERE user_id = ?",
    )
      .bind(`-${Number.isFinite(staleAfterDays) ? staleAfterDays : 100000} days`, id)
      .first<{ name: string; stale: number }>();
    if (row) names.set(id, { name: row.name, stale: Boolean(row.stale) });
  }
  return names;
}

export async function keepName(env: DbEnv, id: string, name: string) {
  await env.DB.prepare(
    `INSERT INTO user_names (user_id, name) VALUES (?, ?)
     ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(id, name)
    .run();
}
