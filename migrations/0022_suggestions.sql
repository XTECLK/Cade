-- The suggestions Cade offers a person, privately, from their own messages in
-- task threads (see suggest.ts and ai-suggest.ts).
--   suggestions           1 (the default) while they're on for the person, 0 once
--                         they turn them off (Home tab → Configure → Suggestions).
--   suggestion_rejects    how many they have rejected in a row: Accept or Edit…
--                         puts it back to 0, and at three Cade offers to turn them off.
--   rejects_paused_until  Keep them, on that offer, stops the count until then (an
--                         SQLite datetime, UTC), thirty days on.
ALTER TABLE user_preferences ADD COLUMN suggestions INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_preferences ADD COLUMN suggestion_rejects INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_preferences ADD COLUMN rejects_paused_until TEXT;
