-- ケアプラン（#90）。計画版・第1〜3表の書類・第2表のニーズ/目標/サービス・第3表の曜日時刻・AI 原案・確定スナップショット。
-- 仕様: docs/ケアプラン仕様.md。値そのものは documents ごとの field_values に持ち、この移行では計画版の構造と履歴だけを足す。
-- 足すだけの移行。既存の assessment / admission の動きは変えない。

-- ---------- 書類の種類 ----------

-- 第1〜3表は別の種類にする。第1表だけアセスメントから同じ key を一度写す。
INSERT INTO form_kinds (key, name, per_client, is_primary, create_from, required, topics, summary_mode) VALUES
  ('care_plan_1', '居宅サービス計画書 第1表', 'many', false, 'assessment', '[]'::jsonb, '[]'::jsonb, 'single'),
  ('care_plan_2', '居宅サービス計画書 第2表', 'many', false, NULL, '[]'::jsonb, '[]'::jsonb, 'single'),
  ('care_plan_3', '週間サービス計画表 第3表', 'many', false, NULL, '[]'::jsonb, '[]'::jsonb, 'single');

-- ---------- 計画版 ----------

CREATE TABLE care_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  -- 同じ計画の版をまとめる ID。最初の版で作り、改定版も同じ値にする
  plan_series_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'superseded')),
  effective_from date NOT NULL,
  effective_to date,
  previous_plan_id uuid REFERENCES care_plans(id),
  created_by uuid REFERENCES staff(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES staff(id),
  -- 計画版の構造を変えるたびに 1 増やす（API の baseVersion）
  lock_version integer NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  CONSTRAINT care_plans_series_version_key UNIQUE (client_id, plan_series_id, version),
  CONSTRAINT care_plans_period_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT care_plans_previous_not_self CHECK (previous_plan_id IS NULL OR previous_plan_id <> id)
);
CREATE INDEX care_plans_office_client ON care_plans (office_id, client_id, created_at DESC);
-- 同じ利用者で確定している計画版は 1 つだけ
CREATE UNIQUE INDEX care_plans_one_confirmed ON care_plans (client_id) WHERE status = 'confirmed';

-- 状態は draft → confirmed → superseded の順だけ。確定した計画版は消さない。
CREATE FUNCTION care_plans_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION '確定した計画版は履歴として残すため削除できません';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status = 'confirmed')
         OR (OLD.status = 'confirmed' AND NEW.status = 'superseded')) THEN
      RAISE EXCEPTION '計画版の状態は draft → confirmed → superseded の順にしか変えられません';
    END IF;
  END IF;
  IF NEW.status IN ('confirmed', 'superseded') AND (NEW.confirmed_at IS NULL OR NEW.confirmed_by IS NULL) THEN
    RAISE EXCEPTION '確定した計画版には confirmed_at と confirmed_by が必要です';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' AND NEW.status = OLD.status THEN
    IF NEW.office_id IS DISTINCT FROM OLD.office_id
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.plan_series_id IS DISTINCT FROM OLD.plan_series_id
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
       OR NEW.previous_plan_id IS DISTINCT FROM OLD.previous_plan_id THEN
      RAISE EXCEPTION '確定した計画版の適用期間・版は変えられません';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER care_plans_guard BEFORE INSERT OR UPDATE OR DELETE ON care_plans
  FOR EACH ROW EXECUTE FUNCTION care_plans_guard();

-- ---------- 第1〜3表の書類 ----------

CREATE TABLE care_plan_documents (
  plan_id uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  form_no smallint NOT NULL CHECK (form_no BETWEEN 1 AND 3),
  document_id uuid NOT NULL REFERENCES documents(id),
  PRIMARY KEY (plan_id, form_no),
  UNIQUE (document_id)
);

-- 書類の種類・事業所・利用者が計画版と一致すること。1つの書類は1つの計画版だけに属すること。
CREATE FUNCTION care_plan_documents_guard() RETURNS trigger AS $$
DECLARE
  p care_plans%ROWTYPE;
  d documents%ROWTYPE;
BEGIN
  IF EXISTS (
    SELECT 1 FROM care_plan_documents
    WHERE document_id = NEW.document_id AND NOT (plan_id = NEW.plan_id AND form_no = NEW.form_no)
  ) THEN
    RAISE EXCEPTION '同じ書類を複数の計画版・表に結び付けられません（一意）';
  END IF;
  SELECT * INTO p FROM care_plans WHERE id = NEW.plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '計画版がありません';
  END IF;
  SELECT * INTO d FROM documents WHERE id = NEW.document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '書類がありません';
  END IF;
  IF d.kind <> 'care_plan_' || NEW.form_no::text THEN
    RAISE EXCEPTION '書類の種類 % は第%表に結び付けられません', d.kind, NEW.form_no;
  END IF;
  IF d.office_id <> p.office_id OR d.client_id <> p.client_id THEN
    RAISE EXCEPTION '書類の事業所・利用者が計画版と一致しません';
  END IF;
  IF p.status <> 'draft' THEN
    RAISE EXCEPTION '確定した計画版の書類は変えられません';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER care_plan_documents_guard BEFORE INSERT OR UPDATE ON care_plan_documents
  FOR EACH ROW EXECUTE FUNCTION care_plan_documents_guard();

-- ---------- 計画版の構造（第2表・第3表）----------

CREATE TABLE care_plan_needs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  need_text text NOT NULL CHECK (btrim(need_text) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 複合外部キーの参照先（同じ計画版の中だけで結び付ける）
  UNIQUE (plan_id, id),
  -- 並べ替えを 1 トランザクションでできるように遅延可能にする
  CONSTRAINT care_plan_needs_ordinal_key UNIQUE (plan_id, ordinal) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE care_plan_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  need_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('long', 'short')),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  goal_text text NOT NULL CHECK (btrim(goal_text) <> ''),
  period_text text,
  period_from date,
  period_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_plan_goals_period_check CHECK (period_from IS NULL OR period_to IS NULL OR period_to >= period_from),
  CONSTRAINT care_plan_goals_need_fkey FOREIGN KEY (plan_id, need_id) REFERENCES care_plan_needs (plan_id, id) ON DELETE CASCADE,
  CONSTRAINT care_plan_goals_ordinal_key UNIQUE (need_id, level, ordinal) DEFERRABLE INITIALLY DEFERRED,
  -- サービスから「同じ計画版・同じニーズの短期目標」だけを指せるようにする
  UNIQUE (plan_id, id, need_id, level)
);
-- 1つのニーズに長期目標は 1 つだけ
CREATE UNIQUE INDEX care_plan_goals_one_long ON care_plan_goals (need_id) WHERE level = 'long';

CREATE TABLE care_plan_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  need_id uuid NOT NULL,
  short_goal_id uuid NOT NULL,
  -- 常に short。複合外部キーで短期目標だけを指すために持つ
  goal_level text NOT NULL DEFAULT 'short' CHECK (goal_level = 'short'),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  content text NOT NULL CHECK (btrim(content) <> ''),
  insured boolean NOT NULL DEFAULT true,
  service_kind text,
  provider text,
  frequency_text text,
  period_text text,
  period_from date,
  period_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_plan_services_period_check CHECK (period_from IS NULL OR period_to IS NULL OR period_to >= period_from),
  CONSTRAINT care_plan_services_goal_fkey
    FOREIGN KEY (plan_id, short_goal_id, need_id, goal_level)
    REFERENCES care_plan_goals (plan_id, id, need_id, level) ON DELETE CASCADE,
  CONSTRAINT care_plan_services_ordinal_key UNIQUE (short_goal_id, ordinal) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (plan_id, id)
);

CREATE TABLE care_plan_service_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  schedule_type text NOT NULL CHECK (schedule_type IN ('weekly', 'other')),
  -- 1=月曜〜7=日曜（ISO-8601）
  weekday smallint,
  start_time time,
  end_time time,
  ends_next_day boolean NOT NULL DEFAULT false,
  note text,
  period_from date,
  period_to date,
  ordinal integer NOT NULL DEFAULT 1 CHECK (ordinal > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_plan_service_slots_period_check CHECK (period_from IS NULL OR period_to IS NULL OR period_to >= period_from),
  CONSTRAINT care_plan_service_slots_service_fkey
    FOREIGN KEY (plan_id, service_id) REFERENCES care_plan_services (plan_id, id) ON DELETE CASCADE,
  CONSTRAINT care_plan_service_slots_time_check CHECK (
    (schedule_type = 'weekly'
      AND weekday BETWEEN 1 AND 7
      AND start_time IS NOT NULL
      AND end_time IS NOT NULL
      AND ((NOT ends_next_day AND start_time < end_time)
        OR (ends_next_day AND end_time < start_time)))
    OR
    (schedule_type = 'other'
      AND weekday IS NULL
      AND start_time IS NULL
      AND end_time IS NULL
      AND NOT ends_next_day
      AND note IS NOT NULL
      AND btrim(note) <> '')
  )
);
-- 同じサービス・曜日・開始・終了・翌日フラグの週単位の枠は重ねない。
-- 週単位以外は note が違えば複数持てるので、一意制約の対象にしない。
CREATE UNIQUE INDEX care_plan_service_slots_weekly_key
  ON care_plan_service_slots (service_id, weekday, start_time, end_time, ends_next_day)
  WHERE schedule_type = 'weekly';

-- 確定した計画版の構造は変えられない（訂正は新しい計画版で行う）。
-- 計画版そのものを消すときの連鎖削除は通す（計画版の行が無いときは許可する）。
CREATE FUNCTION care_plan_is_editable(p_plan uuid) RETURNS boolean AS $$
  SELECT NOT EXISTS (SELECT 1 FROM care_plans WHERE id = p_plan AND status <> 'draft')
$$ LANGUAGE sql STABLE;

CREATE FUNCTION care_plan_structure_guard() RETURNS trigger AS $$
DECLARE
  p_plan uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    p_plan := OLD.plan_id;
  ELSE
    p_plan := NEW.plan_id;
  END IF;
  IF NOT care_plan_is_editable(p_plan) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '確定した計画版の行は削除できません';
    END IF;
    RAISE EXCEPTION '確定した計画版は編集できません。訂正は新しい計画版で行います';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER care_plan_needs_guard BEFORE INSERT OR UPDATE OR DELETE ON care_plan_needs
  FOR EACH ROW EXECUTE FUNCTION care_plan_structure_guard();
CREATE TRIGGER care_plan_goals_guard BEFORE INSERT OR UPDATE OR DELETE ON care_plan_goals
  FOR EACH ROW EXECUTE FUNCTION care_plan_structure_guard();
CREATE TRIGGER care_plan_services_guard BEFORE INSERT OR UPDATE OR DELETE ON care_plan_services
  FOR EACH ROW EXECUTE FUNCTION care_plan_structure_guard();
CREATE TRIGGER care_plan_service_slots_guard BEFORE INSERT OR UPDATE OR DELETE ON care_plan_service_slots
  FOR EACH ROW EXECUTE FUNCTION care_plan_structure_guard();

-- 確定した計画版の第1表の値も変えられない。
CREATE FUNCTION care_plan_values_guard() RETURNS trigger AS $$
DECLARE
  v_document uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_document := OLD.document_id;
  ELSE
    v_document := NEW.document_id;
  END IF;
  IF NOT care_plan_is_editable((SELECT plan_id FROM care_plan_documents WHERE document_id = v_document)) THEN
    RAISE EXCEPTION '確定した計画版の値は編集できません';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER field_values_care_plan_guard BEFORE INSERT OR UPDATE OR DELETE ON field_values
  FOR EACH ROW EXECUTE FUNCTION care_plan_values_guard();

-- ---------- AI 原案 ----------

CREATE TABLE care_plan_ai_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  plan_id uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  -- 参照したアセスメントの書類と保存版
  source_document_id uuid NOT NULL REFERENCES documents(id),
  source_revision_id bigint NOT NULL REFERENCES revisions(id),
  source_revision_rev integer NOT NULL,
  source_form_version_id uuid NOT NULL REFERENCES form_template_versions(id),
  source_saved_at timestamptz NOT NULL,
  referenced_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'partially_applied', 'rejected', 'failed')),
  model text,
  prompt_version text,
  proposal jsonb NOT NULL,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  applied jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_kind text,
  created_by uuid REFERENCES staff(id),
  applied_by uuid REFERENCES staff(id),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX care_plan_ai_drafts_plan ON care_plan_ai_drafts (plan_id, created_at DESC);

-- 参照元が保存版と一致すること。原案は下書きの計画版にだけ作り、参照元は同じ事業所・利用者のアセスメント。
CREATE FUNCTION care_plan_ai_drafts_guard() RETURNS trigger AS $$
DECLARE
  r revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM revisions WHERE id = NEW.source_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI 原案の参照元の版番号の保存版がありません';
  END IF;
  IF r.document_id <> NEW.source_document_id THEN
    RAISE EXCEPTION 'AI 原案の参照元の書類が保存版と一致しません';
  END IF;
  IF r.rev <> NEW.source_revision_rev THEN
    RAISE EXCEPTION 'AI 原案の参照元の版番号が保存版と一致しません';
  END IF;
  IF r.office_id <> NEW.office_id THEN
    RAISE EXCEPTION 'AI 原案の参照元の事業所が一致しません';
  END IF;
  IF r.template_version_id <> NEW.source_form_version_id OR r.saved_at <> NEW.source_saved_at THEN
    RAISE EXCEPTION 'AI 原案の参照元の様式の版・保存時刻が保存版と一致しません';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM care_plans p
    JOIN documents d ON d.id = NEW.source_document_id
    WHERE p.id = NEW.plan_id
      AND p.office_id = NEW.office_id AND p.client_id = NEW.client_id
      AND p.status = 'draft'
      AND d.office_id = NEW.office_id AND d.client_id = NEW.client_id
      AND d.kind = 'assessment'
  ) THEN
    RAISE EXCEPTION 'AI 原案の計画版・参照元の書類が事業所・利用者と一致しません（下書きの計画版だけ）';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER care_plan_ai_drafts_guard BEFORE INSERT ON care_plan_ai_drafts
  FOR EACH ROW EXECUTE FUNCTION care_plan_ai_drafts_guard();

-- ---------- 確定スナップショット ----------

CREATE TABLE care_plan_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL UNIQUE REFERENCES care_plans(id),
  document_1_id uuid NOT NULL REFERENCES documents(id),
  document_1_revision_id bigint NOT NULL REFERENCES revisions(id),
  document_2_id uuid NOT NULL REFERENCES documents(id),
  document_2_revision_id bigint NOT NULL REFERENCES revisions(id),
  document_3_id uuid NOT NULL REFERENCES documents(id),
  document_3_revision_id bigint NOT NULL REFERENCES revisions(id),
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  confirmed_by uuid NOT NULL REFERENCES staff(id),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

-- 確定スナップショットは書き換え・削除できない。書類と保存版が計画版の表と一致すること。
CREATE FUNCTION care_plan_confirmations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '確定スナップショットは書き換えられません';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '確定スナップショットは削除できません';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM care_plans WHERE id = NEW.plan_id AND status IN ('confirmed', 'superseded')) THEN
    RAISE EXCEPTION '確定スナップショットは確定した計画版にだけ作れます';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM care_plan_documents WHERE plan_id = NEW.plan_id AND form_no = 1 AND document_id = NEW.document_1_id)
     OR NOT EXISTS (SELECT 1 FROM care_plan_documents WHERE plan_id = NEW.plan_id AND form_no = 2 AND document_id = NEW.document_2_id)
     OR NOT EXISTS (SELECT 1 FROM care_plan_documents WHERE plan_id = NEW.plan_id AND form_no = 3 AND document_id = NEW.document_3_id) THEN
    RAISE EXCEPTION '確定スナップショットの書類が計画版の第1〜3表と一致しません';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM revisions WHERE id = NEW.document_1_revision_id AND document_id = NEW.document_1_id)
     OR NOT EXISTS (SELECT 1 FROM revisions WHERE id = NEW.document_2_revision_id AND document_id = NEW.document_2_id)
     OR NOT EXISTS (SELECT 1 FROM revisions WHERE id = NEW.document_3_revision_id AND document_id = NEW.document_3_id) THEN
    RAISE EXCEPTION '確定スナップショットの保存版が書類と一致しません';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER care_plan_confirmations_guard BEFORE INSERT OR UPDATE OR DELETE ON care_plan_confirmations
  FOR EACH ROW EXECUTE FUNCTION care_plan_confirmations_guard();
