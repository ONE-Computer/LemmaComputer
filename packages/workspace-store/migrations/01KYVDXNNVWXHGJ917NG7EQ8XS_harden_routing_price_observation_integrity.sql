-- id: 01KYVDXNNVWXHGJ917NG7EQ8XS
-- depends-on: 01KYV7NWS10SXCQEK2QR263D8Z

ALTER TABLE ai_routing_deployments
  ADD COLUMN provider_account_id text,
  ADD COLUMN region text,
  ADD COLUMN provider_service_tier text;

CREATE FUNCTION onecomputer_validate_routing_decision_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ai_routing_deployments deployment
    JOIN ai_deployment_rate_cards card
      ON card.tenant_id = deployment.tenant_id
     AND card.id = deployment.rate_card_id
    WHERE deployment.tenant_id = NEW.tenant_id
      AND deployment.id = NEW.selected_deployment_id
      AND deployment.mapping_version_id = NEW.mapping_version_id
      AND deployment.provider_account_id IS NOT NULL
      AND card.id = NEW.rate_card_id
      AND card.provider = deployment.provider
      AND card.provider_account_id = deployment.provider_account_id
      AND card.base_model = deployment.provider_model
      AND card.deployment_id = deployment.provider_deployment
      AND card.region IS NOT DISTINCT FROM deployment.region
      AND card.provider_service_tier IS NOT DISTINCT FROM deployment.provider_service_tier
      AND card.currency = NEW.currency
      AND card.effective_from <= NEW.created_at
      AND (card.effective_to IS NULL OR card.effective_to > NEW.created_at)
      AND card.id = (
        SELECT candidate.id
        FROM ai_deployment_rate_cards candidate
        WHERE candidate.tenant_id = card.tenant_id
          AND candidate.provider = card.provider
          AND candidate.provider_account_id = card.provider_account_id
          AND candidate.base_model = card.base_model
          AND candidate.deployment_id = card.deployment_id
          AND candidate.region IS NOT DISTINCT FROM card.region
          AND candidate.provider_service_tier IS NOT DISTINCT FROM card.provider_service_tier
          AND candidate.effective_from <= NEW.created_at
          AND (candidate.effective_to IS NULL OR candidate.effective_to > NEW.created_at)
        ORDER BY CASE candidate.source WHEN 'contract_override' THEN 3 WHEN 'pinned_catalogue' THEN 2 ELSE 1 END DESC,
          candidate.effective_from DESC, candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      )
  ) THEN
    RAISE EXCEPTION 'Routing decision rate card is not the canonical effective deployment price';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ai_routing_decisions_validate_price
  BEFORE INSERT ON ai_routing_decisions
  FOR EACH ROW EXECUTE FUNCTION onecomputer_validate_routing_decision_price();

CREATE FUNCTION onecomputer_validate_routing_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ai_routing_decisions decision
    JOIN ai_routing_deployments deployment
      ON deployment.tenant_id = decision.tenant_id
     AND deployment.id = decision.executed_deployment_id
    JOIN ai_usage_events event
      ON event.tenant_id = NEW.tenant_id
     AND event.id = NEW.usage_event_id
     AND event.event_type = 'usage'
    JOIN ai_usage_attempt_admissions admission
      ON admission.tenant_id = event.tenant_id
     AND admission.id = event.admission_id
    WHERE decision.tenant_id = NEW.tenant_id
      AND decision.id = NEW.decision_id
      AND admission.task_id = decision.task_id
      AND admission.team_id = decision.team_id
      AND admission.subject_id = decision.user_id
      AND admission.resolved_provider = deployment.provider
      AND admission.resolved_model = deployment.provider_model
      AND admission.resolved_deployment_id = deployment.provider_deployment
      AND admission.policy_version_id = decision.policy_version_id::text
      AND admission.route_mapping_version = decision.mapping_version_id::text
      AND admission.selected_service_class = decision.selected_service_class
      AND (
        (
          event.price_status = 'priced'
          AND NEW.actual_cost = event.provider_cost
          AND NEW.currency = event.currency
        )
        OR (
          event.price_status <> 'priced'
          AND NEW.actual_cost IS NULL
          AND NEW.currency IS NULL
        )
      )
  ) THEN
    RAISE EXCEPTION 'Routing observation does not match the decision and immutable usage evidence';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ai_routing_decision_observations_validate
  BEFORE INSERT ON ai_routing_decision_observations
  FOR EACH ROW EXECUTE FUNCTION onecomputer_validate_routing_observation();
