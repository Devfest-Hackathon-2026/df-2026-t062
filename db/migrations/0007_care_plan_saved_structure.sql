-- 印字用の射影に含めない stable ID・適用期間も、確定前に保存済みか確かめる。
-- 既存の下書きは一度3表を保存し直してから確定する。
ALTER TABLE care_plans ADD COLUMN saved_structure jsonb;

-- 同じ時刻でも適用期間が違う枠を持てる。期間の重なりは API で検証する。
DROP INDEX care_plan_service_slots_weekly_key;
CREATE UNIQUE INDEX care_plan_service_slots_weekly_key
  ON care_plan_service_slots
    (service_id, weekday, start_time, end_time, ends_next_day,
     coalesce(period_from, '-infinity'::date), coalesce(period_to, 'infinity'::date))
  WHERE schedule_type = 'weekly';
