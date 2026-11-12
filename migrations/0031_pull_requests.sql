-- Where each pull request linked to a task stands on GitHub, as the cron last read it (see
-- github.ts). A PR not here hasn't been read yet, or isn't on GitHub, and counts as open.
CREATE TABLE pull_requests (
  url TEXT PRIMARY KEY,
  -- OPEN (drafts too), MERGED or CLOSED (without merging).
  state TEXT NOT NULL CHECK (state IN ('OPEN', 'MERGED', 'CLOSED')),
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Partial releases are gone with it: a task's pull requests are counted open, merged or closed
-- instead, and approval is the task's Client review. Nothing reads `releases` any more.
DROP INDEX IF EXISTS releases_by_task;
DROP TABLE IF EXISTS releases;
