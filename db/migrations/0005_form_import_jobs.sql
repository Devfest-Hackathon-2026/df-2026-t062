-- 様式の取り込み（#103）: 上げた PDF の変換を、録音の jobs と同じく期限つきの印（リース）と回数で動かす。足すだけの移行。
-- docs/再設計/13_DB設計.md の form_imports。

-- 上げた PDF が置き場に届いたのを api が確かめた時刻。空の間は変換しない（画面が送っている途中か、送るのをやめた）
ALTER TABLE form_imports ADD COLUMN uploaded_at timestamptz;
-- 変換している worker の印。期限が切れたら、見回りが積み直す
ALTER TABLE form_imports ADD COLUMN lease_until timestamptz;
ALTER TABLE form_imports ADD COLUMN run_token text;
-- 変換を始めた回数（3 回で failed）
ALTER TABLE form_imports ADD COLUMN attempts integer NOT NULL DEFAULT 0;
-- 上げたままの PDF（imports/<id>.pdf）を消した時刻。変換が済めばすぐ消し、失敗したら 7 日おいて見回りが消す
ALTER TABLE form_imports ADD COLUMN upload_deleted_at timestamptz;

-- 見回りが、止まった変換と、消し残した PDF を探す
CREATE INDEX form_imports_pending ON form_imports (status, updated_at) WHERE status IN ('queued', 'processing') OR upload_deleted_at IS NULL;
