-- id: 01KYK8E3ZXZDZ2XS2367HWHMA7
-- depends-on: 028

-- Keep existing policy rows valid while admitting the one reviewed dynamic
-- Bedrock route. The runner executes this inside its own ledger transaction.
ALTER TABLE sandbox_settings
  DROP CONSTRAINT IF EXISTS sandbox_settings_model_alias_check;

ALTER TABLE sandbox_settings
  ADD CONSTRAINT sandbox_settings_model_alias_check
  CHECK (model_alias IN (
    'onecomputer-claude',
    'onecomputer-openai',
    'onecomputer-glm',
    'onecomputer-assistant',
    'onecomputer-bedrock'
  ));
