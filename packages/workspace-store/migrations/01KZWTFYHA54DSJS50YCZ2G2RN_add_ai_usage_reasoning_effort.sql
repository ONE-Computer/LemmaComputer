-- id: 01KZWTFYHA54DSJS50YCZ2G2RN
-- depends-on: 01KZWFJ3NEHVJN5T1FBZTEC52Q

ALTER TABLE ai_usage_attempt_admissions
  ADD COLUMN requested_reasoning_effort text,
  ADD COLUMN resolved_reasoning_effort text,
  ADD CONSTRAINT ai_usage_attempt_requested_reasoning_effort_check
    CHECK (requested_reasoning_effort IS NULL OR requested_reasoning_effort IN ('auto', 'low', 'medium', 'high')),
  ADD CONSTRAINT ai_usage_attempt_resolved_reasoning_effort_check
    CHECK (resolved_reasoning_effort IS NULL OR resolved_reasoning_effort IN ('low', 'medium', 'high'));

COMMENT ON COLUMN ai_usage_attempt_admissions.requested_reasoning_effort IS
  'Product-level thinking effort requested by the signed task binding; auto is resolved before provider dispatch.';
COMMENT ON COLUMN ai_usage_attempt_admissions.resolved_reasoning_effort IS
  'Qualified provider effort selected by governed routing for this attempt.';
