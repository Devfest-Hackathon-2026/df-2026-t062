import { useCallback, useEffect, useRef, useState } from 'react'
import { type DocumentInputView } from '../../core/document-input.ts'
import type { FieldDict } from '../../core/dictionary.ts'
import { subFieldsOf, type FieldSpec } from '../../core/fields.ts'
import { attachDocumentInput } from './attachDocumentInput.ts'
import { api, ApiError } from '../lib/api.ts'
import { fieldLabel } from '../components/petAssessment.ts'
import { PetIcon, PetMessage } from '../components/PetVisuals.tsx'
import './DocumentInput.css'

interface Props {
  documentId: string
  dict: FieldDict
  clientName: string
  beforeAdopt: () => Promise<boolean>
  onApplied: () => void
}
function show(value: unknown, field?: FieldSpec): string {
  if (value == null || value === '') return '空欄'
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ'
  if (field?.type === 'object' || field?.type === 'list') {
    const rows = field.type === 'list' && Array.isArray(value) ? value : [value]
    return rows.map((row, index) => {
      const text = subFieldsOf(field).map((sub) => `${sub.label}：${show((row as Record<string, unknown>)?.[sub.key], sub)}`).join('\n')
      return field.type === 'list' ? `${index + 1}行目\n${text}` : text
    }).join('\n\n') || '空欄'
  }
  if (Array.isArray(value)) return value.map((item) => show(item)).join('、') || '空欄'
  return typeof value === 'object' ? Object.values(value).map((item) => show(item)).join('、') : String(value)
}
const stateLabel = { uploading: '送信待ち', queued: '読み取り待ち', processing: '読み取り中', review: '確認できます', failed: '読み取れませんでした' }
const errors: Record<string, string> = {
  location_not_approved: '書類を処理する地域の確認が必要です。管理者にお問い合わせください。',
  reader_not_configured: '書類読取の設定が必要です。管理者にお問い合わせください。',
  writer_not_configured: '書類の候補生成の設定が必要です。管理者にお問い合わせください。',
  no_topics: 'この書類でまとめる項目の設定が必要です。管理者にお問い合わせください。',
  too_many_pages: '30ページ以内の書類を選んでください。',
  invalid_pdf: 'PDFを開けませんでした。パスワードやファイルの破損を確認してください。',
  image_too_large: '画像の解像度を小さくして、選び直してください。',
}

export function DocumentInput({ documentId, dict, clientName, beforeAdopt, onApplied }: Props) {
  const [inputs, setInputs] = useState<DocumentInputView[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [percent, setPercent] = useState(0)
  const uploading = useRef(false)
  const mounted = useRef(true)
  const refresh = useCallback(async () => {
    const r = await api.documentInputs(documentId)
    if (mounted.current) setInputs(r.inputs)
  }, [documentId])
  useEffect(() => {
    mounted.current = true
    void refresh().catch(() => { if (mounted.current) setError('取り込み一覧を取得できませんでした。') })
    return () => { mounted.current = false }
  }, [refresh])
  useEffect(() => {
    if (!inputs.some((input) => input.status === 'queued' || input.status === 'processing')) return
    const timer = setTimeout(() => {
      void refresh().catch(() => setError('進み具合を取得できませんでした。書類を開き直してください。'))
    }, 3000)
    return () => clearTimeout(timer)
  }, [inputs, refresh])
  const start = async (file: File) => {
    if (uploading.current) return
    uploading.current = true
    setBusy(true); setError(''); setPercent(0)
    try {
      await attachDocumentInput(documentId, file, (n) => { if (mounted.current) setPercent(n) })
      if (mounted.current) await refresh()
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '画像を添付できませんでした。') }
    finally { uploading.current = false; if (mounted.current) setBusy(false) }
  }
  return <div className="assistant-import document-input">
    <PetMessage>画像を添付してください。<br />書類に入れる内容を一緒に確認しましょう。</PetMessage>
    <label className="assistant-file-picker document-input-attach" aria-disabled={busy}>
      <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={busy}
        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void start(file) }} aria-label="入力したい情報の画像を添付" />
      <span><PetIcon name="folder" />{busy ? `添付中 ${percent}%` : '画像・書類を添付'}</span>
      <small>JPEG・PNG・PDF／10 MBまで</small>
    </label>
    {error && <p role="alert" className="assistant-error">{error}</p>}
    <div aria-live="polite">
      {inputs.map((input) => <InputReview key={input.id} dict={dict} input={input} clientName={clientName}
        retry={async () => { await api.retryDocumentInput(input.id); await refresh() }} beforeAdopt={beforeAdopt} onApplied={async () => { await refresh(); onApplied() }} />)}
    </div>
  </div>
}

function InputReview({ input, dict, clientName, retry, beforeAdopt, onApplied }: { input: DocumentInputView, dict: FieldDict, clientName: string,
  retry: () => Promise<void>, beforeAdopt: Props['beforeAdopt'], onApplied: () => Promise<void> }) {
  const [excluded, setExcluded] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const candidates = input.result?.candidates ?? []
  const pending = candidates.filter((c) => !input.adopted.includes(c.key))
  const selected = pending.filter((c) => !excluded.includes(c.key) && !!dict.get(c.key))
  const adopt = async () => {
    if (busy || !selected.length || selected.length > 200) return
    setBusy(true); setError('')
    try {
      if (!await beforeAdopt()) throw new Error('用紙の編集内容を保存してからお試しください。')
      await api.adoptDocumentInput(input.id, selected.map((c) => ({ key: c.key, value: c.value, base: c.base })))
      await onApplied()
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409
        ? '用紙の記載が変わっています。変更された項目の選択を外すか、用紙で内容を確認してください。'
        : e instanceof ApiError ? '反映できませんでした。入力内容を確認して、もう一度お試しください。' : e instanceof Error ? e.message : '反映できませんでした。')
    } finally { setBusy(false) }
  }
  return <section className="document-input-source" aria-label={input.fileName}>
    <header><PetIcon name="file-earmark-arrow-down" /><div><strong>{input.fileName}</strong><small>{stateLabel[input.status]}</small></div></header>
    {input.status === 'review' && <>
      {pending.length > 0 && <p className="document-input-guidance">AIの判定を確認し、反映する項目だけにチェックを付けてください。</p>}
      {candidates.map((candidate) => {
        const field = dict.get(candidate.key)
        const adopted = input.adopted.includes(candidate.key)
        const label = field?.label ?? fieldLabel(candidate.key)
        return <div key={candidate.key} className="document-input-candidate">
          {adopted ? <strong className="document-input-done"><PetIcon name="check2" />{label} · 反映済み</strong> :
            <label className="document-input-choice"><input type="checkbox" aria-label={`${label}を反映`} checked={!excluded.includes(candidate.key) && !!field} disabled={busy || !field}
              onChange={(e) => setExcluded((keys) => e.target.checked ? keys.filter((key) => key !== candidate.key) : [...keys, candidate.key])} />{label}</label>}
          {candidate.base != null && !adopted && <p className="document-input-current">現在の記載：{show(candidate.base, field)}</p>}
          <p className="document-input-value"><small>{adopted ? '反映した内容' : 'AIの判定'}</small>{show(adopted ? input.adoptedValues[candidate.key] : candidate.value, field)}</p>
        </div>
      })}
      {!!input.result?.issues.length && <details className="document-input-warnings"><summary>読み取りにくかった箇所（{input.result.issues.length}件）</summary>
        {input.result.issues.map((issue, i) => <p key={i}>{issue.text}</p>)}</details>}
      {(input.result?.incompleteFields.length || input.result?.evidence.some((e) => e.uncertain)) ? <p className="document-input-warning">読み取れない項目は反映しません。必要に応じて、はっきり写った画像を追加してください。</p> : null}
      {!candidates.length && <p>反映できる内容が見つかりませんでした。入力したい情報が写った画像を添付してください。</p>}
      {pending.length > 0 && <footer>
        <p>{clientName}さんの、開いている書類に反映します。</p>
        <button type="button" className="assistant-primary" disabled={busy || !selected.length || selected.length > 200} onClick={() => void adopt()}>{busy ? '反映中…' : `選んだ${selected.length}項目を反映`}</button>
        {selected.length > 200 && <p role="alert">一度に反映できるのは200項目です。項目の選択を減らしてください。</p>}
      </footer>}
      {!!candidates.length && !pending.length && <p className="document-input-done" role="status">書類に反映しました。</p>}
    </>}
    {input.status === 'failed' && <>
      <p role="alert">{errors[input.errorKind ?? ''] ?? '読み取れませんでした。はっきり写った画像で、もう一度お試しください。'}</p>
      {['location_not_approved', 'reader_not_configured', 'writer_not_configured', 'no_topics', 'processing_failed', 'attempts_exhausted'].includes(input.errorKind ?? '') && <button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { await retry() } catch { setError('再実行できませんでした。もう一度お試しください。') }
        finally { setBusy(false) }
      }}>もう一度読み取る</button>}
    </>}
    {error && <p role="alert" className="assistant-error">{error}</p>}
  </section>
}
