import { useCallback, useEffect, useRef, useState } from 'react'
import { DOCUMENT_MIMES, MAX_DOCUMENT_BYTES, type DocumentCandidate, type DocumentInputView, type DocumentMime } from '../../core/document-input.ts'
import { spec } from '../../core/fields.ts'
import { CandidateEditor } from './CandidateEditor.tsx'
import { api, ApiError } from '../lib/api.ts'
import { upload } from '../form/recordingUpload.ts'
import { fieldLabel } from '../components/petAssessment.ts'
import { PetIcon, PetMessage } from '../components/PetVisuals.tsx'
import './DocumentInput.css'

interface Props {
  documentId: string
  clientName: string
  beforeAdopt: () => Promise<boolean>
  onApplied: () => void
}
const show = (value: unknown) => value == null ? '空欄' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const stateLabel = { uploading: '送信待ち', queued: '読み取り待ち', processing: '読み取り中', review: '確認できます', failed: '読み取れませんでした' }
const errors: Record<string, string> = {
  location_not_approved: '書類を処理する地域の確認が必要です。管理者にお問い合わせください。',
  reader_not_configured: '書類読取の設定が必要です。管理者にお問い合わせください。',
  too_many_pages: '30ページ以内の書類を選んでください。',
  invalid_pdf: 'PDFを開けませんでした。パスワードやファイルの破損を確認してください。',
  image_too_large: '画像の解像度を小さくして、選び直してください。',
}

export function DocumentInput({ documentId, clientName, beforeAdopt, onApplied }: Props) {
  const [inputs, setInputs] = useState<DocumentInputView[]>([])
  const [file, setFile] = useState<File>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [percent, setPercent] = useState(0)
  const urls = useRef(new Map<string, string>())
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    const r = await api.documentInputs(documentId)
    if (mounted.current) setInputs(r.inputs)
  }, [documentId])
  useEffect(() => {
    mounted.current = true
    void refresh().catch(() => { if (mounted.current) setError('取り込み一覧を取得できませんでした。') })
    return () => { mounted.current = false; urls.current.forEach((url) => URL.revokeObjectURL(url)) }
  }, [refresh])
  useEffect(() => {
    if (!inputs.some((input) => input.status === 'queued' || input.status === 'processing')) return
    const timer = setTimeout(() => {
      void refresh().catch(() => setError('進み具合を取得できませんでした。書類を開き直してください。'))
    }, 3000)
    return () => clearTimeout(timer)
  }, [inputs, refresh])
  const start = async () => {
    if (!file || busy) return
    setBusy(true); setError(''); setPercent(0)
    try {
      const mime = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : '')
      if (!DOCUMENT_MIMES.includes(mime as DocumentMime) || !file.size || file.size > MAX_DOCUMENT_BYTES) throw new Error('PDF・JPEG・PNGの10 MB以内のファイルを選んでください。')
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('')
      const body = { fileName: file.name, mime: mime as DocumentMime, bytes: file.size, sha256 }
      let session = await api.startDocumentInput(documentId, body)
      if (session.uploadUrl && await upload(session.uploadUrl, file, (n) => { if (mounted.current) setPercent(n) }) === 'expired') {
        session = await api.startDocumentInput(documentId, { ...body, expiredUploadUrl: session.uploadUrl })
        if (session.uploadUrl && await upload(session.uploadUrl, file, setPercent) === 'expired') throw new Error('送信期限が切れました。もう一度お試しください。')
      }
      await api.completeDocumentInput(session.input.id)
      if (mounted.current) { setFile(undefined); await refresh() }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '書類を送信できませんでした。') }
    finally { if (mounted.current) setBusy(false) }
  }
  const original = async (id: string): Promise<string | null> => {
    const cached = urls.current.get(id)
    if (cached) return cached
    try {
      const blob = await api.documentOriginal(id)
      if (!mounted.current) return null
      const url = URL.createObjectURL(blob)
      urls.current.set(id, url)
      return url
    } catch { setError('原本を開けませんでした。'); return null }
  }
  return <div className="assistant-import document-input">
    <PetMessage>書類を一緒に確認しましょう。<br />読み取った候補は、原本と見比べてから採用できます。</PetMessage>
    <label className="assistant-file-picker">
      <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={busy}
        onChange={(e) => { setFile(e.target.files?.[0]); setError(''); e.target.value = '' }} aria-label="取り込む書類を選択" />
      <span><PetIcon name="folder" />ファイルを選択</span>
    </label>
    <p>{file?.name ?? '認定調査票・主治医意見書・退院時情報など'}</p>
    <small>PDF・スキャンPDF・JPEG・PNG／10 MB・30ページまで</small>
    <button type="button" className="assistant-primary" disabled={!file || busy} onClick={() => void start()}>{busy ? `送信中 ${percent}%` : '読み取りを開始'}</button>
    {error && <p role="alert" className="assistant-error">{error}</p>}
    <div aria-live="polite">
      {inputs.map((input) => <InputReview key={input.id} input={input} clientName={clientName}
        original={() => original(input.id)} retry={async () => { await api.retryDocumentInput(input.id); await refresh() }} beforeAdopt={beforeAdopt} onApplied={async () => { await refresh(); onApplied() }} />)}
    </div>
  </div>
}

function InputReview({ input, clientName, original, retry, beforeAdopt, onApplied }: { input: DocumentInputView, clientName: string,
  original: () => Promise<string | null>, retry: () => Promise<void>, beforeAdopt: Props['beforeAdopt'], onApplied: () => Promise<void> }) {
  const [identity, setIdentity] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState('')
  return <details className="document-input-source" open>
    <summary><strong>{input.fileName}</strong><small>{stateLabel[input.status]}</small></summary>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer">原本を表示</a>
      : <button type="button" onClick={async () => setUrl(await original())}>原本を準備</button>}
    {input.status === 'review' && <>
      <label><input type="checkbox" checked={identity} onChange={(e) => setIdentity(e.target.checked)} />原本が{clientName}さんのものだと確認しました</label>
      {input.result?.issues.map((issue, i) => <p key={i} className="document-input-warning">p.{issue.page} 要確認 — {issue.text}</p>)}
      {input.result?.evidence.some((e) => e.uncertain) && <p className="document-input-warning">判読が不確かな箇所があります。候補には使わず、下の原文に残しています。</p>}
      <details><summary>読み取った原文</summary>{input.result?.evidence.map((e) => <blockquote key={e.id}>
        <small>p.{e.page}／記録日 {e.recordedOn ?? '不明'}{e.uncertain ? '／判読要確認' : ''}</small><p>{e.text}</p>
      </blockquote>)}</details>
      {input.result?.candidates.map((candidate) => <CandidateReview key={candidate.key} candidate={candidate} input={input}
        identity={identity} originalUrl={url} beforeAdopt={beforeAdopt} onApplied={onApplied} />)}
      {!input.result?.candidates.length && <p>反映できる候補はありません。原文と原本をご確認ください。</p>}
      {!!input.result?.incompleteFields.length && <p>候補にできなかった項目があります。原本をご確認ください。</p>}
    </>}
    {input.status === 'failed' && <>
      <p role="alert">{errors[input.errorKind ?? ''] ?? '読み取りを完了できませんでした。ファイルをご確認ください。'}</p>
      {['location_not_approved', 'reader_not_configured', 'processing_failed', 'attempts_exhausted'].includes(input.errorKind ?? '') && <button type="button" disabled={retrying} onClick={async () => {
        setRetrying(true); setError('')
        try { await retry() } catch { setError('再実行できませんでした。もう一度お試しください。') }
        finally { setRetrying(false) }
      }}>読み取りを再実行</button>}
      {error && <p role="alert">{error}</p>}
    </>}
  </details>
}
function CandidateReview({ candidate, input, identity, originalUrl, beforeAdopt, onApplied }: { candidate: DocumentCandidate,
  input: DocumentInputView, identity: boolean, originalUrl: string | null, beforeAdopt: Props['beforeAdopt'], onApplied: () => Promise<void> }) {
  const [value, setValue] = useState(candidate.value)
  const field = spec(candidate.key)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const adopted = input.adopted.includes(candidate.key)
  const adopt = async () => {
    if (!identity || busy || adopted) return
    setBusy(true); setError('')
    try {
      if (!await beforeAdopt()) throw new Error('用紙の編集内容を保存してからお試しください。')
      await api.adoptDocumentInput(input.id, [{ key: candidate.key, value, base: candidate.base }])
      await onApplied()
    } catch (e) { setError(e instanceof ApiError && e.status === 409 ? '用紙が変更されています。今の記載と候補を確認し、必要な内容を用紙で編集してください。' : '候補の内容を確認してください。') }
    finally { setBusy(false) }
  }
  return <section className="document-input-candidate">
    <strong>{fieldLabel(candidate.key)}{adopted ? '（採用済み）' : '（未確認）'}</strong>
    <p>読取時の記載 <span className="document-input-value">{show(candidate.base)}</span>
      {candidate.base != null && <small>出典 {candidate.baseSource?.fileName ?? '不明'}／記録日 {candidate.baseSource ? [...new Set(candidate.baseSource.recordedOn.map((date) => date ?? '不明'))].join('・') : '不明'}</small>}
    </p>
    {field && <CandidateEditor field={field} value={adopted ? input.adoptedValues[candidate.key] : value} disabled={busy || adopted} onChange={setValue} />}
    {input.result?.evidence.filter((e) => candidate.cite.includes(e.id)).map((e) => <blockquote key={e.id}>
      <small>{originalUrl ? <a href={`${originalUrl}#page=${e.page}`} target="_blank" rel="noopener noreferrer">原本 p.{e.page}</a> : <>原本 p.{e.page}</>}／記録日 {e.recordedOn ?? '不明'}</small><p>{e.text}</p><small>根拠ID {e.id}</small>
    </blockquote>)}
    <button type="button" disabled={!identity || busy || adopted} onClick={() => void adopt()}>{adopted ? '採用済み' : busy ? '反映中…' : '確認してこの候補を採用'}</button>
    {error && <p role="alert">{error}</p>}
  </section>
}
