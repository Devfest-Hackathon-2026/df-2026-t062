-- 書類を作るときに AI が書く（#195）。ケアマネが「AI に書いてもらう」を押すたびに 1 行。
-- 元の書類（create_from の種類の書類）の値を読み、新しい書類の欄を書き直す・空の欄を書く。値は applyBatch で書類に入れる（書き込みの記録は fill）。
-- 状態は queued → processing → succeeded／partial／failed。step は画面に出す段（read: 元の書類を読む・write: 欄に書く・check: 書いた中身を確かめる）
CREATE TABLE document_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid NOT NULL REFERENCES offices(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  source_document_id uuid NOT NULL REFERENCES documents(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'succeeded', 'partial', 'failed')),
  step text NOT NULL DEFAULT 'read' CHECK (step IN ('read', 'write', 'check', 'done')),
  -- 段ごとの数・トークン・円（書類の中身は入れない）
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  batch_id uuid REFERENCES batches(id),
  lease_until timestamptz,
  run_token text,
  attempts integer NOT NULL DEFAULT 0,
  error_kind text,
  created_by uuid REFERENCES staff(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_fills_document ON document_fills (document_id, created_at DESC);
-- 同じ書類で、待っているか動いている仕事は 1 つだけ
CREATE UNIQUE INDEX document_fills_active ON document_fills (document_id) WHERE status IN ('queued', 'processing');

ALTER TABLE batches DROP CONSTRAINT batches_kind_check;
ALTER TABLE batches ADD CONSTRAINT batches_kind_check CHECK (kind IN ('recording', 'copy', 'seed', 'fill'));
