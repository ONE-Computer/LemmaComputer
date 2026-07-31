-- id: 01KYTYSMWWP1S7B92JNYZXW1QF
-- depends-on: 01KYTXR177CTJZP331ZNBJ8TCM

-- Budget configuration is immutable history. Active versions are selected by
-- effective time; the store serializes overlapping-version checks per Team.
CREATE TABLE team_budget_versions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  team_id uuid NOT NULL,
  limit_amount numeric(30,12) NOT NULL CHECK (limit_amount >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  period_type text NOT NULL CHECK (period_type IN ('calendar_month','calendar_week')),
  timezone text NOT NULL CHECK (timezone <> ''),
  mode text NOT NULL CHECK (mode IN ('soft','hard')),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES users(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,team_id,id)
);
CREATE INDEX team_budget_versions_active_idx ON team_budget_versions (tenant_id,team_id,effective_from DESC,effective_to);

CREATE TABLE team_budget_warning_thresholds (
  tenant_id text NOT NULL,
  budget_version_id uuid NOT NULL,
  threshold_percent numeric(6,3) NOT NULL CHECK (threshold_percent > 0 AND threshold_percent <= 100),
  PRIMARY KEY (tenant_id,budget_version_id,threshold_percent),
  FOREIGN KEY (tenant_id,budget_version_id) REFERENCES team_budget_versions(tenant_id,id)
);

CREATE TABLE team_budget_reservations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  budget_version_id uuid NOT NULL,
  team_id uuid NOT NULL,
  source_system text NOT NULL CHECK (source_system <> ''),
  source_attempt_id text NOT NULL CHECK (source_attempt_id <> ''),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  quoted_amount numeric(30,12) NOT NULL CHECK (quoted_amount >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate_card_id uuid NOT NULL,
  rate_card_source_hash text NOT NULL CHECK (rate_card_source_hash ~ '^[a-f0-9]{64}$'),
  cache_assumption text NOT NULL CHECK (cache_assumption IN ('known_hit','known_miss','unknown_assume_miss')),
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  max_agent_steps integer NOT NULL CHECK (max_agent_steps > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start AND expires_at > created_at),
  FOREIGN KEY (tenant_id,team_id,budget_version_id) REFERENCES team_budget_versions(tenant_id,team_id,id),
  FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id),
  FOREIGN KEY (tenant_id,rate_card_id) REFERENCES ai_deployment_rate_cards(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,source_system,source_attempt_id)
);
CREATE INDEX team_budget_reservations_capacity_idx ON team_budget_reservations (tenant_id,team_id,period_start,period_end,expires_at);

CREATE TABLE team_budget_reservation_settlements (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  reservation_id uuid NOT NULL,
  usage_event_id uuid NOT NULL,
  actual_provider_cost numeric(30,12) NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,reservation_id) REFERENCES team_budget_reservations(tenant_id,id),
  FOREIGN KEY (tenant_id,usage_event_id) REFERENCES ai_usage_events(tenant_id,id),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,reservation_id), UNIQUE (tenant_id,usage_event_id)
);

-- Expiry is a reconciliation deadline, never an automatic refund. Capacity is
-- released only by immutable settlement or explicit terminal evidence.
CREATE TABLE team_budget_reservation_releases (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  reservation_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('provider_not_dispatched','cancelled','failed_unbilled','reconciled_terminal')),
  evidence text NOT NULL CHECK (length(trim(evidence)) BETWEEN 3 AND 1000),
  released_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,reservation_id) REFERENCES team_budget_reservations(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,reservation_id)
);

CREATE TABLE team_budget_overrides (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  budget_version_id uuid NOT NULL,
  team_id uuid NOT NULL,
  override_type text NOT NULL CHECK (override_type IN ('limit_increase','hard_limit_bypass')),
  old_limit_amount numeric(30,12) NOT NULL CHECK (old_limit_amount >= 0),
  new_limit_amount numeric(30,12),
  actor_user_id text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 1000),
  effective_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > effective_from),
  CHECK ((override_type='limit_increase' AND new_limit_amount IS NOT NULL AND new_limit_amount > old_limit_amount) OR (override_type='hard_limit_bypass' AND new_limit_amount IS NULL)),
  FOREIGN KEY (tenant_id,team_id,budget_version_id) REFERENCES team_budget_versions(tenant_id,team_id,id),
  FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id),
  FOREIGN KEY (tenant_id,actor_user_id) REFERENCES users(tenant_id,id),
  UNIQUE (tenant_id,id)
);
CREATE INDEX team_budget_overrides_active_idx ON team_budget_overrides (tenant_id,team_id,effective_from,expires_at);

CREATE TABLE team_budget_alerts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  budget_version_id uuid NOT NULL,
  team_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  threshold_percent numeric(6,3) NOT NULL,
  consumed_amount numeric(30,12) NOT NULL,
  limit_amount numeric(30,12) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,team_id,budget_version_id) REFERENCES team_budget_versions(tenant_id,team_id,id),
  FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id),
  UNIQUE (tenant_id,budget_version_id,period_start,threshold_percent)
);
CREATE INDEX team_budget_alerts_tenant_time_idx ON team_budget_alerts (tenant_id,created_at DESC,id);

CREATE TABLE team_budget_gateway_projections (
  tenant_id text NOT NULL,
  budget_version_id uuid NOT NULL,
  team_id uuid NOT NULL,
  projection_key text NOT NULL CHECK (projection_key <> ''),
  projected_limit_amount numeric(30,12) NOT NULL,
  projected_mode text NOT NULL CHECK (projected_mode IN ('soft','hard')),
  gateway_fingerprint text NOT NULL CHECK (gateway_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('current','drifted','unavailable')),
  checked_at timestamptz NOT NULL,
  detail text,
  PRIMARY KEY (tenant_id,budget_version_id),
  FOREIGN KEY (tenant_id,team_id,budget_version_id) REFERENCES team_budget_versions(tenant_id,team_id,id),
  FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id)
);

CREATE TABLE team_budget_reconciliation_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  budget_version_id uuid NOT NULL,
  expected_fingerprint text NOT NULL CHECK (expected_fingerprint ~ '^[a-f0-9]{64}$'),
  observed_fingerprint text CHECK (observed_fingerprint IS NULL OR observed_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('matched','drifted','unavailable','repaired')),
  started_by text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,budget_version_id) REFERENCES team_budget_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,started_by) REFERENCES users(tenant_id,id),
  UNIQUE (tenant_id,id)
);

CREATE OR REPLACE FUNCTION onecomputer_reject_team_budget_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Team budget history rows are immutable'; END;
$$;
CREATE TRIGGER team_budget_versions_immutable BEFORE UPDATE OR DELETE ON team_budget_versions FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_team_budget_history_mutation();
CREATE TRIGGER team_budget_warning_thresholds_immutable BEFORE UPDATE OR DELETE ON team_budget_warning_thresholds FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_team_budget_history_mutation();
CREATE TRIGGER team_budget_reservations_immutable BEFORE UPDATE OR DELETE ON team_budget_reservations FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_team_budget_history_mutation();
CREATE TRIGGER team_budget_reservation_settlements_immutable BEFORE UPDATE OR DELETE ON team_budget_reservation_settlements FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_team_budget_history_mutation();
CREATE TRIGGER team_budget_overrides_immutable BEFORE UPDATE OR DELETE ON team_budget_overrides FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_team_budget_history_mutation();
CREATE TRIGGER team_budget_reservation_releases_immutable BEFORE UPDATE OR DELETE ON team_budget_reservation_releases FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_team_budget_history_mutation();
CREATE TRIGGER team_budget_alerts_immutable BEFORE UPDATE OR DELETE ON team_budget_alerts FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_team_budget_history_mutation();
CREATE TRIGGER team_budget_reconciliation_runs_immutable BEFORE UPDATE OR DELETE ON team_budget_reconciliation_runs FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_team_budget_history_mutation();
