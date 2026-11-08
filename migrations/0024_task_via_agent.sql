-- Whether a task was made through someone's AI agent (MCP), so its card says so beside who tracked it.
ALTER TABLE tasks ADD COLUMN via_agent INTEGER NOT NULL DEFAULT 0;
