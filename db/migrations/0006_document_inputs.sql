-- 記入済み原本。白紙の form_imports と分離し、対象書類にだけつなぐ。
CREATE TABLE document_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  created_by uuid NOT NULL REFERENCES staff(id),
  file_name text NOT NULL,
  mime text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer NOT NULL CHECK (bytes > 0 AND bytes <= 10485760),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','queued','processing','review','failed')),
  upload_url text,
  pages jsonb NOT NULL DEFAULT '{}',
  read_usage jsonb NOT NULL DEFAULT '{"calls":0,"promptTokens":0,"cachedTokens":0,"outputTokens":0,"thinkingTokens":0,"yen":0}',
  result jsonb,
  adopted jsonb NOT NULL DEFAULT '[]',
  adopted_values jsonb NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  run_token text,
  lease_until timestamptz,
  error_kind text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, sha256)
);
CREATE INDEX document_inputs_pending ON document_inputs (status, updated_at) WHERE status IN ('queued','processing');
CREATE INDEX document_inputs_document ON document_inputs (office_id, document_id, created_at);
