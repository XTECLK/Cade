-- Whether a task is blocked, and why. Blocked is a mark beside the status, not a status: the task
-- keeps where it was, and unblocking only clears the mark.
ALTER TABLE tasks ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT '';
