-- id: 01KYTXR177CTJZP331ZNBJ8TCM
-- depends-on: 01KYTRRJP6JWRQ79676AEQCJHJ

-- Provider pricing is deployment-specific. Service-class aliases are absent so
-- remapping cannot change provider-cost semantics.
CREATE TABLE ai_deployment_rate_cards (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  base_model text NOT NULL,
  deployment_id text NOT NULL,
  region text,
  provider_service_tier text,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source text NOT NULL CHECK (source IN ('pinned_catalogue','contract_override','conservative')),
  source_version text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  catalogue_release text,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  approved_at timestamptz NOT NULL,
  approved_by text REFERENCES users(id),
  override_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (provider <> '' AND provider_account_id <> '' AND base_model <> '' AND deployment_id <> ''),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK ((source = 'contract_override' AND approved_by IS NOT NULL AND override_reason IS NOT NULL AND override_reason <> '') OR source <> 'contract_override'),
  FOREIGN KEY (tenant_id,approved_by) REFERENCES users(tenant_id,id),
  UNIQUE (tenant_id,id)
);
CREATE INDEX ai_deployment_rate_cards_lookup_idx ON ai_deployment_rate_cards
  (tenant_id,provider,provider_account_id,deployment_id,effective_from DESC,effective_to);

CREATE TABLE ai_deployment_rate_card_rates (
  tenant_id text NOT NULL,
  rate_card_id uuid NOT NULL,
  unit text NOT NULL CHECK (unit IN ('input_uncached_token','cache_read_token','cache_write_token','output_token','reasoning_token','image','audio_second','request','character','second') OR unit ~ '^provider:[a-z0-9][a-z0-9_.:-]{0,79}$'),
  amount_per_unit numeric(30,12) NOT NULL CHECK (amount_per_unit >= 0),
  unit_scale numeric(30,6) NOT NULL DEFAULT 1 CHECK (unit_scale > 0),
  PRIMARY KEY (tenant_id,rate_card_id,unit),
  FOREIGN KEY (tenant_id,rate_card_id) REFERENCES ai_deployment_rate_cards(tenant_id,id)
);

-- Admission is a durable pre-dispatch Team/task snapshot. Budget reservations can
-- later hook into it without changing completion ingestion.
CREATE TABLE ai_usage_attempt_admissions (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  source_system text NOT NULL CHECK (source_system <> ''),
  source_attempt_id text NOT NULL CHECK (source_attempt_id <> ''),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  subject_id text NOT NULL,
  team_id uuid NOT NULL,
  team_display_name text NOT NULL,
  cost_center_code text,
  workspace_id text,
  agent_id text,
  session_id text,
  task_id text NOT NULL,
  turn_id text,
  task_binding_provenance text NOT NULL CHECK (task_binding_provenance IN ('explicit_signed','unbound_generated')),
  policy_version_id text,
  policy_hash text CHECK (policy_hash IS NULL OR policy_hash ~ '^[a-f0-9]{64}$'),
  requested_alias text NOT NULL,
  requested_service_class text CHECK (requested_service_class IS NULL OR requested_service_class IN ('auto','lite','balanced','pro')),
  selected_service_class text CHECK (selected_service_class IS NULL OR selected_service_class IN ('lite','balanced','pro')),
  route_mapping_version text,
  attempt_kind text NOT NULL CHECK (attempt_kind IN ('inference','router','classifier','embedding','retry','fallback')),
  parent_attempt_id uuid,
  resolved_provider text NOT NULL,
  provider_account_id text NOT NULL,
  resolved_model text NOT NULL,
  resolved_deployment_id text NOT NULL,
  region text,
  provider_service_tier text,
  admitted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (team_display_name <> '' AND task_id <> '' AND requested_alias <> ''),
  CHECK (resolved_provider <> '' AND provider_account_id <> '' AND resolved_model <> '' AND resolved_deployment_id <> ''),
  FOREIGN KEY (tenant_id,subject_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY (tenant_id,team_id) REFERENCES allocation_units(tenant_id,id),
  FOREIGN KEY (tenant_id,parent_attempt_id) REFERENCES ai_usage_attempt_admissions(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,source_system,source_attempt_id)
);
CREATE INDEX ai_usage_attempt_admissions_task_idx ON ai_usage_attempt_admissions (tenant_id,task_id,admitted_at,id);
CREATE INDEX ai_usage_attempt_admissions_team_idx ON ai_usage_attempt_admissions (tenant_id,team_id,admitted_at DESC);

CREATE TABLE ai_usage_ingestion_conflicts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  source_system text NOT NULL,
  source_event_id text NOT NULL,
  existing_fingerprint text NOT NULL CHECK (existing_fingerprint ~ '^[a-f0-9]{64}$'),
  received_fingerprint text NOT NULL CHECK (received_fingerprint ~ '^[a-f0-9]{64}$'),
  conflict_type text NOT NULL CHECK (conflict_type IN ('attempt_fingerprint_mismatch','event_fingerprint_mismatch')),
  detected_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ai_usage_ingestion_conflicts_dedupe_idx ON ai_usage_ingestion_conflicts (tenant_id,source_system,source_event_id,existing_fingerprint,received_fingerprint,conflict_type);
CREATE INDEX ai_usage_ingestion_conflicts_tenant_time_idx ON ai_usage_ingestion_conflicts (tenant_id,detected_at DESC);

-- Usage events are immutable facts or correction deltas. Composite foreign keys
-- keep lineage tenant-local and avoid dependencies on mutable chat rows.
CREATE TABLE ai_usage_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  admission_id uuid NOT NULL,
  source_system text NOT NULL CHECK (source_system <> ''),
  source_event_id text NOT NULL CHECK (source_event_id <> ''),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
  event_type text NOT NULL CHECK (event_type IN ('usage','correction')),
  corrects_event_id uuid,
  correction_semantics text CHECK (correction_semantics IS NULL OR correction_semantics IN ('delta')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('success','failure','cancelled','unknown')),
  error_class text,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  provider_reported_total_tokens numeric(30,6),
  price_status text NOT NULL CHECK (price_status IN ('priced','unknown','incomplete')),
  cost_status text NOT NULL CHECK (cost_status IN ('estimated','provider_confirmed','unpriced')),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  provider_cost numeric(30,12),
  provider_confirmed_cost numeric(30,12),
  rate_card_id uuid,
  rate_card_source text,
  rate_card_source_version text,
  rate_card_source_hash text CHECK (rate_card_source_hash IS NULL OR rate_card_source_hash ~ '^[a-f0-9]{64}$'),
  rate_card_effective_from timestamptz,
  conversation_history_count integer NOT NULL DEFAULT 0 CHECK (conversation_history_count >= 0),
  attachment_count integer NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  retrieval_count integer NOT NULL DEFAULT 0 CHECK (retrieval_count >= 0),
  system_policy_context_count integer NOT NULL DEFAULT 0 CHECK (system_policy_context_count >= 0),
  tool_result_context_count integer NOT NULL DEFAULT 0 CHECK (tool_result_context_count >= 0),
  routing_overhead_count integer NOT NULL DEFAULT 0 CHECK (routing_overhead_count >= 0),
  CHECK (event_type='correction' OR provider_reported_total_tokens IS NULL OR provider_reported_total_tokens >= 0),
  CHECK ((event_type='usage' AND corrects_event_id IS NULL AND correction_semantics IS NULL) OR (event_type='correction' AND corrects_event_id IS NOT NULL AND correction_semantics='delta')),
  CHECK ((price_status='priced' AND currency IS NOT NULL AND provider_cost IS NOT NULL AND rate_card_id IS NOT NULL AND rate_card_source IS NOT NULL AND rate_card_source_version IS NOT NULL AND rate_card_source_hash IS NOT NULL AND rate_card_effective_from IS NOT NULL) OR (price_status<>'priced' AND provider_cost IS NULL)),
  CHECK ((cost_status='provider_confirmed' AND provider_confirmed_cost IS NOT NULL) OR cost_status<>'provider_confirmed'),
  FOREIGN KEY (tenant_id,admission_id) REFERENCES ai_usage_attempt_admissions(tenant_id,id),
  FOREIGN KEY (tenant_id,corrects_event_id) REFERENCES ai_usage_events(tenant_id,id),
  FOREIGN KEY (tenant_id,rate_card_id) REFERENCES ai_deployment_rate_cards(tenant_id,id),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,source_system,source_event_id)
);
CREATE INDEX ai_usage_events_tenant_time_idx ON ai_usage_events (tenant_id,occurred_at DESC,id);
CREATE INDEX ai_usage_events_admission_idx ON ai_usage_events (tenant_id,admission_id,occurred_at,id);

CREATE TABLE ai_usage_event_units (
  tenant_id text NOT NULL,
  event_id uuid NOT NULL,
  unit text NOT NULL CHECK (unit IN ('input_uncached_token','cache_read_token','cache_write_token','output_token','reasoning_token','image','audio_second','request','character','second') OR unit ~ '^provider:[a-z0-9][a-z0-9_.:-]{0,79}$'),
  quantity numeric(30,6) NOT NULL,
  rate_amount_per_unit numeric(30,12),
  rate_unit_scale numeric(30,6),
  bucket_cost numeric(30,12),
  is_provider_diagnostic boolean NOT NULL DEFAULT false,
  CHECK ((rate_amount_per_unit IS NULL AND rate_unit_scale IS NULL AND bucket_cost IS NULL) OR (rate_amount_per_unit IS NOT NULL AND rate_amount_per_unit >= 0 AND rate_unit_scale IS NOT NULL AND rate_unit_scale > 0 AND bucket_cost IS NOT NULL)),
  CHECK (NOT is_provider_diagnostic OR bucket_cost IS NULL),
  PRIMARY KEY (tenant_id,event_id,unit),
  FOREIGN KEY (tenant_id,event_id) REFERENCES ai_usage_events(tenant_id,id)
);

CREATE TABLE ai_usage_reconciliation_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  source_system text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  expected_fingerprint text NOT NULL CHECK (expected_fingerprint ~ '^[a-f0-9]{64}$'),
  started_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  FOREIGN KEY (tenant_id,started_by) REFERENCES users(tenant_id,id),
  UNIQUE (tenant_id,id)
);
CREATE TABLE ai_usage_reconciliation_findings (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  run_id uuid NOT NULL,
  finding_type text NOT NULL CHECK (finding_type IN ('missing','duplicate','late','unknown_price','inconsistent')),
  source_event_id text,
  ledger_event_id uuid,
  expected_fingerprint text,
  observed_fingerprint text,
  details text NOT NULL,
  resolved_by_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,run_id) REFERENCES ai_usage_reconciliation_runs(tenant_id,id),
  FOREIGN KEY (tenant_id,ledger_event_id) REFERENCES ai_usage_events(tenant_id,id),
  FOREIGN KEY (tenant_id,resolved_by_event_id) REFERENCES ai_usage_events(tenant_id,id)
);
CREATE INDEX ai_usage_reconciliation_findings_run_idx ON ai_usage_reconciliation_findings (tenant_id,run_id,finding_type,id);

CREATE FUNCTION onecomputer_reject_ai_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AI usage and pricing ledger rows are immutable'; END;
$$;
CREATE TRIGGER ai_deployment_rate_cards_immutable BEFORE UPDATE OR DELETE ON ai_deployment_rate_cards FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_ledger_mutation();
CREATE TRIGGER ai_deployment_rate_card_rates_immutable BEFORE UPDATE OR DELETE ON ai_deployment_rate_card_rates FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_ledger_mutation();
CREATE TRIGGER ai_usage_attempt_admissions_immutable BEFORE UPDATE OR DELETE ON ai_usage_attempt_admissions FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_ledger_mutation();
CREATE TRIGGER ai_usage_events_immutable BEFORE UPDATE OR DELETE ON ai_usage_events FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_ledger_mutation();
CREATE TRIGGER ai_usage_event_units_immutable BEFORE UPDATE OR DELETE ON ai_usage_event_units FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_ledger_mutation();
CREATE TRIGGER ai_usage_reconciliation_runs_immutable BEFORE UPDATE OR DELETE ON ai_usage_reconciliation_runs FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_ledger_mutation();
CREATE TRIGGER ai_usage_reconciliation_findings_immutable BEFORE UPDATE OR DELETE ON ai_usage_reconciliation_findings FOR EACH ROW EXECUTE FUNCTION onecomputer_reject_ai_ledger_mutation();
