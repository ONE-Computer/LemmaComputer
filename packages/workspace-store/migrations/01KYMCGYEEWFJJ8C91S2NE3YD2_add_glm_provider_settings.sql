-- id: 01KYMCGYEEWFJJ8C91S2NE3YD2
-- depends-on: 01KYKZS9ZWEFP5MEPGTZ6KQC01

ALTER TABLE provider_settings
  DROP CONSTRAINT provider_settings_provider_check,
  DROP CONSTRAINT provider_settings_configuration_safe_check,
  ADD CONSTRAINT provider_settings_provider_check
    CHECK (provider IN ('openai', 'anthropic', 'glm', 'bedrock')),
  ADD CONSTRAINT provider_settings_configuration_safe_check CHECK (
    (provider IN ('openai', 'anthropic', 'glm') AND configuration = '{}'::jsonb)
    OR (
      provider = 'bedrock'
      AND jsonb_typeof(configuration) = 'object'
      AND configuration ? 'region'
      AND configuration ? 'modelProfileId'
      AND configuration - 'region' - 'modelProfileId' = '{}'::jsonb
      AND configuration->>'region' IN ('ap-southeast-1', 'us-east-1', 'us-west-2', 'eu-west-1')
      AND configuration->>'modelProfileId' = 'claude-sonnet-4-5-global'
    )
  );
