-- The MCP server's prompts: workflows built on its tools (a task's summary, an executive summary…), which
-- a person picks in their agent. They are a deployment's own: Markdown files in its deploy repo's
-- prompts/ folder, which `npm run prompts` (and `npm run deploy`) checks against the tools and saves here,
-- replacing what was here. The Worker only reads them. `arguments` is JSON: [{ name, description,
-- required }]; `hash` changes with anything else in the row, so agents are told to reconnect.
CREATE TABLE prompts (
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
