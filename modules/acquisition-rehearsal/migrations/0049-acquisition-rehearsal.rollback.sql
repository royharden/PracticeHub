DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'acquisition_rehearsal') THEN
    DROP TABLE IF EXISTS acquisition_rehearsal.rehearsal_run;
    DROP SCHEMA IF EXISTS acquisition_rehearsal;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_acquisition_rehearsal') THEN
    DROP ROLE module_acquisition_rehearsal;
  END IF;
END
$guard$;
