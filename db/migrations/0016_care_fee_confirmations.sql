CREATE TABLE care_fee_confirmations(
 calculation_id uuid PRIMARY KEY REFERENCES care_fee_calculations(id),
 office_id uuid NOT NULL REFERENCES offices(id),client_id uuid NOT NULL REFERENCES clients(id),
 confirmed_by uuid NOT NULL REFERENCES staff(id),confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_care_fee_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'fee confirmation is immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM care_fee_calculations c JOIN staff s ON s.id=NEW.confirmed_by WHERE c.id=NEW.calculation_id AND c.office_id=NEW.office_id AND c.client_id=NEW.client_id AND c.result->>'status'='calculated' AND s.office_id=NEW.office_id AND s.disabled_at IS NULL) THEN RAISE EXCEPTION 'fee confirmation scope mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER care_fee_confirmation_guard BEFORE INSERT OR UPDATE OR DELETE ON care_fee_confirmations FOR EACH ROW EXECUTE FUNCTION guard_care_fee_confirmation();
