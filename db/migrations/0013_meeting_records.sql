INSERT INTO form_kinds (key,name,per_client,is_primary,create_from,required,topics,summary_mode)
VALUES ('care_plan_4','サービス担当者会議の要点 第4表','many',false,'assessment','[]','[]','single') ON CONFLICT(key) DO NOTHING;
CREATE OR REPLACE FUNCTION check_care_record_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id=NEW.document_id AND d.office_id=NEW.office_id AND d.client_id=NEW.client_id AND d.kind IN ('care_plan_4','care_plan_5')) THEN
  RAISE EXCEPTION 'care record document scope mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_care_record_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.id=NEW.document_id AND d.office_id=NEW.office_id AND d.client_id=NEW.client_id AND d.kind IN ('care_plan_4','care_plan_5')) THEN
    RAISE EXCEPTION 'care record draft scope mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.source IS DISTINCT FROM OLD.source OR NEW.base IS DISTINCT FROM OLD.base OR NEW.document_id<>OLD.document_id OR NEW.template_version_id<>OLD.template_version_id OR (OLD.status<>'generating' AND (NEW.result IS DISTINCT FROM OLD.result OR NEW.status<>OLD.status)) OR OLD.applied_at IS NOT NULL) THEN
    RAISE EXCEPTION 'care record draft source and completed result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
