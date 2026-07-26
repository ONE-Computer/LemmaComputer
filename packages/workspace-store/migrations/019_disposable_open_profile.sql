ALTER TABLE sandbox_settings
  DROP CONSTRAINT IF EXISTS sandbox_settings_profile_id_check;

ALTER TABLE sandbox_settings
  ADD CONSTRAINT sandbox_settings_profile_id_check
  CHECK (profile_id IN (
    'claude-desktop-standard-v1',
    'kasm-persistent-standard',
    'disposable-open-v1'
  ));
