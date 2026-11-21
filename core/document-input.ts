import type { Visit, Usage } from '../worker/types.ts'

export const DOCUMENT_MIMES = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type DocumentMime = typeof DOCUMENT_MIMES[number]
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_DOCUMENT_PAGES = 30

/** 原本と照合するための記録。id は取込をまたいで重ならない。領域は画像の左上からの割合。 */
export interface DocumentEvidence {
  id: string
  page: number
  text: string
  recordedOn: string | null
  region: [number, number, number, number] | null
  uncertain: boolean
}
export interface DocumentCandidate {
  key: string
  value: unknown
  base: unknown
  baseSource?: { fileName: string, recordedOn: (string | null)[], inputId?: string } | null
  cite: string[]
}
export interface DocumentReadResult {
  visit: Visit
  evidence: DocumentEvidence[]
  issues: { page: number, text: string, labels?: string[] }[]
}
export interface DocumentInputResult extends DocumentReadResult {
  candidates: DocumentCandidate[]
  incompleteFields: string[]
  usage: Usage
}
export interface DocumentInputView {
  id: string
  fileName: string
  mime: DocumentMime
  sha256: string
  status: 'uploading' | 'queued' | 'processing' | 'review' | 'failed'
  errorKind: string | null
  createdAt: string
  result: DocumentInputResult | null
  adopted: string[]
  adoptedValues: Record<string, unknown>
}
export interface DocumentSource {
  kind: 'document-input'
  inputId: string
  fileName: string
  sha256: string
  evidence: DocumentEvidence[]
}
/** 原本の置き場所。未検証の送信をやり直すときは世代を上げ、前の送信と混ざらないようにする。 */
export const documentInputPath = (officeId: string, clientId: string, id: string, generation = 1) =>
  `document-inputs/${officeId}/${clientId}/${id}/${generation > 1 ? `original-${generation}` : 'original'}`

export class DocumentReadError extends Error {
  readonly kind: string
  constructor(kind: string) { super(kind); this.kind = kind }
}

export function checkDocumentSignature(data: Uint8Array, mime: DocumentMime) {
  if (!data.length || data.length > MAX_DOCUMENT_BYTES) throw new DocumentReadError('too_large')
  const signatures = { 'application/pdf': [37, 80, 68, 70, 45], 'image/png': [137, 80, 78, 71, 13, 10, 26, 10], 'image/jpeg': [255, 216, 255] }
  if (!signatures[mime].every((byte, i) => data[i] === byte)) throw new DocumentReadError('invalid_file')
}
