-- id: 01KYRNFY5DC9953FMDC85ZV38C
-- depends-on: 01KYQ72BD9CJDVN4VFTB0GJ2NP

ALTER TABLE channel_updates
  ADD COLUMN IF NOT EXISTS response_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS response_artifact_offset integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS response_agent_catalog_id text NULL;

ALTER TABLE channel_updates
  DROP CONSTRAINT IF EXISTS channel_updates_response_artifacts_check,
  ADD CONSTRAINT channel_updates_response_artifacts_check CHECK (
    jsonb_typeof(response_artifacts) = 'array'
    AND jsonb_array_length(response_artifacts) <= 4
  ),
  DROP CONSTRAINT IF EXISTS channel_updates_response_artifact_offset_check,
  ADD CONSTRAINT channel_updates_response_artifact_offset_check CHECK (
    response_artifact_offset >= 0
    AND response_artifact_offset <= jsonb_array_length(response_artifacts)
  ),
  DROP CONSTRAINT IF EXISTS channel_updates_response_agent_catalog_id_check,
  ADD CONSTRAINT channel_updates_response_agent_catalog_id_check CHECK (
    response_agent_catalog_id IS NULL
    OR response_agent_catalog_id IN ('hermes-claw','claude-cli','codex-cli')
  ),
  DROP CONSTRAINT IF EXISTS channel_updates_response_artifact_route_check,
  ADD CONSTRAINT channel_updates_response_artifact_route_check CHECK (
    jsonb_array_length(response_artifacts) = 0
    OR response_agent_catalog_id IS NOT NULL
  );
