-- Migration 006 originally created this column, but existing installations may
-- already have the consent-task table from an earlier revision of that
-- migration. Keep historical rows nullable because their exact signed-request
-- proof hash cannot be reconstructed safely; every new task supplies the hash.
ALTER TABLE openvtc_consent_tasks
  ADD COLUMN IF NOT EXISTS request_proof_hash text
  CHECK (request_proof_hash IS NULL OR length(request_proof_hash) = 64);
