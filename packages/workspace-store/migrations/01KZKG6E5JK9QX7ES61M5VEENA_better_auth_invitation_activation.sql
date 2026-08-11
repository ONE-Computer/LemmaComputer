-- id: 01KZKG6E5JK9QX7ES61M5VEENA
-- depends-on: 01KZKB855Y1M5ZT32TJPV3M4VC

-- A raw invitation capability exists only at the delivery/browser boundary.
-- Redirect-safe activation contexts persist hashes plus the invitation delivery
-- generation so a resend supersedes every context created from the prior link.

CREATE TABLE organization_invitation_activation_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  invitation_id uuid NOT NULL,
  delivery_generation integer NOT NULL CHECK (delivery_generation > 0),
  context_token_hash char(64) NOT NULL UNIQUE,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,invitation_id)
    REFERENCES organization_invitations(organization_id,id) ON DELETE CASCADE,
  CHECK (consumed_at IS NULL OR consumed_at>=created_at)
);

CREATE INDEX organization_invitation_activation_invitation_idx
  ON organization_invitation_activation_contexts (
    organization_id,invitation_id,delivery_generation,expires_at
  ) WHERE consumed_at IS NULL;

CREATE INDEX organization_invitation_activation_expiry_idx
  ON organization_invitation_activation_contexts (expires_at)
  WHERE consumed_at IS NULL;
