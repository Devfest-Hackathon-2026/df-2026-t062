import { useCallback, useEffect, useRef, useState } from 'react'
import { type DocumentInputView } from '../../../core/document-input.ts'
import type { FieldDict } from '../../../core/dictionary.ts'
import { ProposalDiff } from '../document/ProposalDiff.tsx'
import { attachDocumentInput } from './attachDocumentInput.ts'
import { api, ApiError } from '../../lib/api.ts'
import { fieldLabel } from '../document/fields.ts'
import { PetIcon, PetMessage } from '../pet/PetVisuals.tsx'
import './DocumentInput.css'

interface Props {
  documentId: string
  dict: FieldDict
  clientName: string
  beforeAdopt: () => Promise<boolean>
  onApplied: () => void
  source: ReturnType<typeof useDocumentInputs>
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

export function useDocumentInputs(documentId: string | undefined) {
  const [loaded, setLoaded] = useState<{ documentId: string, inputs: DocumentInputView[] }>()
  const [failure, setFailure] = useState<{ documentId: string, message: string }>()
  const inputs = loaded?.documentId === documentId ? loaded?.inputs : undefined
  const error = failure?.documentId === documentId ? failure?.message : undefined
  const activeDocument = useRef(documentId)
  const request = useRef(0)
  activeDocument.current = documentId

  const refresh = useCallback(async () => {
    if (!documentId || activeDocument.current !== documentId) return
    const sequence = ++request.current
    try {
      const result = await api.documentInputs(documentId)
      if (sequence === request.current && activeDocument.current === documentId) {
        setLoaded({ documentId, inputs: result.inputs })
        setFailure(undefined)
      }
    } catch {
      if (sequence === request.current && activeDocument.current === documentId) {
        setFailure({ documentId, message: '取り込み状況を取得できませんでした。' })
      }
    }
  }, [documentId])

  useEffect(() => {
    void refresh()
    return () => { request.current++ }
  }, [refresh])

  const processing = !!inputs?.some(({ status }) => status === 'queued' || status === 'processing')
  useEffect(() => {
    if (!processing) return
    let cancelled = false
    const poll = async () => {
      await refresh()
      if (!cancelled) timer = setTimeout(poll, 3000)
    }
    let timer = setTimeout(poll, 3000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [processing, refresh])

  return { inputs, error, refresh }
}

export function DocumentInput({ documentId, dict, clientName, beforeAdopt, onApplied, source }: Props) {
  const { inputs, error: loadError, refresh } = source
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [percent, setPercent] = useState(0)
  const uploading = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const start = async (file: File) => {
    if (uploading.current) return
    uploading.current = true
    setBusy(true); setError(''); setPercent(0)
    try {
      await attachDocumentInput(documentId, file, (n) => { if (mounted.current) setPercent(n) })
      await refresh()
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '画像を添付できませんでした。') }
    finally { uploading.current = false; if (mounted.current) setBusy(false) }
  }
  const reading = inputs?.some(({ status }) => status === 'queued' || status === 'processing')
  const latest = inputs?.[0]
  const pendingCount = latest?.result?.candidates.filter(({ key }) => !latest.adopted.includes(key)).length ?? 0
  return <div className="assistant-import document-input">
    <div aria-live="polite"><PetMessage>{busy ? '書類を送っています。'
      : reading ? '書類を読み取っています。用紙の作業を続けられます。'
      : latest?.status === 'failed' ? '書類を読み取れませんでした。下の詳細を確認してください。'
      : pendingCount ? `読み取った内容に、確認できる項目が${pendingCount}件あります。`
      : latest?.status === 'review' && !latest.result?.candidates.length ? 'この書類から反映できる内容が見つかりませんでした。'
      : '画像を添付してください。書類に入れる内容を一緒に確認しましょう。'}</PetMessage></div>
    <label className="assistant-file-picker document-input-attach" aria-disabled={busy}>
      <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={busy}
        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void start(file) }} aria-label="入力したい情報の画像を添付" />
      <span><PetIcon name="folder" />{busy ? `添付中 ${percent}%` : '画像・書類を添付'}</span>
      <small>JPEG・PNG・PDF／10 MBまで</small>
    </label>
    {(error || loadError) && <p role="alert" className="assistant-error">{error || loadError}</p>}
    <div aria-live="polite">
      {inputs?.map((input) => <InputReview key={input.id} dict={dict} input={input} clientName={clientName}
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
      // 値はサーバーが保存した候補を使う。画面は、反映する項目を選ぶだけ。
      await api.adoptDocumentInput(input.id, selected.map((c) => ({ key: c.key, base: c.base })))
      await onApplied()
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409
        ? (e.message.includes('様式の版') ? '様式の版が変わりました。同じ画像をもう一度選ぶと、新しい様式で読み取り直します。' : e.message)
        : e instanceof ApiError ? '反映できませんでした。入力内容を確認して、もう一度お試しください。' : e instanceof Error ? e.message : '反映できませんでした。')
    } finally { setBusy(false) }
  }
  return <section className="document-input-source" aria-label={input.fileName}>
    <header><PetIcon name="file-earmark-arrow-down" /><div><strong>{input.fileName}</strong><small>{stateLabel[input.status]}</small></div></header>
    {input.status === 'review' && <>
      {pending.length > 0 && <p className="document-input-guidance">赤が元の内容、緑がAIの提案です。反映する項目だけにチェックを付けてください。</p>}
      {candidates.map((candidate) => {
        const field = dict.get(candidate.key)
        const adopted = input.adopted.includes(candidate.key)
        const label = field?.label ?? fieldLabel(candidate.key)
        return <div key={candidate.key} className="assistant-chat-card document-input-candidate" data-state={adopted ? 'applied' : 'ready'}>
          {adopted ? <strong className="document-input-done"><PetIcon name="check2" />{label} · 反映済み</strong> :
            <label className="document-input-choice"><input type="checkbox" aria-label={`${label}を反映`} checked={!excluded.includes(candidate.key) && !!field} disabled={busy || !field}
              onChange={(e) => setExcluded((keys) => e.target.checked ? keys.filter((key) => key !== candidate.key) : [...keys, candidate.key])} />{label}</label>}
          <ProposalDiff field={candidate.key} before={candidate.base} after={adopted ? input.adoptedValues[candidate.key] : candidate.value} dict={dict} unchanged="元の内容と同じです。" />
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
