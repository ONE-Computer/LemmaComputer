ALTER TABLE governed_approvals
  DROP CONSTRAINT IF EXISTS governed_approvals_channel_check;

ALTER TABLE governed_approvals
  ADD CONSTRAINT governed_approvals_channel_check
  CHECK (channel IN ('local-fixture','openvtc-task-consent'));

CREATE TABLE IF NOT EXISTS openvtc_approvers (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  approver_did text NOT NULL,
  verification_method text NOT NULL,
  display_name text NOT NULL,
  transport_token_hash text NOT NULL UNIQUE CHECK (length(transport_token_hash) = 64),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  enrolled_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (tenant_id, subject_id, approver_did)
);

CREATE UNIQUE INDEX IF NOT EXISTS openvtc_approvers_active_owner_idx
  ON openvtc_approvers (tenant_id, subject_id, enrolled_at DESC)
  WHERE status='active';

CREATE TABLE IF NOT EXISTS openvtc_consent_tasks (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE REFERENCES governed_operations(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  approver_id uuid NOT NULL REFERENCES openvtc_approvers(id),
  executor_did text NOT NULL,
  challenge text NOT NULL UNIQUE CHECK (length(challenge) >= 16),
  task_type text NOT NULL,
  payload_digest text NOT NULL UNIQUE CHECK (length(payload_digest) = 64),
  request_document jsonb NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  request_proof_hash text NOT NULL CHECK (length(request_proof_hash) = 64),
  state text NOT NULL CHECK (state IN ('queued','delivered','approved','denied','expired','failed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  decided_at timestamptz,
  decision_document jsonb,
  decision_hash text CHECK (decision_hash IS NULL OR length(decision_hash) = 64),
  proof_hash text CHECK (proof_hash IS NULL OR length(proof_hash) = 64)
);

CREATE INDEX IF NOT EXISTS openvtc_consent_tasks_inbox_idx
  ON openvtc_consent_tasks (approver_id, created_at)
  WHERE state IN ('queued','delivered');

CREATE TABLE IF NOT EXISTS openvtc_delivery_outbox (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES openvtc_consent_tasks(id) ON DELETE CASCADE,
  transport text NOT NULL CHECK (transport = 'https-poll-0.1'),
  state text NOT NULL CHECK (state IN ('queued','leased','delivered','failed')),
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_failure_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS openvtc_delivery_outbox_ready_idx
  ON openvtc_delivery_outbox (available_at, created_at)
  WHERE state IN ('queued','leased');

CREATE TABLE IF NOT EXISTS openvtc_delivery_attempts (
  id bigserial PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES openvtc_delivery_outbox(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  outcome text NOT NULL CHECK (outcome IN ('delivered','retry','failed')),
  failure_code text,
  attempted_at timestamptz NOT NULL
);
