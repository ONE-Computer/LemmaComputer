-- id: 01KZ6DV8HHZW1CRJW9A5Z572X0
-- depends-on: 01KZ1D25Q454AJ8Y2H1ZP8JGB7

-- Breaking namespace migration. Historical migration files remain immutable;
-- this moves the effective schema and its stored technical identifiers to Lemma.

UPDATE sandbox_settings
SET model_alias = replace(model_alias, 'onecomputer-', 'lemmacomputer-')
WHERE model_alias LIKE 'onecomputer-%';

ALTER TABLE sandbox_settings
  DROP CONSTRAINT IF EXISTS sandbox_settings_model_alias_check;

ALTER TABLE sandbox_settings
  ADD CONSTRAINT sandbox_settings_model_alias_check
  CHECK (model_alias IN (
    'lemmacomputer-auto',
    'lemmacomputer-claude',
    'lemmacomputer-openai',
    'lemmacomputer-glm',
    'lemmacomputer-assistant',
    'lemmacomputer-bedrock'
  ));

UPDATE openvtc_companion_subscriptions
SET protocol_version = 'lemmacomputer-companion-push-0.1'
WHERE protocol_version = 'onecomputer-companion-push-0.1';

ALTER TABLE openvtc_companion_subscriptions
  DROP CONSTRAINT IF EXISTS openvtc_companion_subscriptions_protocol_version_check;

ALTER TABLE openvtc_companion_subscriptions
  ADD CONSTRAINT openvtc_companion_subscriptions_protocol_version_check
  CHECK (protocol_version = 'lemmacomputer-companion-push-0.1');

ALTER FUNCTION onecomputer_reject_ai_routing_mutation()
  RENAME TO lemmacomputer_reject_ai_routing_mutation;
ALTER FUNCTION onecomputer_reject_ai_ledger_mutation()
  RENAME TO lemmacomputer_reject_ai_ledger_mutation;
ALTER FUNCTION onecomputer_reject_team_budget_history_mutation()
  RENAME TO lemmacomputer_reject_team_budget_history_mutation;
ALTER FUNCTION onecomputer_validate_routing_decision_price()
  RENAME TO lemmacomputer_validate_routing_decision_price;
ALTER FUNCTION onecomputer_validate_routing_observation()
  RENAME TO lemmacomputer_validate_routing_observation;
