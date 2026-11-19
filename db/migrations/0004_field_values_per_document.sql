-- 値を書類ごとに持つ（2 回目。docs/再設計/13_DB設計.md の「値の持ち方」）。
-- 足すだけの移行の例外。0003 で書類ごとに写したので、利用者に 1 つだった行を消し、どの値も書類に属させる。
-- 戻すと前のコードが基本情報を書けなくなるので、戻さない前提で出す（本番はまだ使われていない）。
DELETE FROM field_values WHERE document_id IS NULL;
ALTER TABLE field_values ALTER COLUMN document_id SET NOT NULL;
