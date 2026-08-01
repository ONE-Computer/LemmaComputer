-- id: 01KYYCNT4QCA6S1EMCK79AVTZD
-- depends-on: 01KYXT0X6P08PP978WHJPB8MV5

CREATE TABLE ai_cost_coverage_acknowledgements (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  unpriced_events_received_before timestamptz NOT NULL,
  reason text NOT NULL CHECK (reason IN ('historical_usage_before_pricing')),
  acknowledged_by text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,acknowledged_by) REFERENCES users(tenant_id,id)
);

CREATE INDEX ai_cost_coverage_acknowledgements_latest_idx
  ON ai_cost_coverage_acknowledgements (tenant_id,unpriced_events_received_before DESC,acknowledged_at DESC);
