-- Executive summaries, rebuilt (see src/summaries.js). An agent writes one
-- with create_executive_summary: it goes to the project's Google Doc, and
-- what it said of each task is kept here, as a snapshot. After the client
-- call the agent reads the doc back (get_executive_summary_doc), compares it
-- with this, tells the task threads, and records the agreed version
-- (update_executive_summary_after_call), so the next summary starts from it.
-- Nothing was kept in the old tables, so they are dropped.
DROP TABLE import_suggestions;
DROP TABLE export_items;
DROP TABLE exports;

CREATE TABLE executive_summaries (
  id INTEGER PRIMARY KEY,
  -- The project's name.
  project TEXT NOT NULL,
  created_by TEXT NOT NULL,
  -- The period it covers: the start of its first day and the end of its
  -- last, as ISO timestamps, in the TIMEZONE the days are counted in.
  since TEXT NOT NULL,
  until TEXT NOT NULL,
  -- ISO timestamps.
  created_at TEXT NOT NULL,
  -- When it was written to the doc; a summary not there yet isn't one.
  published_at TEXT,
  doc_id TEXT,
  doc_url TEXT,
  -- The text of each line Cade wrote in the doc, as a JSON array, so what
  -- people added to it after can be told apart.
  doc_lines TEXT
);

CREATE INDEX executive_summaries_project ON executive_summaries (project, published_at);

-- What the summary said of each task, in two versions: BEFORE the client
-- call, as the agent wrote it (with the title and status as they were), and
-- AFTER it, as it was agreed (written once, by update_executive_summary_after_call,
-- starting as BEFORE and changed by what the call decided). Anything in AFTER
-- that BEFORE lacks was added in the call; an item included in BEFORE but
-- not in AFTER was taken out. Both are kept, so they can be compared any time.
CREATE TABLE executive_summary_items (
  summary_id INTEGER NOT NULL REFERENCES executive_summaries (id),
  stage TEXT NOT NULL,
  -- The task's message; both empty for something added in the call that has
  -- no task.
  task_channel TEXT NOT NULL,
  task_ts TEXT NOT NULL,
  -- COMPLETED (done in the period), ACTIVE, or ADDED (in the call only).
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  incident INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 1,
  -- For active work: ON_TRACK, AT_RISK, DELAYED or BLOCKED.
  health TEXT,
  -- Free text, such as 3/5.
  progress TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- For an AFTER item with a task: when its thread was told what the call
  -- decided (and by whom), so it is told once. Recording the call again keeps
  -- it for an item that didn't change, and clears it for one that did.
  informed_at TEXT,
  informed_by TEXT,
  PRIMARY KEY (summary_id, stage, task_channel, task_ts, title)
);

-- What was said about the call as a whole, when the AFTER version was recorded.
ALTER TABLE executive_summaries ADD COLUMN call_notes TEXT;
ALTER TABLE executive_summaries ADD COLUMN call_by TEXT;
ALTER TABLE executive_summaries ADD COLUMN call_at TEXT;
