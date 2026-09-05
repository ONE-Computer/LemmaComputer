-- id: 01M1S15T60RZ36F72GXKNMPMD1
-- depends-on: 01M1RMR6XK02Q6F3Q7WVNK5K1F

-- Forward-only migration. Add safe, bounded SQL below.
ALTER TABLE site_invitations
  ADD COLUMN dismissed_at timestamptz;

ALTER TABLE site_invitation_audit_events
  DROP CONSTRAINT site_invitation_audit_events_event_type_check;

ALTER TABLE site_invitation_audit_events
  ADD CONSTRAINT site_invitation_audit_events_event_type_check CHECK (event_type IN (
    'invitation.created',
    'invitation.resent',
    'invitation.expired',
    'invitation.revoked',
    'invitation.accepted',
    'invitation.removed'
  ));
