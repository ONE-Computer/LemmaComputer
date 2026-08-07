-- id: 01KZDMJVTS4Y1K48DEZMFQ65VE
-- depends-on: 01KZCV5X3BP4M3A5GCGXG07K7E

-- Additive, tenant-scoped authentication audit. Payloads intentionally contain
-- no email addresses, credentials, OTPs, authorization codes, or provider tokens.

CREATE TABLE organization_access_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id),
  membership_id uuid,
  invitation_id uuid,
  actor_user_id text,
  event_type text NOT NULL CHECK (event_type IN (
    'authentication.login_succeeded','authentication.login_failed',
    'authentication.logout','invitation.link_failed','session.revoked'
  )),
  provider text NOT NULL CHECK (provider IN ('entra','entra-external-id','product')),
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,membership_id)
    REFERENCES organization_memberships(organization_id,id),
  FOREIGN KEY (organization_id,invitation_id)
    REFERENCES organization_invitations(organization_id,id),
  FOREIGN KEY (organization_id,actor_user_id)
    REFERENCES users(tenant_id,id)
);

CREATE INDEX organization_access_audit_org_time_idx
  ON organization_access_audit_events (organization_id,occurred_at DESC,id DESC);
