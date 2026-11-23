-- 事業所が直せる項目（#115）。責任者の画面「AI 特訓部屋」のため。
-- 1. 合格の印: 責任者が［合格］にした項目の id。特訓度（見た項目の割合）を、別の PC や別の責任者が開いても続きから出すため。録音の処理は使わない。
ALTER TABLE office_topics ADD COLUMN passed jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2. アセスメントの項目に、画面でまとめる区切り（section）を入れる。課題分析標準項目の「基本情報に関する項目」（9）と「課題分析（アセスメント）に関する項目」（14）。
--    録音の処理は section を使わない（指紋にも入らない）。全体のまとめと日付には入れない
UPDATE form_kinds k SET topics = (
  SELECT jsonb_agg(
    CASE
      WHEN t->>'id' IN ('basic', 'history', 'socialSecurity', 'support', 'independencePhysical', 'independenceDementia', 'wishes', 'certification', 'reason')
        THEN t || '{"section": "基本情報"}'::jsonb
      WHEN t->>'by' = 'ai' AND NOT (t->>'last')::boolean THEN t || '{"section": "課題分析"}'::jsonb
      ELSE t
    END ORDER BY o)
  FROM jsonb_array_elements(k.topics) WITH ORDINALITY AS x(t, o)
)
WHERE k.key = 'assessment';
