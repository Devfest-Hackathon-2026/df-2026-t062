-- 事業所の責任者が書類の種類を足す（#153、docs/再設計/13_DB設計.md の「事業所にも種類を作らせるときは、form_kinds に office_id の列を足す」）。足すだけの移行。
-- 番号は 0008: 0009 の移行のテスト（document-input-migration）が 0009 の手前で止めて今の見本のデータを入れるため、この列はその前に要る。まだ流していない移行は名前の順に流れるので、すでに 0009 を流した DB にも入る。
-- office_id が空なら全体の種類（サイト管理者が足す）、入っていればその事業所だけの種類。retired_at はやめた日（今ある書類は残り、新しくは作れない）。
ALTER TABLE form_kinds ADD COLUMN office_id uuid REFERENCES offices(id);
ALTER TABLE form_kinds ADD COLUMN retired_at timestamptz;
-- 主な書類（アセスメント）は全体の種類だけ
ALTER TABLE form_kinds ADD CONSTRAINT form_kinds_office_not_primary CHECK (office_id IS NULL OR NOT is_primary);
CREATE INDEX form_kinds_office ON form_kinds (office_id) WHERE office_id IS NOT NULL;
