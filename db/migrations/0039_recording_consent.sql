CREATE TABLE recording_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  event_type text NOT NULL CHECK (event_type IN ('granted', 'withdrawn')),
  scope text NOT NULL CHECK (scope = 'recording_and_ai_processing'),
  policy_version text NOT NULL,
  method text NOT NULL CHECK (method = 'staff_confirmed'),
  actor_staff_id uuid NOT NULL REFERENCES staff(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recording_consent_events_client_latest_idx
  ON recording_consent_events (office_id, client_id, occurred_at DESC, id DESC);

ALTER TABLE recordings
  ADD COLUMN consent_event_id uuid REFERENCES recording_consent_events(id);

CREATE INDEX recordings_consent_event_idx ON recordings (consent_event_id);
