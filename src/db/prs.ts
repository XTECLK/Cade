// Where pull requests stand on GitHub, read by the sync (see github.ts).
import type { PrChange, PrState } from "../types.ts";
import type { DbEnv } from "./common.ts";

// The GitHub pull requests of open tasks (posted, not Done, deleted or archived) to read: not merged,
// which is for good. Those never read come first, then those read longest ago, at most `limit`.
export async function prsToSync(env: DbEnv, limit: number) {
  const { results } = await env.DB.prepare(
    `SELECT j.value AS url FROM tasks t, json_each(t.prs) j LEFT JOIN pull_requests pr ON pr.url = j.value
     WHERE t.ts IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.status != 'DONE'
       AND j.value LIKE 'https://github.com/%' AND (pr.state IS NULL OR pr.state != 'MERGED')
     GROUP BY j.value ORDER BY MIN(pr.synced_at IS NOT NULL), MIN(pr.synced_at) LIMIT ?`,
  )
    .bind(limit)
    .all<{ url: string }>();
  return results.map((row) => row.url);
}

// Saves where pull requests stand, and returns those whose state changed (one not saved before counts).
export async function setPrStates(env: DbEnv, states: { url: string; state: PrState }[]) {
  if (!states.length) return [];
  const urls = JSON.stringify(states.map(({ url }) => url));
  const { results } = await env.DB.prepare(
    "SELECT url, state FROM pull_requests WHERE url IN (SELECT value FROM json_each(?))",
  )
    .bind(urls)
    .all<{ url: string; state: PrState }>();
  const before = new Map(results.map((row) => [row.url, row.state]));
  // D1 takes 100 values in a statement, two a row.
  for (let from = 0; from < states.length; from += 40) {
    const chunk = states.slice(from, from + 40);
    await env.DB.prepare(
      `INSERT INTO pull_requests (url, state) VALUES ${chunk.map(() => "(?, ?)").join(", ")}
       ON CONFLICT (url) DO UPDATE SET state = excluded.state, synced_at = CURRENT_TIMESTAMP`,
    )
      .bind(...chunk.flatMap(({ url, state }) => [url, state]))
      .run();
  }
  return states
    .filter(({ url, state }) => before.get(url) !== state)
    .map(({ url, state }): PrChange => ({ url, from: before.get(url), to: state }));
}

// Saves pull requests as open, those not saved before: linked with no word from GitHub on them. They
// are marked as read long ago, so the sync, which reads the oldest first, reads them next (see prsToSync).
export async function addOpenPrs(env: DbEnv, urls: string[]) {
  if (!urls.length) return;
  // "WHERE true" lets SQLite read ON CONFLICT as the upsert's, not the SELECT's join.
  await env.DB.prepare(
    "INSERT INTO pull_requests (url, state, synced_at) SELECT value, 'OPEN', '1970-01-01 00:00:00' FROM json_each(?) WHERE true ON CONFLICT (url) DO NOTHING",
  )
    .bind(JSON.stringify(urls))
    .run();
}

// Where those of `urls` saved stand, as { url: state }.
export async function prStatesOf(env: DbEnv, urls: string[]) {
  const { results } = await env.DB.prepare(
    "SELECT url, state FROM pull_requests WHERE url IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(urls))
    .all<{ url: string; state: PrState }>();
  return Object.fromEntries(results.map((row) => [row.url, row.state]));
}
