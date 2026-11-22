INSERT INTO form_kinds (key,name,per_client,is_primary,create_from,required,topics,summary_mode)
VALUES ('care_plan_6','サービス利用票 第6表','many',false,'assessment','[]','[]','single') ON CONFLICT(key) DO NOTHING;
CREATE TABLE care_plan_months (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 office_id uuid NOT NULL REFERENCES offices(id), client_id uuid NOT NULL REFERENCES clients(id),
 plan_id uuid NOT NULL REFERENCES care_plans(id), confirmation_id uuid NOT NULL REFERENCES care_plan_confirmations(id),
 document_id uuid NOT NULL UNIQUE REFERENCES documents(id), target_month text NOT NULL CHECK(target_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 request_id uuid NOT NULL, source_hash text NOT NULL, entries jsonb NOT NULL DEFAULT '[]',
 lock_version integer NOT NULL DEFAULT 1 CHECK(lock_version>0), created_by uuid NOT NULL REFERENCES staff(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(plan_id,target_month), UNIQUE(office_id,client_id,request_id)
);
CREATE TABLE care_plan_month_operations (
 month_id uuid NOT NULL REFERENCES care_plan_months(id), request_id uuid NOT NULL, input_hash text NOT NULL, PRIMARY KEY(month_id,request_id)
);
CREATE TABLE care_plan_month_versions (
 month_id uuid NOT NULL REFERENCES care_plan_months(id), revision_id bigint NOT NULL UNIQUE REFERENCES revisions(id),
 lock_version integer NOT NULL, entries jsonb NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(month_id,lock_version)
);
CREATE FUNCTION guard_care_plan_month() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM care_plans p JOIN care_plan_confirmations c ON c.plan_id=p.id JOIN documents d ON d.id=NEW.document_id
   WHERE p.id=NEW.plan_id AND p.office_id=NEW.office_id AND p.client_id=NEW.client_id AND c.id=NEW.confirmation_id AND c.snapshot_sha256=NEW.source_hash
   AND d.office_id=NEW.office_id AND d.client_id=NEW.client_id AND d.kind='care_plan_6') THEN
  RAISE EXCEPTION 'monthly plan scope mismatch' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.office_id<>OLD.office_id OR NEW.client_id<>OLD.client_id OR NEW.plan_id<>OLD.plan_id OR NEW.confirmation_id<>OLD.confirmation_id OR NEW.source_hash<>OLD.source_hash OR NEW.document_id<>OLD.document_id OR NEW.target_month<>OLD.target_month OR NEW.request_id<>OLD.request_id) THEN
  RAISE EXCEPTION 'monthly plan source is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_plan_month_guard BEFORE INSERT OR UPDATE ON care_plan_months FOR EACH ROW EXECUTE FUNCTION guard_care_plan_month();
CREATE FUNCTION guard_care_plan_month_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'monthly saved version is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM care_plan_months m JOIN revisions r ON r.document_id=m.document_id AND r.office_id=m.office_id WHERE m.id=NEW.month_id AND r.id=NEW.revision_id AND m.lock_version=NEW.lock_version AND m.entries=NEW.entries) THEN
  RAISE EXCEPTION 'monthly saved version scope mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_plan_month_version_guard BEFORE INSERT OR UPDATE OR DELETE ON care_plan_month_versions FOR EACH ROW EXECUTE FUNCTION guard_care_plan_month_version();
