// What the database modules share: the env they take, and writing a row.
import type { AppEnv } from "../env.ts";

// Only the DB binding is used here, so callers (and tests) can pass any env
// that has one.
export type DbEnv = Pick<AppEnv, "DB">;

export async function insert(env: DbEnv, table: string, channel: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  const { id } = (await env.DB.prepare(
    `INSERT INTO ${table} (channel, ${columns.join(", ")})
     VALUES (?, ${columns.map(() => "?").join(", ")})
     RETURNING id`,
  )
    .bind(channel, ...Object.values(row))
    .first<{ id: number }>())!;
  return id;
}

// Writes `row` as the posted root message's row, adding it or replacing it.
export async function upsert(env: DbEnv, table: string, channel: string, ts: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO ${table} (channel, ts, ${columns.join(", ")})
     VALUES (?, ?, ${columns.map(() => "?").join(", ")})
     ON CONFLICT (channel, ts) DO UPDATE SET
       ${columns.map((column) => `${column} = excluded.${column}`).join(", ")},
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(channel, ts, ...Object.values(row))
    .run();
}
