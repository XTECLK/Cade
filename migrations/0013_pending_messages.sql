-- Messages in a task's thread not yet written to its page in the project's
-- Google Doc (see src/export.js). The cron appends them in batches and deletes
-- them once written, so the Doc is the only long-term copy. `files` is JSON.
CREATE TABLE pending_messages (
  channel TEXT NOT NULL,
  task_ts TEXT NOT NULL,
  ts TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  text TEXT NOT NULL DEFAULT '',
  files TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel, task_ts, ts)
);

-- The ts of the newest message of the thread that is in its page in the Doc.
ALTER TABLE tasks ADD COLUMN export_synced TEXT;
