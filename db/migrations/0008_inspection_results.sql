-- AI 点検の表を、決まった画面に合わせる（#113・#134。docs/再設計/13_DB設計.md の「点検」）。
-- 点検が出すのは書類の評価と項目ごとの結果だけ。根拠・直しの案・ケアマネの判断とその引き継ぎは作らない（2026-11-20）。
-- 0003 で作った表には、まだ行がない（点検は今回はじめて動く）。

-- 読んだ値の指紋。今の値の指紋と比べて、この点検のあとに書類の値が変わったかを出す
ALTER TABLE inspections ADD COLUMN inputs_sha text NOT NULL DEFAULT '';
ALTER TABLE inspections ALTER COLUMN inputs_sha DROP DEFAULT;

-- 段階が 1 のときの、何が足りないか（ケアマネに分かる短い言葉）。ほかの段階では空
ALTER TABLE inspection_findings ADD COLUMN missing text;
-- 画面で項目を押したときに移る欄（物差しの keys のうち、その書類の版にある最初の欄）。空は「用紙に欄なし」
ALTER TABLE inspection_findings ADD COLUMN field_key text;

ALTER TABLE inspection_findings
  DROP COLUMN evidence,
  DROP COLUMN gap,
  DROP COLUMN proposals,
  DROP COLUMN input_sha,
  DROP COLUMN cm_level,
  DROP COLUMN cm_note,
  DROP COLUMN decided_by,
  DROP COLUMN decided_at;
