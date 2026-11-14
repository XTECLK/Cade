-- How far each consumer has read a task's thread: a recipe that acts on what is new in it (such as
-- sync-tasks, checking the task's fields against it) reads the messages after its position with
-- get_task_history, then moves its position on with ack_task_history once it has handled them (see
-- src/mcp.ts), so what was handled, a fix the person turned down included, isn't handled again.
-- Positions are shared: a consumer is a recipe, not a person.
CREATE TABLE task_consumers (
  channel TEXT NOT NULL,
  task_ts TEXT NOT NULL,
  consumer TEXT NOT NULL,
  through_ts TEXT NOT NULL,
  acked_by TEXT NOT NULL,
  acked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel, task_ts, consumer)
);
