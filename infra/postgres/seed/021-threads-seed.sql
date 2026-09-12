-- WP-030 synthetic Thread seed. Runner wiring remains integrator-owned.
INSERT INTO comms.thread
  (tenant_id, thread_id, person_ref, work_item_ref, channel, purpose,
   owner_ref, escalated, status, synthetic)
VALUES
  ('northwind-synthetic', 'thread-william-001', 'person-william-001',
   'workitem:thread-william-001', 'sms', 'treatment',
   'guide-synthetic-001', false, 'open', true)
ON CONFLICT (tenant_id, thread_id) DO NOTHING;

INSERT INTO comms.thread_message
  (tenant_id, thread_id, message_id, direction, content_ref, vendor_event_key,
   delivery_state, holding, occurred_at, synthetic)
VALUES
  ('northwind-synthetic', 'thread-william-001', 'message-william-001', 'inbound',
   'synthetic-content:message-william-001', 'twilio-sim:event-william-001',
   'delivered', false, '2026-01-15T14:00:00Z', true)
ON CONFLICT (tenant_id, message_id) DO NOTHING;
