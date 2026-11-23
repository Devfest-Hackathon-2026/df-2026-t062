DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'recording_cleanup'
  ) THEN
    GRANT INSERT (
      office_id,
      staff_id,
      client_id,
      document_id,
      action,
      outcome,
      request_id,
      correlation_id,
      trace_id,
      source,
      route,
      schema_version,
      detail
    ) ON audit_events TO recording_cleanup;

    GRANT USAGE, SELECT
      ON SEQUENCE audit_events_id_seq
      TO recording_cleanup;
  END IF;
END
$$;
