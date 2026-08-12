-- id: 01KZTTD6FRWXMK8445NM8KBYAF
-- depends-on: 01KZTK2EFP332F14HA0JZ2CFNX

CREATE TABLE workspace_administration_commands (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  actor_user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('start','restart','stop','terminate_runtime')),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  result_workspace_state text CHECK (result_workspace_state IS NULL OR result_workspace_state IN ('not_created','provisioning','ready','open','restarting','stopping','stopped','failed')),
  failure_code text,
  failure_http_status integer CHECK (failure_http_status IS NULL OR failure_http_status BETWEEN 400 AND 599),
  failure_retryable boolean,
  correlation_id text NOT NULL,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (tenant_id,actor_user_id,idempotency_key_hash),
  CHECK (
    status='pending' AND completed_at IS NULL AND failure_code IS NULL AND failure_http_status IS NULL AND failure_retryable IS NULL
    OR status='succeeded' AND completed_at IS NOT NULL AND result_workspace_state IS NOT NULL AND failure_code IS NULL AND failure_http_status IS NULL AND failure_retryable IS NULL
    OR status='failed' AND completed_at IS NOT NULL AND failure_code IS NOT NULL AND failure_http_status IS NOT NULL AND failure_retryable IS NOT NULL
  )
);

CREATE INDEX workspace_administration_commands_tenant_workspace_idx
  ON workspace_administration_commands (tenant_id,workspace_id,requested_at DESC,id DESC);

CREATE TABLE workspace_administration_audit_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organizations(id),
  command_id uuid NOT NULL REFERENCES workspace_administration_commands(id),
  workspace_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  actor_user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('start','restart','stop','terminate_runtime')),
  outcome text NOT NULL CHECK (outcome IN ('requested','succeeded','failed')),
  workspace_state text CHECK (workspace_state IS NULL OR workspace_state IN ('not_created','provisioning','ready','open','restarting','stopping','stopped','failed')),
  failure_code text,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (command_id,outcome),
  CHECK (outcome='failed' OR failure_code IS NULL)
);

CREATE INDEX workspace_administration_audit_events_tenant_workspace_idx
  ON workspace_administration_audit_events (tenant_id,workspace_id,occurred_at DESC,id DESC);

CREATE FUNCTION protect_workspace_administration_command() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Workspace administration command evidence cannot be deleted';
  END IF;
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.workspace_id<>OLD.workspace_id
    OR NEW.owner_subject_id<>OLD.owner_subject_id OR NEW.actor_user_id<>OLD.actor_user_id
    OR NEW.action<>OLD.action OR NEW.idempotency_key_hash<>OLD.idempotency_key_hash
    OR NEW.request_hash<>OLD.request_hash OR NEW.correlation_id<>OLD.correlation_id
    OR NEW.requested_at<>OLD.requested_at THEN
    RAISE EXCEPTION 'Workspace administration command authority is immutable';
  END IF;
  IF OLD.status<>'pending' THEN
    RAISE EXCEPTION 'Completed workspace administration commands are immutable';
  END IF;
  IF NEW.status NOT IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'Workspace administration commands must complete exactly once';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_administration_commands_protect
BEFORE UPDATE OR DELETE ON workspace_administration_commands
FOR EACH ROW EXECUTE FUNCTION protect_workspace_administration_command();

CREATE FUNCTION reject_workspace_administration_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Workspace administration audit events are immutable';
END $$;

CREATE TRIGGER workspace_administration_audit_events_immutable
BEFORE UPDATE OR DELETE ON workspace_administration_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_workspace_administration_audit_mutation();
