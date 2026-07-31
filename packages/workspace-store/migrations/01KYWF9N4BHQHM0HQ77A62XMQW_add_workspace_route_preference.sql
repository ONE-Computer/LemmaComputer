-- id: 01KYWF9N4BHQHM0HQ77A62XMQW
-- depends-on: 01KYVY2AV18NV791TCGTQ2Z39N

ALTER TABLE sandbox_settings
  ADD COLUMN requested_service_class text NOT NULL DEFAULT 'auto'
  CHECK (requested_service_class IN ('auto','lite','balanced','pro'));
