-- The hash of the markdown last written to a summary canvas, so a rewrite
-- that would change nothing can be skipped: Slack may notify people again
-- for the mentions in every write.
ALTER TABLE canvases ADD COLUMN content_hash TEXT;
