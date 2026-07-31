-- id: 01KYV7NWS10SXCQEK2QR263D8Z
-- depends-on: 01KYV4BZ1B812SHZANK82YM7YV

CREATE TABLE ai_routing_mapping_versions (
  id uuid NOT NULL, tenant_id text NOT NULL, revision_note text NOT NULL,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE ai_routing_deployments (
  id uuid NOT NULL, tenant_id text NOT NULL, mapping_version_id uuid NOT NULL,
  service_class text NOT NULL CHECK (service_class IN ('lite','balanced','pro')),
  provider text NOT NULL CHECK (provider IN ('foundry','openai','anthropic','glm','bedrock')),
  provider_model text NOT NULL, provider_deployment text NOT NULL, rate_card_id uuid,
  capabilities jsonb NOT NULL, approved boolean NOT NULL, evaluation_passed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,mapping_version_id) REFERENCES ai_routing_mapping_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,rate_card_id) REFERENCES ai_deployment_rate_cards(tenant_id,id),
  UNIQUE (tenant_id,mapping_version_id,id)
);
CREATE INDEX ai_routing_deployments_mapping_idx ON ai_routing_deployments(tenant_id,mapping_version_id,service_class);

CREATE TABLE ai_routing_policy_versions (
  id uuid NOT NULL, tenant_id text NOT NULL, team_id uuid, mapping_version_id uuid NOT NULL,
  billing_currency char(3) NOT NULL, service_class_policies jsonb NOT NULL, identity_scope jsonb NOT NULL, team_scope jsonb, required_residency text,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id),
  FOREIGN KEY (tenant_id,mapping_version_id) REFERENCES ai_routing_mapping_versions(tenant_id,id)
);
CREATE INDEX ai_routing_policy_versions_team_idx ON ai_routing_policy_versions(tenant_id,team_id,created_at DESC);

CREATE TABLE ai_routing_evidence_reviews (
  id uuid NOT NULL, tenant_id text NOT NULL, team_id uuid NOT NULL,
  sample_size integer NOT NULL CHECK (sample_size > 0), evaluation_passed boolean NOT NULL,
  expected_savings numeric(38,12), currency char(3), fallback_rate numeric(9,6) NOT NULL,
  error_rate numeric(9,6) NOT NULL, regret_rate numeric(9,6) NOT NULL,
  reviewer_user_id text NOT NULL, review_note text NOT NULL, reviewed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id)
);

CREATE TABLE ai_routing_rollout_versions (
  id uuid NOT NULL, tenant_id text NOT NULL, team_id uuid NOT NULL, policy_version_id uuid NOT NULL,
  mapping_version_id uuid NOT NULL, mode text NOT NULL CHECK (mode IN ('disabled','shadow','enabled')),
  fixed_deployment_id uuid NOT NULL, evidence_review_id uuid, previous_rollout_version_id uuid,
  reason text NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id),
  FOREIGN KEY (tenant_id,policy_version_id) REFERENCES ai_routing_policy_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,mapping_version_id) REFERENCES ai_routing_mapping_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,fixed_deployment_id) REFERENCES ai_routing_deployments(tenant_id,id),
  FOREIGN KEY (tenant_id,evidence_review_id) REFERENCES ai_routing_evidence_reviews(tenant_id,id),
  FOREIGN KEY (tenant_id,previous_rollout_version_id) REFERENCES ai_routing_rollout_versions(tenant_id,id)
);
CREATE INDEX ai_routing_rollout_versions_team_idx ON ai_routing_rollout_versions(tenant_id,team_id,created_at DESC);

CREATE TABLE ai_routing_decisions (
  id uuid NOT NULL, tenant_id text NOT NULL, request_id text NOT NULL, task_id text NOT NULL,
  team_id uuid, user_id text NOT NULL, policy_version_id uuid NOT NULL, mapping_version_id uuid NOT NULL,
  rollout_version_id uuid NOT NULL, requested_service_class text NOT NULL, selected_service_class text NOT NULL,
  selected_deployment_id uuid NOT NULL, executed_deployment_id uuid NOT NULL, rate_card_id uuid NOT NULL,
  expected_cost numeric(38,12) NOT NULL, currency char(3) NOT NULL, confidence numeric(9,6) NOT NULL,
  reason_code text NOT NULL, safe_signals text[] NOT NULL, escalation_reason text,
  session_affinity_hash text, affinity_moved_reason text, router_overhead_ms numeric(18,6) NOT NULL,
  shadow boolean NOT NULL, fallback_chain uuid[] NOT NULL DEFAULT '{}', outcome text,
  actual_cost numeric(38,12), actual_currency char(3), usage_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,request_id), FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id),
  FOREIGN KEY (tenant_id,policy_version_id) REFERENCES ai_routing_policy_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,mapping_version_id) REFERENCES ai_routing_mapping_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,rollout_version_id) REFERENCES ai_routing_rollout_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,selected_deployment_id) REFERENCES ai_routing_deployments(tenant_id,id),
  FOREIGN KEY (tenant_id,executed_deployment_id) REFERENCES ai_routing_deployments(tenant_id,id),
  FOREIGN KEY (tenant_id,rate_card_id) REFERENCES ai_deployment_rate_cards(tenant_id,id),
  FOREIGN KEY (tenant_id,usage_event_id) REFERENCES ai_usage_events(tenant_id,id)
);
CREATE INDEX ai_routing_decisions_team_time_idx ON ai_routing_decisions(tenant_id,team_id,created_at DESC);
CREATE INDEX ai_routing_decisions_task_idx ON ai_routing_decisions(tenant_id,task_id);

CREATE TABLE ai_routing_decision_candidates (
  tenant_id text NOT NULL, decision_id uuid NOT NULL, ordinal integer NOT NULL,
  deployment_id uuid NOT NULL, eligibility text NOT NULL, reason_code text,
  expected_cost numeric(38,12), currency char(3), PRIMARY KEY (tenant_id,decision_id,ordinal),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES ai_routing_decisions(tenant_id,id),
  FOREIGN KEY (tenant_id,deployment_id) REFERENCES ai_routing_deployments(tenant_id,id)
);

CREATE TABLE ai_routing_decision_observations (
  id uuid NOT NULL, tenant_id text NOT NULL, decision_id uuid NOT NULL, usage_event_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success','error','regret','override')),
  actual_cost numeric(38,12), currency char(3), latency_ms bigint,
  observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,decision_id,usage_event_id),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES ai_routing_decisions(tenant_id,id),
  FOREIGN KEY (tenant_id,usage_event_id) REFERENCES ai_usage_events(tenant_id,id)
);
CREATE INDEX ai_routing_observations_decision_idx ON ai_routing_decision_observations(tenant_id,decision_id,observed_at DESC);

CREATE TABLE ai_routing_session_affinity_versions (
  id uuid NOT NULL, tenant_id text NOT NULL, affinity_hash text NOT NULL,
  service_class text NOT NULL CHECK (service_class IN ('lite','balanced','pro')),
  deployment_id uuid NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,deployment_id) REFERENCES ai_routing_deployments(tenant_id,id)
);
CREATE INDEX ai_routing_affinity_latest_idx ON ai_routing_session_affinity_versions(tenant_id,affinity_hash,created_at DESC);

CREATE FUNCTION onecomputer_reject_ai_routing_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AI routing evidence is immutable'; END $$;
CREATE TRIGGER ai_routing_mapping_versions_immutable BEFORE UPDATE OR DELETE ON ai_routing_mapping_versions FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
CREATE TRIGGER ai_routing_deployments_immutable BEFORE UPDATE OR DELETE ON ai_routing_deployments FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
CREATE TRIGGER ai_routing_policy_versions_immutable BEFORE UPDATE OR DELETE ON ai_routing_policy_versions FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
CREATE TRIGGER ai_routing_evidence_reviews_immutable BEFORE UPDATE OR DELETE ON ai_routing_evidence_reviews FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
CREATE TRIGGER ai_routing_rollout_versions_immutable BEFORE UPDATE OR DELETE ON ai_routing_rollout_versions FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
CREATE TRIGGER ai_routing_decisions_immutable BEFORE UPDATE OR DELETE ON ai_routing_decisions FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
CREATE TRIGGER ai_routing_decision_candidates_immutable BEFORE UPDATE OR DELETE ON ai_routing_decision_candidates FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
CREATE TRIGGER ai_routing_decision_observations_immutable BEFORE UPDATE OR DELETE ON ai_routing_decision_observations FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
CREATE TRIGGER ai_routing_affinity_versions_immutable BEFORE UPDATE OR DELETE ON ai_routing_session_affinity_versions FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
