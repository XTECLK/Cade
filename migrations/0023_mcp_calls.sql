-- How many tool calls each person's AI agent made in the current minute, for the MCP rate limit (see
-- src/rate-limit.ts). One row per person, started again each minute.
CREATE TABLE mcp_calls (
  user_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  calls INTEGER NOT NULL
);
