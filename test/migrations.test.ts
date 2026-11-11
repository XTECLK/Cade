import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

// A database with the migrations before `file` applied, and a function applying the rest.
function before(file: string) {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  const apply = (names: string[]) => names.forEach((name) => db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8")));
  apply(files.filter((name) => name < file));
  return { db, rest: () => apply(files.filter((name) => name >= file)) };
}

test("0025 moves incidents from source_incident to kind, and every other task is a task", () => {
  const { db, rest } = before("0025");
  db.exec(`INSERT INTO tasks (channel, ts, title, priority, status, created_by, source_incident) VALUES
    ('CDEV', '1.1', 'Checkout is down', 'Urgent', 'TODO', 'U1', 1),
    ('CDEV', '1.2', 'Fix login', 'High', 'DONE', 'U1', 0)`);
  rest();
  assert.deepEqual(
    db.prepare("SELECT ts, kind, parent_id FROM tasks ORDER BY ts").all().map((row) => ({ ...row })),
    [
      { ts: "1.1", kind: "incident", parent_id: null },
      { ts: "1.2", kind: "task", parent_id: null },
    ],
  );
  const columns = db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
  assert.ok(!columns.includes("source_incident"));
  assert.throws(() => db.exec("UPDATE tasks SET kind = 'bug'"), /CHECK constraint failed/);
});

test("0029 drops what was left from client channels, keeping the tasks", () => {
  const { db, rest } = before("0029");
  db.exec(`INSERT INTO tasks (channel, ts, title, priority, status, created_by, source_channel, source_thread_ts, source_link) VALUES
    ('CDEV', '1.1', 'Fix login', 'High', 'TODO', 'U1', 'CCLIENT', '0.9', 'https://acme.slack.com/archives/CCLIENT/p9')`);
  rest();
  assert.deepEqual({ ...db.prepare("SELECT ts, title FROM tasks").get() }, { ts: "1.1", title: "Fix login" });
  const columns = db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
  assert.ok(!columns.some((name) => String(name).startsWith("source_")));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'requirements'").get(), undefined);
});

// schema.sql is made from the migrations by `npm run schema`, for reading the database in one place.
test("schema.sql is the database as the migrations leave it", async () => {
  const { SCHEMA_FILE, currentSchema } = await import("../scripts/schema.ts");
  assert.equal(readFileSync(SCHEMA_FILE, "utf8"), currentSchema(), "schema.sql is stale: run npm run schema");
});
