import { DOCUMENT_MIMES, MAX_DOCUMENT_BYTES, type DocumentMime } from '../../../core/document-input.ts'
import { api } from '../../lib/api.ts'
import { upload } from '../../lib/upload.ts'

/** 添付元のUIに依存しない取込処理。相談画面からも同じ処理を利用できる。 */
export async function attachDocumentInput(documentId: string, file: File, progress: (percent: number) => void) {
  const mime = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : '')
  if (!DOCUMENT_MIMES.includes(mime as DocumentMime) || !file.size || file.size > MAX_DOCUMENT_BYTES) throw new Error('JPEG・PNG・PDFの10 MB以内のファイルを選んでください。')
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const body = { fileName: file.name, mime: mime as DocumentMime, bytes: file.size, sha256 }
  let session = await api.startDocumentInput(documentId, body)
  if (session.uploadUrl && await upload(session.uploadUrl, file, progress) === 'expired') {
    session = await api.startDocumentInput(documentId, { ...body, expiredUploadUrl: session.uploadUrl })
    if (session.uploadUrl && await upload(session.uploadUrl, file, progress) === 'expired') throw new Error('送信期限が切れました。もう一度お試しください。')
  }
  await api.completeDocumentInput(session.input.id)
}
