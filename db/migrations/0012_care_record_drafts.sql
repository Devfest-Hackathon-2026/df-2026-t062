-- AI原案と参照資料は正式保存版と分離。採用しても保存・最終確定は行わない。
CREATE TABLE care_record_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  template_version_id uuid NOT NULL REFERENCES form_template_versions(id),
  request_id uuid NOT NULL,
  source jsonb NOT NULL,
  base jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('generating','ready','failed')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  created_by uuid NOT NULL REFERENCES staff(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_by uuid REFERENCES staff(id),
  applied_at timestamptz,
  UNIQUE (document_id, request_id)
);
CREATE FUNCTION guard_care_record_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id=NEW.document_id AND d.office_id=NEW.office_id AND d.client_id=NEW.client_id AND d.kind='care_plan_5') THEN
    RAISE EXCEPTION 'care record draft scope mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.source IS DISTINCT FROM OLD.source OR NEW.base IS DISTINCT FROM OLD.base OR NEW.document_id<>OLD.document_id OR NEW.template_version_id<>OLD.template_version_id OR (OLD.status<>'generating' AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.status<>OLD.status)) OR OLD.applied_at IS NOT NULL) THEN
    RAISE EXCEPTION 'care record draft source and completed result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER care_record_draft_guard BEFORE INSERT OR UPDATE ON care_record_drafts FOR EACH ROW EXECUTE FUNCTION guard_care_record_draft();
