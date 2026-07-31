-- id: 01KYV4BZ1B812SHZANK82YM7YV
-- depends-on: 01KYTXR177CTJZP331ZNBJ8TCM

-- Corrections may arrive before their immutable target. Preserve a tenant-local
-- idempotency record so the delivery is auditable and a later exact replay can
-- be promoted after the original usage event arrives.
CREATE TABLE ai_usage_pending_corrections (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  admission_id uuid NOT NULL,
  source_system text NOT NULL CHECK (source_system <> ''),
  source_event_id text NOT NULL CHECK (source_event_id <> ''),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  corrects_event_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,admission_id) REFERENCES ai_usage_attempt_admissions(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,source_system,source_event_id)
);

CREATE INDEX ai_usage_pending_corrections_target_idx
  ON ai_usage_pending_corrections (tenant_id,corrects_event_id,occurred_at,id);

CREATE TRIGGER ai_usage_pending_corrections_immutable
  BEFORE UPDATE OR DELETE ON ai_usage_pending_corrections
  FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_ledger_mutation();
