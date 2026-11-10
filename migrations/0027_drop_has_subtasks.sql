-- The "Has subtasks" checkbox is gone: a task is done in parts when it has subtasks of its own (see
-- inParts in tasks.ts), so the hand-set marker is dropped.
ALTER TABLE tasks DROP COLUMN has_subtasks;
