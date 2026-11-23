-- 既存のサービスIDを維持し、主となる短期目標に加えて他の短期目標でも同じサービスを参照する。
CREATE TABLE care_plan_shared_service_goals (
  plan_id uuid NOT NULL,
  service_id uuid NOT NULL,
  need_id uuid NOT NULL,
  short_goal_id uuid NOT NULL,
  goal_level text NOT NULL DEFAULT 'short' CHECK (goal_level = 'short'),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (short_goal_id, service_id),
  UNIQUE (short_goal_id, ordinal),
  FOREIGN KEY (plan_id, service_id)
    REFERENCES care_plan_services (plan_id, id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id, short_goal_id, need_id, goal_level)
    REFERENCES care_plan_goals (plan_id, id, need_id, level) ON DELETE CASCADE
);
CREATE INDEX care_plan_shared_service_goals_plan_service_idx
  ON care_plan_shared_service_goals (plan_id, service_id);

CREATE TRIGGER care_plan_shared_service_goals_guard BEFORE INSERT OR UPDATE OR DELETE ON care_plan_shared_service_goals
  FOR EACH ROW EXECUTE FUNCTION care_plan_structure_guard();
