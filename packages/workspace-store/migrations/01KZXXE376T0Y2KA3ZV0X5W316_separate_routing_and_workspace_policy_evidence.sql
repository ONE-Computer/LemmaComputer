-- id: 01KZXXE376T0Y2KA3ZV0X5W316
-- depends-on: 01KZWTFYHA54DSJS50YCZ2G2RN

-- Usage admissions bind the workspace authorization policy. Routing decisions
-- bind the independently versioned model-routing policy. Validate their shared
-- signed task and resolved-route evidence without equating those policy IDs.
CREATE OR REPLACE FUNCTION lemmacomputer_validate_routing_observation()
RETURNS trigger LANGUAGE plpgsql AS $$
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
