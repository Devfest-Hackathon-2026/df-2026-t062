-- 読取に使った様式の版と、原本の送信の世代。
-- 版が読取後に変わった候補は採用しない（409）。未検証の原本は別の世代の置き場所に送り直す。
ALTER TABLE document_inputs ADD COLUMN template_version_id uuid REFERENCES form_template_versions(id);
ALTER TABLE document_inputs ADD COLUMN upload_generation integer NOT NULL DEFAULT 1 CHECK (upload_generation > 0);

-- 既存候補を作った版は復元できないので NULL のままにする（採用は409）。
-- 同じ原本を選び直すと現在の版で再生成する。未読取はworkerの取得時に版を固定する。
