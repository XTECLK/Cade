-- Left from when a project had a client channel paired with its dev channel: requirements posted
-- there, and the thread a task was tracked from. Nothing has read or written them since, so they
-- are dropped.
DROP INDEX requirements_unposted;
DROP TABLE requirements;
ALTER TABLE tasks DROP COLUMN source_channel;
ALTER TABLE tasks DROP COLUMN source_thread_ts;
ALTER TABLE tasks DROP COLUMN source_link;
