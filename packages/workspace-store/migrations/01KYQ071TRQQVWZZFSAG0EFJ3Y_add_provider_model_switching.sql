-- id: 01KYQ071TRQQVWZZFSAG0EFJ3Y
-- depends-on: 01KYPXWR3BEZ5YN6RNWG0W7V6K

-- Expand the read-safe provider metadata so every direct provider route can
-- record its selected upstream model. Existing '{}' rows retain their current
-- default (OpenAI Luna, Anthropic Sonnet 4.6, or GLM-5).
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
    OR (
      provider = 'anthropic'
      AND (
        configuration = '{}'::jsonb
        OR (
          jsonb_typeof(configuration) = 'object'
          AND configuration ? 'modelId'
          AND configuration - 'modelId' = '{}'::jsonb
          AND configuration->>'modelId' IN ('claude-sonnet-4-6', 'claude-opus-4-8')
        )
      )
    )
    OR (
      provider = 'glm'
      AND (
        configuration = '{}'::jsonb
        OR (
          jsonb_typeof(configuration) = 'object'
          AND configuration ? 'modelId'
          AND configuration - 'modelId' = '{}'::jsonb
          AND configuration->>'modelId' IN ('glm-5', 'glm-5.2')
        )
      )
    )
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
