-- Task threads and notes now live in this database, not in a Google Doc.
--
-- `messages` is the long-term copy of every reply in a tracked task's thread
-- (Slack's free plan hides messages after 90 days). Each is written as it
-- comes (see src/export.js). `files` is JSON. It replaces pending_messages,
-- whose rows were waiting for the Doc, so they are kept.
CREATE TABLE messages (
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

INSERT INTO messages (channel, task_ts, ts, user_id, username, text, files, created_at)
  SELECT channel, task_ts, ts, user_id, username, text, files, created_at FROM pending_messages;

DROP TABLE pending_messages;

-- A task's notes page (see src/notes.js): the summary an AI agent wrote, and
-- the notes people write by hand on the web page.
CREATE TABLE task_notes (
  channel TEXT NOT NULL,
  task_ts TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summary_by TEXT,
  summary_at TEXT,
  body TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TEXT,
  PRIMARY KEY (channel, task_ts)
);

-- Slack names, kept so a page can still show who wrote a message once the
-- person is gone from Slack.
CREATE TABLE user_names (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- What signs a person in to the web pages (see src/web.js): a 'login' is the
-- one-time link `/cade login` gives, used once within minutes, a 'session' is
-- the cookie it sets. Only hashes are kept. `expires_at` is SQLite's
-- datetime('now') form, so it compares as text.
CREATE TABLE web_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX web_tokens_user ON web_tokens (user_id, kind);

-- Pages for threads and notes used to be tabs in a Google Doc. Those links are
-- dropped, and `/cade resync <link>` gives a task the new ones.
UPDATE tasks SET notes_url = NULL, export_url = NULL;
ALTER TABLE tasks DROP COLUMN notes_tab;
ALTER TABLE tasks DROP COLUMN export_tab;
ALTER TABLE tasks DROP COLUMN export_synced;
