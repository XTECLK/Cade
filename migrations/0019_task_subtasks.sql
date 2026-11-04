-- Whether a task is done in parts (subtasks): a message about one part must not move the whole
-- task's status, so Cade suggests no status changes for it. Pull requests are still tracked.
ALTER TABLE tasks ADD COLUMN has_subtasks INTEGER NOT NULL DEFAULT 0;
