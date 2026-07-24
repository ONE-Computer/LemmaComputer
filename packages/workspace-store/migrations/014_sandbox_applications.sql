ALTER TABLE sandbox_settings
  ADD COLUMN IF NOT EXISTS application_ids jsonb NOT NULL DEFAULT '["firefox"]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sandbox_settings_application_ids_array'
  ) THEN
    ALTER TABLE sandbox_settings
      ADD CONSTRAINT sandbox_settings_application_ids_array
      CHECK (jsonb_typeof(application_ids) = 'array' AND jsonb_array_length(application_ids) BETWEEN 1 AND 1);
  END IF;
END $$;
