-- id: 01KYPXWR3BEZ5YN6RNWG0W7V6K
-- depends-on: 01KYMCGYEEWFJJ8C91S2NE3YD2

-- Expand the read-safe provider metadata to record an approved OpenAI model.
-- Existing OpenAI rows retain '{}' and continue to mean the legacy Luna
-- default until the next successful provider configuration.
ALTER TABLE provider_settings
  DROP CONSTRAINT provider_settings_configuration_safe_check,
  ADD CONSTRAINT provider_settings_configuration_safe_check CHECK (
    (
      provider = 'openai'
      AND (
        configuration = '{}'::jsonb
        OR (
          jsonb_typeof(configuration) = 'object'
          AND configuration ? 'modelId'
          AND configuration - 'modelId' = '{}'::jsonb
          AND configuration->>'modelId' IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
        )
      )
    )
    OR (provider IN ('anthropic', 'glm') AND configuration = '{}'::jsonb)
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
