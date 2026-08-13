-- id: 01KZW70Z3W642GE5JM9XZGFXC6
-- depends-on: 01KZTTD6FRWXMK8445NM8KBYAF

-- Connector-policy changes and their workspace delivery attempts are durable
-- evidence. The mutable connector_registry row remains the policy authority;
-- these rows explain how it changed and whether each current workspace received
-- the resulting live gateway grant.
CREATE TABLE connector_policy_change_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organizations(id),
  connector_id text NOT NULL,
  actor_user_id text NOT NULL,
  change_kind text NOT NULL CHECK (change_kind IN ('access_policy','tool_policy')),
  outcome text NOT NULL CHECK (outcome IN ('applied','conflict')),
  old_version integer NOT NULL CHECK (old_version > 0),
  new_version integer NOT NULL CHECK (new_version > 0),
  old_policy_hash text NOT NULL CHECK (old_policy_hash ~ '^[a-f0-9]{64}$'),
  new_policy_hash text NOT NULL CHECK (new_policy_hash ~ '^[a-f0-9]{64}$'),
  reviewed_definition_hash text CHECK (reviewed_definition_hash IS NULL OR reviewed_definition_hash ~ '^[a-f0-9]{64}$'),
  failure_code text,
  correlation_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,actor_user_id,correlation_id),
  CHECK (
    outcome='applied' AND failure_code IS NULL
    OR outcome='conflict' AND failure_code IS NOT NULL
  )
);

CREATE INDEX connector_policy_change_events_tenant_connector_idx
  ON connector_policy_change_events (tenant_id,connector_id,occurred_at DESC,id DESC);

CREATE TABLE connector_policy_workspace_delivery_receipts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES organizations(id),
  change_event_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  grant_id text NOT NULL,
  workspace_state text NOT NULL CHECK (workspace_state IN ('not_created','provisioning','ready','open','restarting','stopping','stopped','failed')),
  outcome text NOT NULL CHECK (outcome IN ('refreshed','failed','applies_on_next_start')),
  failure_code text,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,change_event_id) REFERENCES connector_policy_change_events(tenant_id,id),
  CHECK (outcome='failed' OR failure_code IS NULL)
);

CREATE INDEX connector_policy_workspace_delivery_tenant_event_idx
  ON connector_policy_workspace_delivery_receipts (tenant_id,change_event_id,occurred_at DESC,id DESC);
CREATE INDEX connector_policy_workspace_delivery_tenant_workspace_idx
  ON connector_policy_workspace_delivery_receipts (tenant_id,workspace_id,occurred_at DESC,id DESC);

CREATE FUNCTION reject_connector_policy_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Connector policy evidence rows are immutable';
END $$;

CREATE TRIGGER connector_policy_change_events_immutable
BEFORE UPDATE OR DELETE ON connector_policy_change_events
FOR EACH ROW EXECUTE FUNCTION reject_connector_policy_evidence_mutation();

CREATE TRIGGER connector_policy_workspace_delivery_receipts_immutable
BEFORE UPDATE OR DELETE ON connector_policy_workspace_delivery_receipts
FOR EACH ROW EXECUTE FUNCTION reject_connector_policy_evidence_mutation();

-- Forward-only migration. Add safe, bounded SQL below.
