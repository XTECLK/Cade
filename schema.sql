-- Made by `npm run schema` from migrations/ (up to 0029_drop_client_channel_leftovers.sql): don't edit it by hand.
-- The database as the migrations leave it, for reference only: a change to the database is a new
-- file in migrations/, then `npm run schema` to bring this up to date (a test fails until then).

CREATE TABLE "canvases" (
  channel TEXT PRIMARY KEY,
  canvas_id TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dirty_token TEXT
, content_hash TEXT);

CREATE TABLE mcp_calls (
  user_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  calls INTEGER NOT NULL
);

CREATE TABLE mcp_tokens (
  user_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

CREATE TABLE project_settings (
  channel TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel, key)
);

CREATE TABLE projects (
  channel TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE releases (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks (id),
  prs TEXT NOT NULL DEFAULT '[]',
  -- What the release completes, as the team described it.
  note TEXT NOT NULL,
  -- PENDING_APPROVAL, APPROVED or NOT_APPROVED.
  status TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Who approved or turned it down in the requirement thread, and when.
  decided_by TEXT,
  decided_at TEXT
, approver TEXT, message_ts TEXT);
CREATE INDEX releases_by_task ON releases (task_id);

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

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  -- The tasks or incidents channel, and the root message's ts once posted.
  channel TEXT NOT NULL,
  ts TEXT,
  title TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  due_date TEXT NOT NULL DEFAULT '',
  -- Slack user IDs and pull request addresses, as JSON arrays.
  developers TEXT NOT NULL DEFAULT '[]',
  reviewers TEXT NOT NULL DEFAULT '[]',
  testers TEXT NOT NULL DEFAULT '[]',
  prs TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  -- When the task was last set to DONE, as an ISO timestamp, or ''.
  completed_at TEXT NOT NULL DEFAULT '',
  -- The requirement or incident thread the task was tracked from, if any.
  link TEXT,
  -- Until it is posted: where it was tracked from, as JSON, for what
  -- follows the post, and how many posts Slack has refused.
  origin TEXT,
  post_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Deleted tasks are kept, as the Sheet keeps their rows.
  deleted_at TEXT, archived_at TEXT, archived_by TEXT, notes_url TEXT, export_url TEXT, blocked INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT NOT NULL DEFAULT '', via_agent INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'incident')), parent_id INTEGER REFERENCES tasks (id),
  UNIQUE (channel, ts)
);
CREATE INDEX tasks_open ON tasks (channel, status) WHERE deleted_at IS NULL;
CREATE INDEX tasks_parent ON tasks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX tasks_unposted ON tasks (created_at) WHERE ts IS NULL AND deleted_at IS NULL;

CREATE TABLE user_names (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY,
  home_project TEXT,
  home_tab TEXT
, suggestions INTEGER NOT NULL DEFAULT 1, suggestion_rejects INTEGER NOT NULL DEFAULT 0, rejects_paused_until TEXT);

CREATE TABLE web_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX web_tokens_user ON web_tokens (user_id, kind);
