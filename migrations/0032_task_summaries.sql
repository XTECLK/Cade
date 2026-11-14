-- A task's summary is no longer on a notes page people read: it is a working summary that people's AI
-- agents read and keep up to date (get_task_summary and save_task_summary in src/mcp.ts), and the
-- notes people typed by hand are gone with the page.
--
-- `through_ts` is the ts of the last message of the task's thread the summary covers, so the next
-- agent reads only what came after. The summaries from before aren't kept: they don't say what they
-- covered, and an agent writes one again from the task's thread.
CREATE TABLE task_summaries (
  channel TEXT NOT NULL,
  task_ts TEXT NOT NULL,
  summary TEXT NOT NULL,
  through_ts TEXT NOT NULL,
  written_by TEXT NOT NULL,
  written_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel, task_ts)
);

DROP TABLE task_notes;
ALTER TABLE tasks DROP COLUMN notes_url;

-- Nor does a task made from a message offer a prompt to summarize it any more, so the project setting
-- that turned that off goes too.
DELETE FROM project_settings WHERE key = 'aiAgentSummary';
