-- id: 01KZCV5X3BP4M3A5GCGXG07K7E
-- depends-on: 01KZ7QPE5S95VH28NPHSRGWWGP

-- Additive invitation state for both deployment profiles. Invitation tokens and
-- request idempotency keys are stored only as SHA-256 hashes. No identity-provider
-- password, MFA secret, authorization code, or provider token belongs here.

CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id),
  email text NOT NULL CHECK (email=lower(email) AND char_length(email) BETWEEN 3 AND 320),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  token_hash char(64) NOT NULL UNIQUE,
  create_idempotency_key_hash char(64) NOT NULL,
  last_resend_idempotency_key_hash char(64),
  delivery_generation integer NOT NULL DEFAULT 1 CHECK (delivery_generation > 0),
  expires_at timestamptz NOT NULL,
  accepted_membership_id uuid,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,create_idempotency_key_hash),
  FOREIGN KEY (organization_id,created_by) REFERENCES users(tenant_id,id),
  FOREIGN KEY (organization_id,updated_by) REFERENCES users(tenant_id,id),
  FOREIGN KEY (organization_id,accepted_membership_id)
    REFERENCES organization_memberships(organization_id,id),
  CHECK (
    status='accepted' AND accepted_membership_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL
    OR status='revoked' AND accepted_membership_id IS NULL AND accepted_at IS NULL AND revoked_at IS NOT NULL
    OR status IN ('pending','expired') AND accepted_membership_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL
  )
);

CREATE UNIQUE INDEX organization_invitations_pending_email_idx
  ON organization_invitations (organization_id,email)
  WHERE status='pending';

CREATE INDEX organization_invitations_org_status_idx
  ON organization_invitations (organization_id,status,expires_at,id);

CREATE TABLE organization_invitation_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id),
  invitation_id uuid NOT NULL,
  actor_user_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'invitation.created','invitation.resent','invitation.expired',
    'invitation.revoked','invitation.accepted'
  )),
  old_status text CHECK (old_status IS NULL OR old_status IN ('pending','accepted','expired','revoked')),
  new_status text NOT NULL CHECK (new_status IN ('pending','accepted','expired','revoked')),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  delivery_generation integer NOT NULL CHECK (delivery_generation > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,invitation_id)
    REFERENCES organization_invitations(organization_id,id),
  FOREIGN KEY (organization_id,actor_user_id) REFERENCES users(tenant_id,id)
);

CREATE INDEX organization_invitation_audit_org_time_idx
  ON organization_invitation_audit_events (organization_id,occurred_at DESC,id DESC);
