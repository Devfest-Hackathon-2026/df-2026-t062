-- 再設計（docs/再設計/13_DB設計.md）。書類の種類を行で持つ、事業所の様式の登録、サイト管理者、点検、録音の要約。
-- 足すだけの移行。field_values の document_id を必須にするのは次の 0004（13 の「値の持ち方」の 2 回目）。

-- ---------- 書類の種類 ----------

-- 書類の種類。種類ごとの動きもこの表の列で持つ（コードは種類の名前を知らない）
CREATE TABLE form_kinds (
  key text PRIMARY KEY,
  name text NOT NULL,
  per_client text NOT NULL DEFAULT 'one' CHECK (per_client IN ('one', 'many')),
  -- 主な書類。利用者を作るときに一緒に作り、一覧の氏名・要介護度・入力の進み具合はこの書類から出す
  is_primary boolean NOT NULL DEFAULT false,
  -- 作るときに同じ key の値を写す元の種類
  create_from text REFERENCES form_kinds(key),
  -- 必須の欄の key の配列。要素が配列なら「どれか 1 つに値があればよい」組
  required jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 録音から書くときの「まとめる項目」（docs/再設計/17_録音からの書き込み.md）
  topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary_mode text NOT NULL DEFAULT 'single' CHECK (summary_mode IN ('append', 'single'))
);
CREATE UNIQUE INDEX form_kinds_one_primary ON form_kinds (is_primary) WHERE is_primary;

-- 最初の行は今の 2 種類。アセスメントの項目は、令和5年の改正後の課題分析標準項目 23 項目（番号なし）＋全体のまとめ＋その日の日付
INSERT INTO form_kinds (key, name, per_client, is_primary, create_from, required, topics, summary_mode) VALUES
  ('assessment', 'アセスメント', 'one', true, NULL, $json$["intake.date","intake.method","intake.referralRoute","consulter","person.name","person.sex","person.birthDate","person.age","person.postalCode","person.address","person.lifeHistory","dailySchedule","insurance.careCopayRate","insurance.healthInsuranceType","independence.physical","independence.dementia","complaint.person","cert.status",["cert.careLevel","cert.expectedCareLevel"],"assessment.initialDate","health.history","health.visits","survey.1_1","survey.1_2","survey.1_3","survey.1_4","survey.1_5","survey.1_6","survey.1_7","survey.1_8","survey.1_9","survey.1_10","survey.1_11","survey.1_12","survey.1_13","survey.2_1","survey.2_2","survey.2_3","survey.2_4","survey.2_5","survey.2_6","survey.2_7","survey.2_8","survey.2_9","survey.2_10","survey.2_11","survey.2_12","survey.3_1","survey.3_2","survey.3_3","survey.3_4","survey.3_5","survey.3_6","survey.3_7","survey.3_8","survey.3_9","survey.4_1","survey.4_2","survey.4_3","survey.4_4","survey.4_5","survey.4_6","survey.4_7","survey.4_8","survey.4_9","survey.4_10","survey.4_11","survey.4_12","survey.4_13","survey.4_14","survey.4_15","survey.5_1","survey.5_2","survey.5_3","survey.5_4","survey.5_5","survey.5_6","emergencyContact","family.members","housing.buildingType","housing.roomFloor","housing.toiletStyle","housing.bathAtHome","summary.overall"]$json$::jsonb, $json$[
    {"id": "basic", "name": "基本情報（受付、利用者等基本情報）", "guide": "", "by": "ai", "last": false},
    {"id": "history", "name": "これまでの生活と現在の状況", "guide": "", "by": "ai", "last": false},
    {"id": "socialSecurity", "name": "利用者の社会保障制度の利用情報", "guide": "", "by": "ai", "last": false},
    {"id": "support", "name": "現在利用している支援や社会資源の状況", "guide": "", "by": "ai", "last": false},
    {"id": "independencePhysical", "name": "日常生活自立度（障害）", "guide": "", "by": "ai", "last": false},
    {"id": "independenceDementia", "name": "日常生活自立度（認知症）", "guide": "", "by": "ai", "last": false},
    {"id": "wishes", "name": "主訴・意向", "guide": "", "by": "ai", "last": false},
    {"id": "certification", "name": "認定情報", "guide": "", "by": "ai", "last": false},
    {"id": "reason", "name": "今回のアセスメントの理由", "guide": "", "by": "ai", "last": false},
    {"id": "health", "name": "健康状態", "guide": "", "by": "ai", "last": false},
    {"id": "adl", "name": "ADL", "guide": "", "by": "ai", "last": false},
    {"id": "iadl", "name": "IADL", "guide": "", "by": "ai", "last": false},
    {"id": "cognition", "name": "認知機能や判断能力", "guide": "", "by": "ai", "last": false},
    {"id": "communication", "name": "コミュニケーションにおける理解と表出の状況", "guide": "", "by": "ai", "last": false},
    {"id": "rhythm", "name": "生活リズム", "guide": "1 日のスケジュールも含む", "by": "ai", "last": false},
    {"id": "excretion", "name": "排泄の状況", "guide": "", "by": "ai", "last": false},
    {"id": "hygiene", "name": "清潔の保持に関する状況", "guide": "", "by": "ai", "last": false},
    {"id": "oral", "name": "口腔内の状況", "guide": "", "by": "ai", "last": false},
    {"id": "eating", "name": "食事摂取の状況", "guide": "", "by": "ai", "last": false},
    {"id": "social", "name": "社会との関わり", "guide": "", "by": "ai", "last": false},
    {"id": "family", "name": "家族等の状況", "guide": "", "by": "ai", "last": false},
    {"id": "housing", "name": "居住環境", "guide": "", "by": "ai", "last": false},
    {"id": "other", "name": "その他留意すべき事項・状況", "guide": "", "by": "ai", "last": false},
    {"id": "overall", "name": "全体のまとめ", "guide": "", "by": "ai", "last": true},
    {"id": "date", "name": "その日の日付", "guide": "", "by": "machine", "last": false, "keys": {"first": "assessment.initialDate", "later": "assessment.updateDate"}}
  ]$json$::jsonb, 'append'),
  ('admission', '入院時情報提供書', 'one', false, 'assessment', '[]'::jsonb, '[]'::jsonb, 'single');

ALTER TABLE form_templates DROP CONSTRAINT form_templates_kind_check;
ALTER TABLE form_templates ADD CONSTRAINT form_templates_kind_fkey FOREIGN KEY (kind) REFERENCES form_kinds(key);

ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_fkey FOREIGN KEY (kind) REFERENCES form_kinds(key);
-- 同じ利用者・同じ種類の何通目か。per_client が one の種類は 1 だけ（書類を作る API が守る）
ALTER TABLE documents ADD COLUMN seq integer NOT NULL DEFAULT 1 CHECK (seq > 0);
ALTER TABLE documents DROP CONSTRAINT documents_client_id_kind_key;
ALTER TABLE documents ADD CONSTRAINT documents_client_kind_seq UNIQUE (client_id, kind, seq);

-- ---------- 様式の版: その様式だけの欄、下書きの間は直せる ----------

ALTER TABLE form_template_versions ADD COLUMN local_fields jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 公開した版と退いた版は、中身を書き換えない・消さない。下書きの間は中身を直せて、消せる。
-- 様式・版の番号・元の PDF は下書きでも変えない（別の PDF にするときは上げ直して別の下書きにする）
CREATE OR REPLACE FUNCTION form_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION '公開した様式の版は消せません';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.template_id <> OLD.template_id OR NEW.version <> OLD.version OR NEW.base_pdf_sha256 <> OLD.base_pdf_sha256 THEN
    RAISE EXCEPTION '様式の版の様式・番号・元の PDF は変えられません';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.schemas IS DISTINCT FROM OLD.schemas OR NEW.bindings IS DISTINCT FROM OLD.bindings OR NEW.pages IS DISTINCT FROM OLD.pages
       OR NEW.local_fields IS DISTINCT FROM OLD.local_fields OR NEW.content_sha <> OLD.content_sha) THEN
    RAISE EXCEPTION '様式の版の中身は書き換えられません。新しい版を作ってください';
  END IF;
  IF NOT (NEW.status = OLD.status OR (OLD.status = 'draft' AND NEW.status = 'published') OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION '様式の版の状態は draft → published → retired の順にしか変えられません';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- 書類は下書きの版を指せない（下書きは直せるので、指すと保存した書類の印字が後から変わる）
CREATE FUNCTION documents_no_draft_version() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM form_template_versions WHERE id = NEW.template_version_id AND status = 'draft') THEN
    RAISE EXCEPTION '書類に下書きの様式の版は付けられません';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER documents_no_draft_version BEFORE INSERT OR UPDATE OF template_version_id ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_no_draft_version();

-- 上げた PDF から様式の下書きができるまで
CREATE TABLE form_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 空なら全体の様式（サイト管理者が上げた）
  office_id uuid REFERENCES offices(id),
  kind text NOT NULL REFERENCES form_kinds(key),
  -- matched: 登録済みの全体の様式と同じ用紙だった（下書きは作らない）
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'matched')),
  error_kind text,
  base_pdf_sha256 text,
  -- できた下書き。matched のときは、同じと分かった全体の様式の版
  version_id uuid REFERENCES form_template_versions(id) ON DELETE SET NULL,
  -- 変換が自信のない欄（印字欄の名前と理由）
  review jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES staff(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_imports_office ON form_imports (office_id, created_at DESC);

-- ---------- ユーザー種別 ----------

-- サイト管理者（事業所に属さない）
CREATE TABLE site_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 入っていたら使えない（責任者が職員を止める）
ALTER TABLE staff ADD COLUMN disabled_at timestamptz;

-- ---------- 点検 ----------

-- 点検 1 回。物差し（点検項目）はリポジトリのデータで、DB には名前と指紋だけ持つ
CREATE TABLE inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  check_set text NOT NULL,
  check_set_sha text NOT NULL,
  -- 読んだ書類（id・種類・保存した版の番号・保存していない値も読んだか）
  inputs jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'succeeded', 'partial', 'failed')),
  -- 段ごとの時間・トークン・円（書類の中身は入れない）
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  lease_until timestamptz,
  run_token text,
  attempts integer NOT NULL DEFAULT 0,
  error_kind text,
  created_by uuid REFERENCES staff(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inspections_client ON inspections (office_id, client_id, created_at DESC);

-- 項目ごとの結果と、ケアマネの判断。AI は cm_* を書き換えない
CREATE TABLE inspection_findings (
  inspection_id uuid NOT NULL REFERENCES inspections(id),
  item text NOT NULL,
  office_id uuid NOT NULL REFERENCES offices(id),
  ai_level text CHECK (ai_level IN ('1', '2', '3', '他')),
  ai_reason jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  gap text CHECK (gap IN ('unwritten', 'unheard', 'judgement')),
  proposals jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- この項目が読んだ値と根拠の指紋（同じなら、次の点検に判断を引き継ぐ）
  input_sha text NOT NULL,
  cm_level text CHECK (cm_level IN ('1', '2', '3', '他')),
  cm_note text,
  decided_by uuid REFERENCES staff(id),
  decided_at timestamptz,
  PRIMARY KEY (inspection_id, item)
);

-- ---------- 録音からの書き込み ----------

-- 録音 1 本・項目 1 つの要約。書き換えない（足すだけ）。中身は API で返さない
CREATE TABLE recording_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  recording_id uuid NOT NULL REFERENCES recordings(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  topic text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, topic)
);
CREATE INDEX recording_summaries_document ON recording_summaries (document_id, created_at);

CREATE FUNCTION recording_summaries_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '録音の要約は書き換えられません';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER recording_summaries_guard BEFORE UPDATE ON recording_summaries FOR EACH ROW EXECUTE FUNCTION recording_summaries_guard();

-- 事業所が直した項目。全体の一覧（form_kinds.topics）との差分だけを持つ。行がなければ全体の一覧をそのまま使う
CREATE TABLE office_topics (
  office_id uuid NOT NULL REFERENCES offices(id),
  kind text NOT NULL REFERENCES form_kinds(key),
  -- 足した項目（id・name・guide）
  added jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 全体の項目の説明への書き足し（{"項目の id": "文"}）
  notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES staff(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (office_id, kind)
);

-- ---------- 値を書類ごとに持つ（1 回目） ----------

-- 利用者に 1 つだった基本情報の行（document_id が空）を、その利用者の書類のうち、様式の版がその key を読む書類ごとに写す。
-- 「読む」は、版の対応（bindings）にその key が文字列として出てくるかで見る
INSERT INTO field_values (office_id, client_id, document_id, key, value, ai_value, by, batch_id, cite, updated_at, updated_by)
SELECT f.office_id, f.client_id, d.id, f.key, f.value, f.ai_value, f.by, f.batch_id, f.cite, f.updated_at, f.updated_by
FROM field_values f
JOIN documents d ON d.client_id = f.client_id
JOIN form_template_versions v ON v.id = d.template_version_id
WHERE f.document_id IS NULL
  AND strpos(v.bindings::text, to_jsonb(f.key)::text) > 0
ON CONFLICT ON CONSTRAINT field_values_unique DO NOTHING;
