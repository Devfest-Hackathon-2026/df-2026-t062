-- Migration実行前の読み取り確認。
-- このファイルはSELECTだけを含み、DDL・DML・GRANTは実行しない。

SELECT name, applied_at
FROM public.schema_migrations
ORDER BY name;

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('audit_events', 'recordings', 'schema_migrations')
ORDER BY table_name;

SELECT table_name, column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('audit_events', 'recordings')
ORDER BY table_name, ordinal_position;
