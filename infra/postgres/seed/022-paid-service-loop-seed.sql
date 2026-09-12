-- WP-031 synthetic-only paid-service loop seed. No clinical or card data.
INSERT INTO catalog_cash.catalog_offer
  (tenant_id, offer_version_ref, catalog_version_ref, opaque_processor_sku_ref, amount_minor,
   currency, expires_at, component_lines, cancellation_policy_ref, refund_policy_ref, synthetic)
VALUES
  ('northwind-synthetic', 'offer-paid-service-v1', 'catalog-paid-service-v1', 'sku-opaque-ps-v1',
   5000, 'USD', '2027-01-01T00:00:00Z',
   '[{"componentRef":"component-guide","quantity":1,"ownerRole":"guide","entitlementKind":"single-service","fulfillmentKind":"service"},{"componentRef":"component-clinician","quantity":1,"ownerRole":"clinician","entitlementKind":"single-service","fulfillmentKind":"service"}]'::jsonb,
   'policy-cancel-v1', 'policy-refund-v1', true)
ON CONFLICT (tenant_id, offer_version_ref) DO NOTHING;
