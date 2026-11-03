-- The tokens that let a person's AI agent use Cade's MCP endpoint (see
-- src/mcp.js), one per person, made by `/cade mcp grant` and removed by
-- `/cade mcp revoke`. Only a hash of the token is kept, so it can't be read
-- back: granting again makes a new one.
CREATE TABLE mcp_tokens (
  user_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
