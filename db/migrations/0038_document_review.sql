-- 保存と人間の確認・正式確定を分ける。既存の保存済み値を確認済みに移行しない。
ALTER TABLE field_values ADD COLUMN value_version uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE field_values ADD COLUMN reviewed_at timestamptz;
ALTER TABLE field_values ADD COLUMN reviewed_by uuid REFERENCES staff(id);
ALTER TABLE field_values ADD CONSTRAINT field_review_actor CHECK ((reviewed_at IS NULL) = (reviewed_by IS NULL));
CREATE TABLE document_confirmations (
 document_id uuid NOT NULL REFERENCES documents(id),
 rev integer NOT NULL,
 confirmed_by uuid NOT NULL REFERENCES staff(id),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (document_id, rev),
 FOREIGN KEY (document_id, rev) REFERENCES revisions(document_id, rev)
);
CREATE FUNCTION guard_document_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'document confirmation is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM documents d JOIN staff s ON s.office_id=d.office_id WHERE d.id=NEW.document_id AND s.id=NEW.confirmed_by) THEN
  RAISE EXCEPTION 'document confirmation scope mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_confirmation_guard BEFORE INSERT OR UPDATE OR DELETE ON document_confirmations FOR EACH ROW EXECUTE FUNCTION guard_document_confirmation();
