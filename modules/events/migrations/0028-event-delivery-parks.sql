-- WP-030 / NR-043: denied checks have their own mutable projection counter.
-- ADR-ADJ-018 preserves genuine publish attempts and the immutable envelope.
-- No legacy counter split is inferable from last_error: refuse ambiguity.
-- Reapplication must preserve valid attempts and park history after activation.
DO $park_migration$
BEGIN
  LOCK TABLE events.outbox_delivery IN ACCESS EXCLUSIVE MODE;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'events'
       AND table_name = 'outbox_delivery'
       AND column_name = 'park_count'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM events.outbox_delivery
       WHERE status IN ('pending', 'failed') AND attempts > 0
    ) THEN
      RAISE EXCEPTION
        'event park migration requires reviewed legacy attempt classification';
    END IF;
    ALTER TABLE events.outbox_delivery
      ADD COLUMN park_count integer NOT NULL DEFAULT 0
        CHECK (park_count >= 0);
  END IF;
END
$park_migration$;
