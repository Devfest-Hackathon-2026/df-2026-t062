CREATE TABLE care_record_confirmations (
 revision_id bigint PRIMARY KEY REFERENCES revisions(id),
 document_id uuid NOT NULL REFERENCES documents(id),
 office_id uuid NOT NULL REFERENCES offices(id),
 client_id uuid NOT NULL REFERENCES clients(id),
 plan_confirmation_id uuid REFERENCES care_plan_confirmations(id),
 confirmed_by uuid NOT NULL REFERENCES staff(id),
 confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_care_record_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'record confirmation is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM documents d JOIN revisions r ON r.document_id=d.id JOIN staff s ON s.id=NEW.confirmed_by
  WHERE d.id=NEW.document_id AND d.office_id=NEW.office_id AND d.client_id=NEW.client_id
   AND d.kind IN ('care_plan_4','care_plan_5') AND r.id=NEW.revision_id
   AND s.office_id=d.office_id AND s.disabled_at IS NULL
   AND r.rev=(SELECT max(rev) FROM revisions WHERE document_id=d.id)
   AND r.template_version_id=d.template_version_id
   AND r."values"=(SELECT coalesce(jsonb_object_agg(f.key,f.value),'{}'::jsonb) FROM field_values f WHERE f.document_id=d.id)
   AND (NEW.plan_confirmation_id IS NULL OR (d.kind='care_plan_4' AND EXISTS (
    SELECT 1 FROM care_plan_confirmations pc JOIN care_plans p ON p.id=pc.plan_id
    WHERE pc.id=NEW.plan_confirmation_id AND p.office_id=d.office_id AND p.client_id=d.client_id
   )))
 ) THEN RAISE EXCEPTION 'record confirmation scope or version mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_record_confirmation_guard BEFORE INSERT OR UPDATE OR DELETE ON care_record_confirmations FOR EACH ROW EXECUTE FUNCTION guard_care_record_confirmation();
