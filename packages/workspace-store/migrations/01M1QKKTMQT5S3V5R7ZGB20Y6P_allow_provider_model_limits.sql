-- id: 01M1QKKTMQT5S3V5R7ZGB20Y6P
-- depends-on: 01M1JWWKHFG5C31ZEQDFN5VSVK

-- Expand existing JSON metadata without rewriting rows. Preserve every
-- existing provider-selection/secret-safety check, excluding only the new key.
DO $$
DECLARE prior_check text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT prior_check
    FROM pg_constraint
    WHERE conrelid = 'provider_settings'::regclass
      AND conname = 'provider_settings_configuration_safe_check';
  ALTER TABLE provider_settings DROP CONSTRAINT provider_settings_configuration_safe_check;
  EXECUTE 'ALTER TABLE provider_settings ADD CONSTRAINT provider_settings_configuration_safe_check '
    || replace(prior_check, 'configuration', '(configuration - ''modelLimits'')');
END $$;

CREATE FUNCTION provider_model_limits_valid(limits jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item record; context_size numeric; output_size numeric;
BEGIN
  IF jsonb_typeof(limits) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_each(limits) LOOP
    IF length(item.key) NOT BETWEEN 1 AND 300
      OR jsonb_typeof(item.value) IS DISTINCT FROM 'object'
      OR jsonb_typeof(item.value->'contextTokens') IS DISTINCT FROM 'number'
      OR jsonb_typeof(item.value->'outputTokens') IS DISTINCT FROM 'number'
      OR item.value - 'contextTokens' - 'outputTokens' <> '{}'::jsonb
    THEN RETURN false; END IF;
    context_size := (item.value->>'contextTokens')::numeric;
    output_size := (item.value->>'outputTokens')::numeric;
    IF context_size <> trunc(context_size) OR output_size <> trunc(output_size)
      OR context_size NOT BETWEEN 1024 AND 100000000
      OR output_size < 1 OR output_size >= context_size
    THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

ALTER TABLE provider_settings ADD CONSTRAINT provider_settings_model_limits_check
  CHECK (NOT configuration ? 'modelLimits' OR provider_model_limits_valid(configuration->'modelLimits'));
