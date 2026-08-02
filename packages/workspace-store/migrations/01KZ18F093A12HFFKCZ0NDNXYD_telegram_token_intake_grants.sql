-- id: 01KZ18F093A12HFFKCZ0NDNXYD
-- depends-on: 01KYYCNT4QCA6S1EMCK79AVTZD

-- A consumed grant is retained as replay evidence only. It contains no
-- Telegram token or envelope ciphertext and is safe to retain for incident
-- correlation and bounded expiry sweeping.
CREATE TABLE telegram_token_intake_grants (
  grant_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create','rotate')),
  credential_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 16 AND 256),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX telegram_token_intake_grants_expiry_idx
  ON telegram_token_intake_grants (expires_at, consumed_at);
