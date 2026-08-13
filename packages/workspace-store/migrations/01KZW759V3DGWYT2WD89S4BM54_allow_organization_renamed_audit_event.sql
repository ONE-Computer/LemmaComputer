-- id: 01KZW759V3DGWYT2WD89S4BM54
-- depends-on: 01KZTTD6FRWXMK8445NM8KBYAF

-- Expanding the lifecycle event vocabulary takes a brief table lock while the
-- check constraint is replaced. No rows are rewritten and no data is removed.
ALTER TABLE organization_lifecycle_audit_events
  DROP CONSTRAINT organization_lifecycle_audit_events_event_type_check;

ALTER TABLE organization_lifecycle_audit_events
  ADD CONSTRAINT organization_lifecycle_audit_events_event_type_check
  CHECK (event_type IN (
    'organization.created',
    'organization.renamed',
    'organization.ownership_transferred',
    'organization.recovery_completed',
    'organization.closure_requested',
    'organization.closed'
  ));
