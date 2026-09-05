-- id: 01M1RMR6XK02Q6F3Q7WVNK5K1F
-- depends-on: 01M1QKKTMQT5S3V5R7ZGB20Y6P

-- Expand the existing read-only permission; existing grants remain read-only.
-- Brief ACCESS EXCLUSIVE lock while replacing/validating the check constraint.
ALTER TABLE site_grants DROP CONSTRAINT site_grants_permission_check;
ALTER TABLE site_grants ADD CONSTRAINT site_grants_permission_check
  CHECK (permission IN ('viewer', 'admin'));
