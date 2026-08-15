-- id: 01M01ZJZ86BZ21SD78N3J9SQGN
-- depends-on: 01M00D3M7EHG3KTDDH1V03CN2Q

ALTER TABLE sandbox_settings
  DROP CONSTRAINT sandbox_settings_application_ids_array;

ALTER TABLE sandbox_settings
  ADD CONSTRAINT sandbox_settings_application_ids_array
  CHECK (
    jsonb_typeof(application_ids) = 'array'
    AND jsonb_array_length(application_ids) BETWEEN 1 AND 4
  ) NOT VALID;

ALTER TABLE sandbox_settings
  VALIDATE CONSTRAINT sandbox_settings_application_ids_array;
