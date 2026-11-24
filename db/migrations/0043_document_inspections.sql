-- 点検は開いている書類に固定する。既存の1書類の点検も対象を復元する。
ALTER TABLE inspections ADD COLUMN document_id uuid REFERENCES documents(id);
UPDATE inspections i SET document_id=d.id FROM documents d
 WHERE i.status NOT IN ('queued','processing') AND jsonb_array_length(i.inputs)=1 AND i.inputs->0->>'documentId'=d.id::text
   AND d.client_id=i.client_id AND d.office_id=i.office_id;
ALTER TABLE inspection_findings ADD COLUMN document_id uuid REFERENCES documents(id);
CREATE INDEX inspections_document ON inspections(office_id,document_id,created_at DESC);
CREATE UNIQUE INDEX inspections_document_active ON inspections(document_id,check_set)
 WHERE document_id IS NOT NULL AND status IN ('queued','processing');
