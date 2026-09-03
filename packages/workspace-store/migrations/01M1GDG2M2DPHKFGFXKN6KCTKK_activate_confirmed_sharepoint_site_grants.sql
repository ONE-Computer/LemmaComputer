-- id: 01M1GDG2M2DPHKFGFXKN6KCTKK
-- depends-on: 01M0Z8KX3CEF354RHMEP1EHBPR

-- The Site Manager confirms both the canonical Graph site and the connector's
-- site-specific application permission during grant creation/readback. Treat
-- that provider-side confirmation as the organization readiness signal rather
-- than coupling activation to an administrator's delegated token.
UPDATE microsoft365_sharepoint_sites
SET status='verified',
    last_verified_at=COALESCE(last_verified_at, microsoft_granted_at, updated_at, now()),
    last_verification_error=NULL,
    drive_ids='[]'::jsonb,
    updated_at=now()
WHERE microsoft_access_status='granted'
  AND graph_site_id IS NOT NULL
  AND (
    status<>'verified'
    OR last_verified_at IS NULL
    OR last_verification_error IS NOT NULL
  );
