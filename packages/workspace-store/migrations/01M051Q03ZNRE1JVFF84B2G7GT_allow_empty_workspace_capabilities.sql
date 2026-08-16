-- id: 01M051Q03ZNRE1JVFF84B2G7GT
-- depends-on: 01M04J2FFVE8G7Q5NEWD3AEXMQ

ALTER TABLE sandbox_settings
  DROP CONSTRAINT sandbox_settings_application_ids_array,
  DROP CONSTRAINT sandbox_settings_agent_ids_array,
  ALTER COLUMN model_alias DROP NOT NULL;

ALTER TABLE sandbox_settings
  ADD CONSTRAINT sandbox_settings_application_ids_array
  CHECK (
    jsonb_typeof(application_ids) = 'array'
    AND jsonb_array_length(application_ids) BETWEEN 0 AND 4
  ) NOT VALID,
  ADD CONSTRAINT sandbox_settings_agent_ids_array
  CHECK (
    jsonb_typeof(agent_ids) = 'array'
    AND jsonb_array_length(agent_ids) BETWEEN 0 AND 5
  ) NOT VALID,
  ADD CONSTRAINT sandbox_settings_agent_model_pair
  CHECK (
    (jsonb_array_length(agent_ids) = 0 AND model_alias IS NULL)
    OR (jsonb_array_length(agent_ids) > 0 AND model_alias IS NOT NULL)
  ) NOT VALID;

ALTER TABLE sandbox_settings
  VALIDATE CONSTRAINT sandbox_settings_application_ids_array,
  VALIDATE CONSTRAINT sandbox_settings_agent_ids_array,
  VALIDATE CONSTRAINT sandbox_settings_agent_model_pair;
