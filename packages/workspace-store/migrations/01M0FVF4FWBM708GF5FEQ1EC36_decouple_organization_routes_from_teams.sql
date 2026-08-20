-- id: 01M0FVF4FWBM708GF5FEQ1EC36
-- depends-on: 01M075NBF74WSAD70GTP88CFG9

-- Organization routing is shared availability, not a Team permission. A null
-- Team identifies the single organization policy/rollout stream; decision
-- rows retain their nullable Team for cost attribution.
ALTER TABLE ai_routing_rollout_versions
  ALTER COLUMN team_id DROP NOT NULL;

CREATE INDEX ai_routing_rollout_versions_organization_idx
  ON ai_routing_rollout_versions(tenant_id, created_at DESC, id DESC)
  WHERE team_id IS NULL;

CREATE INDEX ai_routing_policy_versions_organization_idx
  ON ai_routing_policy_versions(tenant_id, created_at DESC, id DESC)
  WHERE team_id IS NULL;
