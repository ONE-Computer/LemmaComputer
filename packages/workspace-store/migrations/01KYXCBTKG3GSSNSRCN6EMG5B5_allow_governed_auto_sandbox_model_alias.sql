-- id: 01KYXCBTKG3GSSNSRCN6EMG5B5
-- depends-on: 01KYWFXSM7WJD08T5EE49C39GT

ALTER TABLE sandbox_settings
  DROP CONSTRAINT IF EXISTS sandbox_settings_model_alias_check;

ALTER TABLE sandbox_settings
  ADD CONSTRAINT sandbox_settings_model_alias_check
  CHECK (model_alias IN (
    'onecomputer-auto',
    'onecomputer-claude',
    'onecomputer-openai',
    'onecomputer-glm',
    'onecomputer-assistant',
    'onecomputer-bedrock'
  )) NOT VALID;

ALTER TABLE sandbox_settings
  VALIDATE CONSTRAINT sandbox_settings_model_alias_check;
