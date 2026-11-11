-- Executive summaries are no longer written by Cade: a team that wants them runs its own workflow
-- with its AI agent, reading tasks through Cade's MCP tools (see docs/workflows.html). Their tables,
-- and each project's Google Doc (workDoc), go with them.
DROP TABLE executive_summary_items;
DROP TABLE executive_summaries;
DELETE FROM project_settings WHERE key = 'workDoc';
