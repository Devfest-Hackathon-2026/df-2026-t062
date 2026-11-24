CREATE FUNCTION recording_consent_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'recording consent events are immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM clients c
      JOIN staff s ON s.id = NEW.actor_staff_id AND s.office_id = c.office_id
     WHERE c.id = NEW.client_id AND c.office_id = NEW.office_id
  ) THEN
    RAISE EXCEPTION 'recording consent scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER recording_consent_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON recording_consent_events
  FOR EACH ROW EXECUTE FUNCTION recording_consent_events_guard();
