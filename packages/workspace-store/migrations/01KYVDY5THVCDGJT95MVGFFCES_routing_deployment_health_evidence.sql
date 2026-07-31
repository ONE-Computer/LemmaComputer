-- id: 01KYVDY5THVCDGJT95MVGFFCES
-- depends-on: 01KYV7NWS10SXCQEK2QR263D8Z

CREATE TABLE ai_routing_deployment_health_observations (
  id uuid NOT NULL,
  tenant_id text NOT NULL,
  deployment_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  usage_event_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('healthy','unavailable')),
  source text NOT NULL CHECK (source IN ('litellm_execution')),
  expires_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,decision_id,usage_event_id),
  FOREIGN KEY (tenant_id,deployment_id) REFERENCES ai_routing_deployments(tenant_id,id),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES ai_routing_decisions(tenant_id,id),
  FOREIGN KEY (tenant_id,usage_event_id) REFERENCES ai_usage_events(tenant_id,id),
  CHECK (
    (status = 'unavailable' AND expires_at IS NOT NULL)
    OR (status = 'healthy' AND expires_at IS NULL)
  )
);

CREATE INDEX ai_routing_deployment_health_latest_idx
  ON ai_routing_deployment_health_observations(tenant_id,deployment_id,observed_at DESC);

CREATE TRIGGER ai_routing_deployment_health_observations_immutable
  BEFORE UPDATE OR DELETE ON ai_routing_deployment_health_observations
  FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_routing_mutation();
