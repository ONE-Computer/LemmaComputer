-- id: 01KZ0000000000000000000001
-- depends-on: 01KYSVBE000000000000000002

ALTER TABLE onevibe_task_runs
  ADD COLUMN IF NOT EXISTS turn_limit integer NOT NULL DEFAULT 32,
  ADD COLUMN IF NOT EXISTS turns_used integer NOT NULL DEFAULT 0;

ALTER TABLE onevibe_task_runs
  DROP CONSTRAINT IF EXISTS onevibe_task_runs_turn_budget_check;

ALTER TABLE onevibe_task_runs
  ADD CONSTRAINT onevibe_task_runs_turn_budget_check
  CHECK (turn_limit > 0 AND turn_limit <= 10000 AND turns_used >= 0 AND turns_used <= turn_limit);
