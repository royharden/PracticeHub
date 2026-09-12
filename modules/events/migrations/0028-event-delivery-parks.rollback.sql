-- Stop dispatch and revert the park-aware code before this rollback.
-- Nonzero history must remain available; this rollback never erases it.
DO $park_rollback$
BEGIN
  LOCK TABLE events.outbox_delivery IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'events'
       AND table_name = 'outbox_delivery'
       AND column_name = 'park_count'
  ) THEN
    IF EXISTS (SELECT 1 FROM events.outbox_delivery WHERE park_count <> 0) THEN
      RAISE EXCEPTION 'event park rollback preserves nonzero park history';
    END IF;
    ALTER TABLE events.outbox_delivery DROP COLUMN park_count;
  END IF;
END
$park_rollback$;
