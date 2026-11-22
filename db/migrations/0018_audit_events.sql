ALTER TABLE audit_events
  RENAME COLUMN at TO occurred_at;

ALTER TABLE audit_events
  ALTER COLUMN office_id DROP NOT NULL;

ALTER TABLE audit_events
  ADD COLUMN outcome text NOT NULL DEFAULT 'success'
    CHECK (outcome IN ('success', 'denied', 'not_found', 'error')),
  ADD COLUMN request_id uuid,
  ADD COLUMN correlation_id uuid,
  ADD COLUMN trace_id text,
  ADD COLUMN source text NOT NULL DEFAULT 'legacy',
  ADD COLUMN route text,
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1;

CREATE INDEX audit_events_request
  ON audit_events (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX audit_events_correlation
  ON audit_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE TABLE access_audit_events (
  id bigserial PRIMARY KEY,
  office_id uuid NOT NULL REFERENCES offices(id),
  actor_staff_id uuid REFERENCES staff(id),
  client_id uuid REFERENCES clients(id),
  document_id uuid REFERENCES documents(id),
  resource_type text NOT NULL,
  resource_id uuid,
  access_mode text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'not_found', 'error')),
  request_id uuid,
  correlation_id uuid,
  trace_id text,
  source text NOT NULL,
  route text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  result_count integer,
  displayed_client_ids jsonb,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX access_audit_events_client_time
  ON access_audit_events (office_id, client_id, occurred_at DESC)
  WHERE client_id IS NOT NULL;

CREATE INDEX access_audit_events_request
  ON access_audit_events (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX access_audit_events_correlation
  ON access_audit_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE TABLE security_audit_events (
  id bigserial PRIMARY KEY,
  office_id uuid REFERENCES offices(id),
  actor_staff_id uuid REFERENCES staff(id),
  target_staff_id uuid REFERENCES staff(id),
  target_type text,
  target_id uuid,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'not_found', 'error')),
  request_id uuid,
  correlation_id uuid,
  trace_id text,
  source text NOT NULL,
  route text,
  schema_version integer NOT NULL DEFAULT 1,
  reason_code text,
  auth_method text,
  permission text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX security_audit_events_actor_time
  ON security_audit_events (office_id, actor_staff_id, occurred_at DESC);

CREATE INDEX security_audit_events_request
  ON security_audit_events (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX security_audit_events_correlation
  ON security_audit_events (correlation_id)
  WHERE correlation_id IS NOT NULL;
