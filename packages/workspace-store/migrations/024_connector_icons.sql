ALTER TABLE connector_registry
  ADD COLUMN IF NOT EXISTS icon_data_url TEXT;

ALTER TABLE connector_registry
  DROP CONSTRAINT IF EXISTS connector_registry_icon_data_url_size;

ALTER TABLE connector_registry
  ADD CONSTRAINT connector_registry_icon_data_url_size
  CHECK (icon_data_url IS NULL OR char_length(icon_data_url) <= 350000);
