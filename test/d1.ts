import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

// A stand-in for a D1 binding, backed by an in-memory SQLite database with
// the migrations applied. reset() empties it, for a fresh one per test. It has the part of
// D1Database Cade uses (prepare, bind, first, all, run), and is typed as one for that.
export function fakeD1(): D1Database & { reset(): void } {
  let db: DatabaseSync;
  const binding = {
    reset() {
      db = new DatabaseSync(":memory:");
      for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
        db.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
      }
    },
    prepare(sql: string) {
      const statement = (params: any[]): any => ({
        bind: (...values: any[]) => statement(values),
        first: async () => db.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        run: async () => db.prepare(sql).run(...params),
      });
      return statement([]);
    },
  };
  binding.reset();
  return binding as unknown as D1Database & { reset(): void };
}
