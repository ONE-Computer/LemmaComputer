ALTER TABLE governed_operations
  ADD COLUMN IF NOT EXISTS failure_summary text;
