-- A task can be a bug: chosen on the New task and Edit forms, and changed there either way. `kind`
-- gains 'bug' beside 'task' and 'incident'. SQLite can't change a column's CHECK in place, so the
-- column is replaced: a new one with the wider CHECK takes the values, the old one is dropped, and the
-- new one takes its name. No index or other table names the column, so the table needn't be rebuilt.
ALTER TABLE tasks ADD COLUMN kind_new TEXT NOT NULL DEFAULT 'task' CHECK (kind_new IN ('task', 'bug', 'incident'));
UPDATE tasks SET kind_new = kind;
ALTER TABLE tasks DROP COLUMN kind;
ALTER TABLE tasks RENAME COLUMN kind_new TO kind;
