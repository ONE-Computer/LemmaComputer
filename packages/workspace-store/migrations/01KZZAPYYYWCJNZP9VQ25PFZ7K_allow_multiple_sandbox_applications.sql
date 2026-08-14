-- id: 01KZZAPYYYWCJNZP9VQ25PFZ7K
-- depends-on: 01KZXXE376T0Y2KA3ZV0X5W316

ALTER TABLE sandbox_settings
  DROP CONSTRAINT sandbox_settings_application_ids_array;

ALTER TABLE sandbox_settings
  ADD CONSTRAINT sandbox_settings_application_ids_array
  CHECK (
    jsonb_typeof(application_ids) = 'array'
    AND jsonb_array_length(application_ids) BETWEEN 1 AND 2
  ) NOT VALID;

ALTER TABLE sandbox_settings
  VALIDATE CONSTRAINT sandbox_settings_application_ids_array;
