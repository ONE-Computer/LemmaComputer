-- id: 01KZJTB13VRQ8G7E0114QYBP02
-- depends-on: 01KZJSHVQPG3W9BMCZ3HXPEPYV

CREATE TABLE platform_operator_oidc_attempts (
  state_hash char(64) PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  verifier_ciphertext text NOT NULL,
  nonce text NOT NULL,
  return_path text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX platform_operator_oidc_attempts_expiry_idx
  ON platform_operator_oidc_attempts (expires_at);
