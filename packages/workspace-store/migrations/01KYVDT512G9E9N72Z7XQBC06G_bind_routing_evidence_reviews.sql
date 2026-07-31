-- id: 01KYVDT512G9E9N72Z7XQBC06G
-- depends-on: 01KYV7NWS10SXCQEK2QR263D8Z

ALTER TABLE ai_routing_decisions
  ADD COLUMN selection_status text NOT NULL DEFAULT 'selected'
    CHECK (selection_status IN ('selected','no_candidate','fixed')),
  ALTER COLUMN rate_card_id DROP NOT NULL,
  ALTER COLUMN expected_cost DROP NOT NULL,
  ALTER COLUMN currency DROP NOT NULL;

ALTER TABLE ai_routing_evidence_reviews
  ADD COLUMN shadow_rollout_version_id uuid,
  ADD COLUMN policy_version_id uuid,
  ADD COLUMN mapping_version_id uuid,
  ADD COLUMN fixed_deployment_id uuid,
  ADD COLUMN sample_window_start timestamptz,
  ADD COLUMN sample_window_end timestamptz,
  ADD FOREIGN KEY (tenant_id,shadow_rollout_version_id)
    REFERENCES ai_routing_rollout_versions(tenant_id,id),
  ADD FOREIGN KEY (tenant_id,policy_version_id)
    REFERENCES ai_routing_policy_versions(tenant_id,id),
  ADD FOREIGN KEY (tenant_id,mapping_version_id)
    REFERENCES ai_routing_mapping_versions(tenant_id,id),
  ADD FOREIGN KEY (tenant_id,fixed_deployment_id)
    REFERENCES ai_routing_deployments(tenant_id,id);

CREATE TABLE ai_routing_evidence_review_decisions (
  tenant_id text NOT NULL,
  review_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (tenant_id,review_id,ordinal),
  UNIQUE (tenant_id,review_id,decision_id),
  FOREIGN KEY (tenant_id,review_id)
    REFERENCES ai_routing_evidence_reviews(tenant_id,id),
  FOREIGN KEY (tenant_id,decision_id)
    REFERENCES ai_routing_decisions(tenant_id,id)
);

CREATE INDEX ai_routing_evidence_review_decisions_decision_idx
  ON ai_routing_evidence_review_decisions(tenant_id,decision_id);

CREATE TRIGGER ai_routing_evidence_review_decisions_immutable
  BEFORE UPDATE OR DELETE ON ai_routing_evidence_review_decisions
  FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
