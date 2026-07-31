-- id: 01KYVY2AV18NV791TCGTQ2Z39N
-- depends-on: 01KYVDY5THVCDGJT95MVGFFCES

-- Expand read-safe direct-provider metadata to accept either the legacy
-- scalar modelId or a non-empty bounded modelIds array. Existing rows and
-- rollback readers retain their scalar shape; no data rewrite is required.
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
        OR (
          jsonb_typeof(configuration) = 'object'
          AND configuration ? 'modelIds'
          AND configuration - 'modelIds' = '{}'::jsonb
          AND jsonb_typeof(configuration->'modelIds') = 'array'
          AND jsonb_array_length(configuration->'modelIds') BETWEEN 1 AND 3
          AND configuration->'modelIds' <@ '["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]'::jsonb
          AND jsonb_array_length(configuration->'modelIds') = (
            ((configuration->'modelIds') ? 'gpt-5.6-sol')::int
            + ((configuration->'modelIds') ? 'gpt-5.6-terra')::int
            + ((configuration->'modelIds') ? 'gpt-5.6-luna')::int
          )
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
        OR (
          jsonb_typeof(configuration) = 'object'
          AND configuration ? 'modelIds'
          AND configuration - 'modelIds' = '{}'::jsonb
          AND jsonb_typeof(configuration->'modelIds') = 'array'
          AND jsonb_array_length(configuration->'modelIds') BETWEEN 1 AND 2
          AND configuration->'modelIds' <@ '["claude-sonnet-4-6", "claude-opus-4-8"]'::jsonb
          AND jsonb_array_length(configuration->'modelIds') = (
            ((configuration->'modelIds') ? 'claude-sonnet-4-6')::int
            + ((configuration->'modelIds') ? 'claude-opus-4-8')::int
          )
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
        OR (
          jsonb_typeof(configuration) = 'object'
          AND configuration ? 'modelIds'
          AND configuration - 'modelIds' = '{}'::jsonb
          AND jsonb_typeof(configuration->'modelIds') = 'array'
          AND jsonb_array_length(configuration->'modelIds') BETWEEN 1 AND 2
          AND configuration->'modelIds' <@ '["glm-5", "glm-5.2"]'::jsonb
          AND jsonb_array_length(configuration->'modelIds') = (
            ((configuration->'modelIds') ? 'glm-5')::int
            + ((configuration->'modelIds') ? 'glm-5.2')::int
          )
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
