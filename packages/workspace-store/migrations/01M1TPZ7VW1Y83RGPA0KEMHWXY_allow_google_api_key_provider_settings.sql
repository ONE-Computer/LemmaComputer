-- id: 01M1TPZ7VW1Y83RGPA0KEMHWXY
-- depends-on: 01M1TBFB6H32N0HXDTRF3SM4XH

-- Forward-only migration. Add safe, bounded SQL below.

-- Expand metadata validation only; no row rewrites or credential storage.
-- Existing service-account configurations remain valid.
CREATE OR REPLACE FUNCTION provider_dynamic_configuration_valid(provider_name text, config jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE selected jsonb; cloud jsonb; item record; meta jsonb; field text;
BEGIN
  IF jsonb_typeof(config) IS DISTINCT FROM 'object' OR octet_length(config::text)>262144
    OR config - 'modelId' - 'modelIds' - 'modelLimits' - 'modelMetadata' - 'emissionsRegion' - 'region' - 'modelProfileId' - 'foundry' - 'vertex' <> '{}'::jsonb THEN RETURN false; END IF;
  IF config ? 'emissionsRegion' AND config->>'emissionsRegion' NOT IN ('us','sg') THEN RETURN false; END IF;
  selected := CASE WHEN config ? 'modelId' THEN jsonb_build_array(config->'modelId') ELSE config->'modelIds' END;
  IF config ? 'modelId' AND config ? 'modelIds' THEN RETURN false; END IF;
  IF jsonb_typeof(selected) IS DISTINCT FROM 'array' OR jsonb_array_length(selected) NOT BETWEEN 1 AND 64 THEN RETURN false; END IF;
  IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(selected)) <> jsonb_array_length(selected) THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(selected) LOOP
    IF jsonb_typeof(item.value) <> 'string' OR NOT provider_dynamic_id_valid(item.value #>> '{}') THEN RETURN false; END IF;
  END LOOP;
  IF config ? 'modelMetadata' THEN
    IF jsonb_typeof(config->'modelMetadata') <> 'object' THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_each(config->'modelMetadata') LOOP
      meta := item.value;
      IF NOT selected ? item.key OR jsonb_typeof(meta) <> 'object'
        OR meta - 'displayName' - 'publisher' - 'source' - 'observedAt' - 'mode' - 'capabilities' - 'contextTokens' - 'outputTokens' - 'inputUsdPerMillion' - 'outputUsdPerMillion' <> '{}'::jsonb
        OR jsonb_typeof(meta->'displayName') IS DISTINCT FROM 'string'
        OR meta->>'source' NOT IN ('provider','litellm','manual','legacy','admin')
        OR jsonb_typeof(meta->'capabilities') IS DISTINCT FROM 'object'
        OR (meta->'capabilities') - 'vision' - 'tools' - 'streaming' <> '{}'::jsonb THEN RETURN false; END IF;
      FOREACH field IN ARRAY ARRAY['vision','tools','streaming'] LOOP
        IF meta->'capabilities' ? field AND jsonb_typeof(meta->'capabilities'->field) <> 'boolean' THEN RETURN false; END IF;
      END LOOP;
      FOREACH field IN ARRAY ARRAY['contextTokens','outputTokens','inputUsdPerMillion','outputUsdPerMillion'] LOOP
        IF meta ? field AND (jsonb_typeof(meta->field) <> 'number' OR (meta->>field)::numeric < 0) THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END IF;
  IF provider_name = 'foundry' THEN
    cloud := config->'foundry';
    IF config ? 'vertex' OR config ? 'region' OR config ? 'modelProfileId' OR config ? 'modelId'
      OR jsonb_typeof(cloud) IS DISTINCT FROM 'object' OR cloud - 'endpoint' - 'deployments' - 'protocols' <> '{}'::jsonb
      OR cloud->>'endpoint' !~ '^https://[a-z0-9][a-z0-9-]{1,62}\.(openai\.azure\.com|services\.ai\.azure\.com)/openai/v1/?$'
      OR jsonb_typeof(cloud->'endpoint') IS DISTINCT FROM 'string'
      OR jsonb_typeof(cloud->'deployments') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(cloud->'deployments')) <> jsonb_array_length(selected) THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_each(cloud->'deployments') LOOP
      IF NOT selected ? item.key OR jsonb_typeof(item.value) <> 'string' OR item.value #>> '{}' !~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$' THEN RETURN false; END IF;
    END LOOP;
    IF cloud ? 'protocols' THEN
      IF jsonb_typeof(cloud->'protocols') <> 'object' THEN RETURN false; END IF;
      FOR item IN SELECT * FROM jsonb_each(cloud->'protocols') LOOP
        IF NOT selected ? item.key OR item.value #>> '{}' NOT IN ('openai','anthropic') THEN RETURN false; END IF;
      END LOOP;
    END IF;
  ELSIF provider_name = 'vertex' THEN
    cloud := config->'vertex';
    IF config ? 'foundry' OR config ? 'region' OR config ? 'modelProfileId' OR config ? 'modelId'
      OR jsonb_typeof(cloud) IS DISTINCT FROM 'object' OR cloud - 'projectId' - 'location' - 'authMethod' <> '{}'::jsonb
      OR jsonb_typeof(cloud->'location') IS DISTINCT FROM 'string' OR cloud->>'location' !~ '^(global|[a-z]{2,12}-[a-z]{2,16}[0-9])$' THEN RETURN false; END IF;
    IF cloud ? 'authMethod' AND (jsonb_typeof(cloud->'authMethod') IS DISTINCT FROM 'string'
      OR cloud->>'authMethod' NOT IN ('api-key','service-account')) THEN RETURN false; END IF;
    IF cloud->>'authMethod' = 'api-key' THEN
      IF cloud ? 'projectId' OR cloud->>'location' <> 'global' THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(selected) LOOP
        IF item.value #>> '{}' !~ '^gemini-[a-zA-Z0-9._-]+$' THEN RETURN false; END IF;
      END LOOP;
    ELSE
      IF jsonb_typeof(cloud->'projectId') IS DISTINCT FROM 'string'
        OR cloud->>'projectId' !~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' THEN RETURN false; END IF;
    END IF;
  ELSIF provider_name = 'bedrock' THEN
    IF config ? 'foundry' OR config ? 'vertex' OR config ? 'modelId' OR config ? 'modelProfileId'
      OR jsonb_typeof(config->'region') IS DISTINCT FROM 'string' OR config->>'region' !~ '^[a-z]{2}-[a-z]+-[0-9]$' THEN RETURN false; END IF;
  ELSE
    IF provider_name NOT IN ('openai','anthropic','glm') OR config ? 'foundry' OR config ? 'vertex' OR config ? 'region' OR config ? 'modelProfileId' THEN RETURN false; END IF;
  END IF;
  RETURN true;
END $$;

