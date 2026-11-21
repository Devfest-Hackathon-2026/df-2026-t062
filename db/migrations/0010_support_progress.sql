-- 第5表は記録ごとの独立書類。入力・保存・履歴は既存基盤を再利用する。
-- 計画版に固定せず、同日時の記録も documents.id / seq で区別する。
INSERT INTO form_kinds (key, name, per_client, is_primary, create_from, required, topics, summary_mode)
VALUES ('care_plan_5', '居宅介護支援経過 第5表', 'many', false, 'assessment', '[]'::jsonb, '[]'::jsonb, 'single');
