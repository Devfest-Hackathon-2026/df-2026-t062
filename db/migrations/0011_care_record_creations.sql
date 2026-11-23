-- 値・保存履歴は既存documents/field_values/revisions。追加表は再送の識別子だけを持つ。
CREATE TABLE care_record_creations (
  office_id uuid NOT NULL REFERENCES offices(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  request_id uuid NOT NULL,
  document_id uuid NOT NULL UNIQUE REFERENCES documents(id),
  PRIMARY KEY (office_id, client_id, request_id)
);
CREATE FUNCTION check_care_record_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id=NEW.document_id AND d.office_id=NEW.office_id AND d.client_id=NEW.client_id AND d.kind='care_plan_5') THEN
    RAISE EXCEPTION 'care record document scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER care_record_creation_scope BEFORE INSERT OR UPDATE ON care_record_creations FOR EACH ROW EXECUTE FUNCTION check_care_record_creation();
