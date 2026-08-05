-- id: 01KZ7KNTPA69RM4868J4SB2H9V
-- depends-on: 01KZ6DV8HHZW1CRJW9A5Z572X0

-- Expand the connector taxonomy while retaining the prior constraint until
-- existing rows have been validated against the new accepted values.
ALTER TABLE connector_registry
  ADD CONSTRAINT connector_registry_category_with_search_check
  CHECK (category IN ('Productivity','Search','Developer tools','Business','Communication','Data and analytics','Other'))
  NOT VALID;

ALTER TABLE connector_registry
  VALIDATE CONSTRAINT connector_registry_category_with_search_check;

ALTER TABLE connector_registry
  DROP CONSTRAINT connector_registry_category_check;

ALTER TABLE connector_registry
  RENAME CONSTRAINT connector_registry_category_with_search_check TO connector_registry_category_check;
