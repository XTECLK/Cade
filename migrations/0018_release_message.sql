-- Where a release's request was posted and who approves it, so the request can be changed when the
-- release's PRs are (see src/commands/release.js and the MCP tool update_release). Releases sent
-- before this have neither, and aren't changed that way.
ALTER TABLE releases ADD COLUMN approver TEXT;
ALTER TABLE releases ADD COLUMN message_ts TEXT;
