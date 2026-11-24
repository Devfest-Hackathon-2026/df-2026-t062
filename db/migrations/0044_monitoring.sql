INSERT INTO form_kinds(key,name,per_client,is_primary,create_from,required,topics,summary_mode)
 VALUES('monitoring','モニタリング記録','many',false,'assessment',
 '["monitoring.date","monitoring.goalStatus"]'::jsonb,
 '[{"id":"monitoring","name":"モニタリング","guide":"本人・家族の意向、目標の達成状況、実施サービスや事業所との連絡、心身・生活の変化、医療者への報告を、記録にある事実のみまとめる。未確認の実施・日時・医療判断を補わない。","by":"ai","last":false,"keys":["monitoring.personOpinion","monitoring.familyOpinion","monitoring.goalStatus","monitoring.serviceContacts","monitoring.changes","monitoring.medicalReport"]}]'::jsonb,'single') ON CONFLICT(key) DO NOTHING;
