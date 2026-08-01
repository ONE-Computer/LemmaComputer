-- id: 01KYXT0X6P08PP978WHJPB8MV5
-- depends-on: 01KYXCBTKG3GSSNSRCN6EMG5B5

-- Expand the read-safe provider metadata constraint with an optional national
-- grid accounting assumption. This does not alter provider routing or claim
-- that inference is physically pinned to the selected country.
ALTER TABLE provider_settings
  DROP CONSTRAINT provider_settings_configuration_safe_check,
  ADD CONSTRAINT provider_settings_configuration_safe_check CHECK (
    jsonb_typeof(configuration) = 'object'
    AND (
      NOT configuration ? 'emissionsRegion'
      OR configuration->>'emissionsRegion' IN ('us', 'sg')
    )
    AND (
      (
        provider = 'openai'
        AND (
          configuration - 'emissionsRegion' = '{}'::jsonb
          OR (
            configuration ? 'modelId'
            AND configuration - 'emissionsRegion' - 'modelId' = '{}'::jsonb
            AND configuration->>'modelId' IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
          )
          OR (
            configuration ? 'modelIds'
            AND configuration - 'emissionsRegion' - 'modelIds' = '{}'::jsonb
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
          configuration - 'emissionsRegion' = '{}'::jsonb
          OR (
            configuration ? 'modelId'
            AND configuration - 'emissionsRegion' - 'modelId' = '{}'::jsonb
            AND configuration->>'modelId' IN ('claude-sonnet-4-6', 'claude-opus-4-8')
          )
          OR (
            configuration ? 'modelIds'
            AND configuration - 'emissionsRegion' - 'modelIds' = '{}'::jsonb
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
          configuration - 'emissionsRegion' = '{}'::jsonb
          OR (
            configuration ? 'modelId'
            AND configuration - 'emissionsRegion' - 'modelId' = '{}'::jsonb
            AND configuration->>'modelId' IN ('glm-5', 'glm-5.2')
          )
          OR (
            configuration ? 'modelIds'
            AND configuration - 'emissionsRegion' - 'modelIds' = '{}'::jsonb
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
        AND configuration ? 'region'
        AND configuration ? 'modelProfileId'
        AND configuration - 'emissionsRegion' - 'region' - 'modelProfileId' = '{}'::jsonb
        AND configuration->>'region' IN ('ap-southeast-1', 'us-east-1', 'us-west-2', 'eu-west-1')
        AND configuration->>'modelProfileId' = 'claude-sonnet-4-5-global'
      )
    )
  );
