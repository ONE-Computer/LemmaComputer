-- id: 01KZTK2EFP332F14HA0JZ2CFNX
-- depends-on: 01KZT7C2TS1P6XQR444GBRHK9S

ALTER TABLE activity_events ADD COLUMN agent_instance_id uuid;
ALTER TABLE governed_operations ADD COLUMN agent_instance_id uuid;
ALTER TABLE ai_usage_attempt_admissions ADD COLUMN agent_instance_id uuid;

ALTER TABLE activity_events ADD CONSTRAINT activity_events_agent_instance_fk
  FOREIGN KEY (tenant_id,agent_instance_id) REFERENCES agent_instances(tenant_id,id);
ALTER TABLE governed_operations ADD CONSTRAINT governed_operations_agent_instance_fk
  FOREIGN KEY (tenant_id,agent_instance_id) REFERENCES agent_instances(tenant_id,id);
ALTER TABLE ai_usage_attempt_admissions ADD CONSTRAINT ai_usage_admissions_agent_instance_fk
  FOREIGN KEY (tenant_id,agent_instance_id) REFERENCES agent_instances(tenant_id,id);

CREATE INDEX activity_events_agent_instance_idx ON activity_events (tenant_id,agent_instance_id,occurred_at DESC) WHERE agent_instance_id IS NOT NULL;
CREATE INDEX governed_operations_agent_instance_idx ON governed_operations (tenant_id,agent_instance_id,created_at DESC) WHERE agent_instance_id IS NOT NULL;
CREATE INDEX ai_usage_admissions_agent_instance_idx ON ai_usage_attempt_admissions (tenant_id,agent_instance_id,admitted_at DESC) WHERE agent_instance_id IS NOT NULL;

-- Existing rows remain NULL by design: NULL is the explicit legacy/no-instance state.
