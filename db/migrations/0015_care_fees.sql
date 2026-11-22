INSERT INTO form_kinds(key,name,per_client,is_primary,create_from,required,topics,summary_mode)
VALUES('care_plan_7','サービス利用票別表 第7表','many',false,'assessment','[]','[]','single') ON CONFLICT(key) DO NOTHING;
CREATE TABLE care_fee_masters(id text PRIMARY KEY,content_sha256 text NOT NULL CHECK(length(content_sha256)=64),body jsonb NOT NULL);
INSERT INTO care_fee_masters(id,content_sha256,body) VALUES('2026-06-home-body1-v1','c7f7d5c044ade132720393544490c1731fd20de70ec7c1d09001177608294c0a','{"attribution":"厚生労働省の告示・通知と公開コード表の限定部分を、当プロジェクトが抽出・加工したもの。厚生労働省の公式算定ソフトではない。原マスター全文は再配布しない。","checkedOn":"2026-11-22","codes":{"111111":{"name":"身体介護1","standardMinutesMaxExclusive":30,"standardMinutesMin":20,"units":244}},"effectiveFrom":"2026-06","id":"2026-06-home-body1-v1","limits":{"要介護1":16765,"要介護2":19705,"要介護3":27048,"要介護4":30938,"要介護5":36217},"priceHundredths":{"1":1140,"2":1112,"3":1105,"4":1084,"5":1070,"6":1042,"7":1021,"other":1000},"scope":"1サービスID・1事業所・1日1回までの身体介護1。加減算・公費・他の月間サービス・認定変更等の個別条件なし。地域区分と標準所要時間は人が確認する。限度額内のみ。","sources":[{"appliesFrom":"2026-06-01","note":"厚労省介護サービスコード表 2026年6月・8月施行版。種類11/項目1111、244単位/回。","page":4,"url":"https://www.wam.go.jp/gyoseiShiryou-files/documents/2026/052008190186/20260522_003.pdf"},{"note":"平成27年告示93号、訪問介護の地域別単価。市町村からの級地推測はしない。","url":"https://www.mhlw.go.jp/web/t_doc?dataId=82ab4582&dataType=0&pageNo=1"},{"appliesFrom":"2019-10-01","note":"平成12年告示33号。要介護1〜5の区分支給限度基準額。","url":"https://www.mhlw.go.jp/web/t_doc?dataId=82aa0267&dataType=0&pageNo=1"},{"amendedOn":"2026-03-31","appliesFrom":"2026-04-01","note":"vol1489。総単位数×単価を切捨て、給付率を乗じて再び切捨て、公費なしの利用者負担は差額。","page":43,"url":"https://www.mhlw.go.jp/content/001684507.pdf"},{"appliesFrom":"2026-06-01","note":"県の自己点検シート。算定は実測時間でなく訪問介護計画の標準時間。複数訪問の合算等は未対応。","url":"https://www.pref.okayama.jp/uploaded/life/1039965_10062572_misc.pdf"}],"termsUrl":"https://www.mhlw.go.jp/chosakuken/index.html","verifiedThrough":"2026-11"}'::jsonb);
CREATE FUNCTION guard_care_fee_master() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fee master is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER care_fee_master_guard BEFORE UPDATE OR DELETE ON care_fee_masters FOR EACH ROW EXECUTE FUNCTION guard_care_fee_master();
CREATE TABLE care_plan_fees(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),office_id uuid NOT NULL REFERENCES offices(id),client_id uuid NOT NULL REFERENCES clients(id),
 month_id uuid NOT NULL REFERENCES care_plan_months(id),basis text NOT NULL CHECK(basis IN ('planned','actual')),document_id uuid NOT NULL UNIQUE REFERENCES documents(id),
 created_by uuid NOT NULL REFERENCES staff(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(month_id,basis)
);
CREATE TABLE care_fee_calculations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),fee_id uuid NOT NULL REFERENCES care_plan_fees(id),office_id uuid NOT NULL REFERENCES offices(id),client_id uuid NOT NULL REFERENCES clients(id),
 source_revision_id bigint NOT NULL REFERENCES revisions(id),document_revision_id bigint NOT NULL UNIQUE REFERENCES revisions(id),source_hash text NOT NULL,
 master_id text NOT NULL REFERENCES care_fee_masters(id),master_hash text NOT NULL,input jsonb NOT NULL,result jsonb NOT NULL CHECK(result->>'status' IN ('calculated','needs_review')),
 request_id uuid NOT NULL,input_hash text NOT NULL,created_by uuid NOT NULL REFERENCES staff(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(office_id,client_id,request_id)
);
CREATE FUNCTION guard_care_fee_group() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'fee group source is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM care_plan_months m JOIN documents d ON d.id=NEW.document_id WHERE m.id=NEW.month_id AND m.office_id=NEW.office_id AND m.client_id=NEW.client_id AND d.office_id=NEW.office_id AND d.client_id=NEW.client_id AND d.kind='care_plan_7') THEN RAISE EXCEPTION 'fee group scope mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_fee_group_guard BEFORE INSERT OR UPDATE OR DELETE ON care_plan_fees FOR EACH ROW EXECUTE FUNCTION guard_care_fee_group();
CREATE FUNCTION guard_care_fee_calculation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'fee calculation is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM care_plan_fees f JOIN care_plan_months m ON m.id=f.month_id JOIN care_plan_month_versions v ON v.month_id=m.id JOIN revisions r6 ON r6.id=v.revision_id JOIN revisions r7 ON r7.document_id=f.document_id JOIN care_fee_masters x ON x.id=NEW.master_id
 WHERE f.id=NEW.fee_id AND f.office_id=NEW.office_id AND f.client_id=NEW.client_id AND r6.id=NEW.source_revision_id AND r7.id=NEW.document_revision_id AND r7.office_id=NEW.office_id AND x.content_sha256=NEW.master_hash) THEN RAISE EXCEPTION 'fee calculation scope mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_fee_calculation_guard BEFORE INSERT OR UPDATE OR DELETE ON care_fee_calculations FOR EACH ROW EXECUTE FUNCTION guard_care_fee_calculation();
