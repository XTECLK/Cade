#!/usr/bin/env node
// Writes schema.sql: the database as migrations/ leaves it, for reading in one place. The migrations
// are what runs (wrangler applies them in order); schema.sql is only a reference, made from them by
// applying every one to an empty SQLite database and listing what's there. A test fails while it is
// stale, so after adding a migration run `npm run schema`.
//
//   npm run schema
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
export const SCHEMA_FILE = new URL("../schema.sql", import.meta.url);

type Entry = { type: string; name: string; tbl_name: string; sql: string };

// The text of schema.sql: each table, as SQLite keeps it after every ALTER, followed by its indexes
// and triggers, tables in name order.
export function currentSchema() {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  // Indexes SQLite makes itself (for a PRIMARY KEY or UNIQUE) have no SQL, and come with their table.
  const entries = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, type = 'table' DESC, name")
    .all() as Entry[];
  db.close();
  const blocks = entries.map((entry) => `${entry.type === "table" ? "\n" : ""}${entry.sql.trim()};`);
  return `-- Made by \`npm run schema\` from migrations/ (up to ${files.at(-1)}): don't edit it by hand.
-- The database as the migrations leave it, for reference only: a change to the database is a new
-- file in migrations/, then \`npm run schema\` to bring this up to date (a test fails until then).
${blocks.join("\n")}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SCHEMA_FILE, currentSchema());
  console.log("Wrote schema.sql");
}
