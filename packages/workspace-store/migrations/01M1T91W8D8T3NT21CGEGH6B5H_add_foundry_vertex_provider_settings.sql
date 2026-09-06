-- id: 01M1T91W8D8T3NT21CGEGH6B5H
-- depends-on: 01M1S15T60RZ36F72GXKNMPMD1

-- Forward-only migration. Add safe, bounded SQL below.

-- Additive provider and read-safe metadata expansion, shared by both profiles.
-- Takes bounded table locks to validate constraints; no rows are rewritten.
ALTER TABLE provider_settings DROP CONSTRAINT provider_settings_provider_check,
  ADD CONSTRAINT provider_settings_provider_check CHECK (provider IN ('openai','anthropic','glm','bedrock','foundry','vertex'));
ALTER TABLE provider_lifecycle_fences DROP CONSTRAINT provider_lifecycle_fences_provider_check,
  ADD CONSTRAINT provider_lifecycle_fences_provider_check CHECK (provider IN ('openai','anthropic','glm','bedrock','foundry','vertex'));
ALTER TABLE ai_routing_deployments DROP CONSTRAINT ai_routing_deployments_provider_check,
  ADD CONSTRAINT ai_routing_deployments_provider_check CHECK (provider IN ('foundry','openai','anthropic','glm','bedrock','vertex'));

CREATE FUNCTION cloud_provider_configuration_valid(provider_name text, configuration jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE config jsonb; cloud jsonb; selected jsonb; item record; selected_count integer;
BEGIN
  IF jsonb_typeof(configuration) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF configuration ? 'emissionsRegion' AND (configuration->>'emissionsRegion' IS NULL
    OR configuration->>'emissionsRegion' NOT IN ('us','sg')) THEN RETURN false; END IF;
  config := configuration - 'emissionsRegion' - 'modelLimits';
  IF config - 'modelIds' - provider_name <> '{}'::jsonb THEN RETURN false; END IF;
  selected := config->'modelIds'; cloud := config->provider_name;
  IF jsonb_typeof(selected) IS DISTINCT FROM 'array' OR jsonb_typeof(cloud) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  selected_count := jsonb_array_length(selected);
  IF selected_count NOT BETWEEN 1 AND 2
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(selected)) <> selected_count THEN RETURN false; END IF;
  IF provider_name = 'foundry' THEN
    IF NOT selected <@ '["gpt-4.1","gpt-4.1-mini"]'::jsonb
      OR cloud - 'endpoint' - 'deployments' <> '{}'::jsonb
      OR jsonb_typeof(cloud->'endpoint') IS DISTINCT FROM 'string'
      OR cloud->>'endpoint' !~ '^https://[a-z0-9][a-z0-9-]{1,62}\.(openai\.azure\.com|services\.ai\.azure\.com)/openai/v1/?$'
      OR jsonb_typeof(cloud->'deployments') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(cloud->'deployments')) <> selected_count THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_each(cloud->'deployments') LOOP
      IF NOT selected ? item.key OR jsonb_typeof(item.value) <> 'string'
        OR item.value #>> '{}' !~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$' THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  ELSIF provider_name = 'vertex' THEN
    RETURN selected <@ '["gemini-2.5-flash","gemini-2.5-pro"]'::jsonb
      AND cloud - 'projectId' - 'location' = '{}'::jsonb
      AND jsonb_typeof(cloud->'projectId') = 'string'
      AND cloud->>'projectId' ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
      AND jsonb_typeof(cloud->'location') = 'string'
      AND cloud->>'location' IN ('global','us-central1','us-east5','europe-west1','europe-west4','asia-southeast1');
  END IF;
  RETURN false;
END $$;

-- Keep all historical direct-provider validation, including model limits.
DO $$
DECLARE prior_check text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT prior_check FROM pg_constraint
    WHERE conrelid = 'provider_settings'::regclass AND conname = 'provider_settings_configuration_safe_check';
  ALTER TABLE provider_settings DROP CONSTRAINT provider_settings_configuration_safe_check;
  EXECUTE 'ALTER TABLE provider_settings ADD CONSTRAINT provider_settings_configuration_safe_check CHECK ('
    || prior_check || ' OR (provider IN (''foundry'',''vertex'') AND cloud_provider_configuration_valid(provider, configuration) IS TRUE))';
END $$;
