-- id: 01KZJZA8SA83R60W30EZMXEQ3X
-- depends-on: 01KZJXVP8M97QZDDJKDEVKHWB7

-- Forward-only migration. Add safe, bounded SQL below.

-- A delivery completion is valid only for the exact lease generation claimed
-- by that worker. Existing in-flight rows are returned to the durable queue so
-- no pre-fencing worker can mutate them after this migration.
UPDATE platform_security_alert_outbox SET
  status=CASE WHEN attempt_count>=max_attempts THEN 'escalated' ELSE 'retry' END,
  last_error=CASE WHEN attempt_count>=max_attempts
    THEN 'Delivery lease expired after final attempt'
    ELSE 'Delivery lease invalidated during lease-fencing migration'
  END,
  available_at=now(),updated_at=now()
WHERE status='delivering';

ALTER TABLE platform_security_alert_outbox
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_generation integer NOT NULL DEFAULT 0 CHECK (lease_generation>=0);

ALTER TABLE platform_security_alert_outbox
  ADD CONSTRAINT platform_security_alert_outbox_lease_check CHECK (
    (status='delivering' AND lease_token IS NOT NULL AND claimed_at IS NOT NULL)
    OR (status<>'delivering' AND lease_token IS NULL)
  );
