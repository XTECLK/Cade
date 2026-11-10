-- What a task is, and the task it is a subtask of. `kind` replaces source_incident: 'incident' for
-- what was reported with /cade incident (always urgent, due immediately), 'task' for the rest.
-- `parent_id` is the task a subtask belongs to, in the same channel, or NULL for a task of its own.
-- Subtasks go one level deep, which is checked where a subtask is made; an incident's subtasks are
-- incidents too, always urgent and due immediately.
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'incident'));
ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks (id);

-- Every existing row took the default, 'task', as the column was added; only incidents need setting.
UPDATE tasks SET kind = 'incident' WHERE source_incident = 1;

ALTER TABLE tasks DROP COLUMN source_incident;

CREATE INDEX tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
