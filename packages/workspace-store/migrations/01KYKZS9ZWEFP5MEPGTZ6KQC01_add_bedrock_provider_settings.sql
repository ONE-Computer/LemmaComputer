-- id: 01KYKZS9ZWEFP5MEPGTZ6KQC01
-- depends-on: 01KYKMM2TSC4D3HNM3ETQ5Y49B

-- Expand Provider Settings with a Bedrock option and the only read-safe
-- metadata it needs. API keys remain only in LiteLLM's encrypted credential
-- store and cannot fit this metadata object.
ALTER TABLE provider_settings
  DROP CONSTRAINT provider_settings_provider_check,
  ADD CONSTRAINT provider_settings_provider_check
    CHECK (provider IN ('openai', 'anthropic', 'bedrock')),
  ADD COLUMN configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT provider_settings_configuration_safe_check CHECK (
    jsonb_typeof(configuration) = 'object'
    AND (configuration - ARRAY['region', 'modelProfileId']) = '{}'::jsonb
    AND (
      (provider IN ('openai', 'anthropic') AND configuration = '{}'::jsonb)
      OR (
        provider = 'bedrock'
        AND configuration ? 'region'
        AND configuration ? 'modelProfileId'
        AND jsonb_typeof(configuration -> 'region') = 'string'
        AND jsonb_typeof(configuration -> 'modelProfileId') = 'string'
        AND char_length(configuration ->> 'region') BETWEEN 1 AND 32
        AND char_length(configuration ->> 'modelProfileId') BETWEEN 1 AND 96
        AND configuration ->> 'region' IN ('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-1')
        AND configuration ->> 'modelProfileId' IN ('claude-sonnet-4-5-global')
      )
    )
  );
