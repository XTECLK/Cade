-- Projects added with `/cade project init`, besides those in cade.config.json (see
-- src/settings.js): the project's name and channel, which stay as they were set.
CREATE TABLE projects (
  channel TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A project's settings changed in the form `/cade project settings` opens (see src/commands/project.js), over what
-- cade.config.json says. One row for each setting changed; the row is removed to go
-- back to the config. `value` is JSON (true or false).
CREATE TABLE project_settings (
  channel TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel, key)
);
