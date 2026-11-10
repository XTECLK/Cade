-- Cade no longer pins tasks, so the activeTasksPinning setting is gone; its saved choices are dropped
-- (they would be ignored, as only the settings the form lists are read).
DELETE FROM project_settings WHERE key = 'activeTasksPinning';
