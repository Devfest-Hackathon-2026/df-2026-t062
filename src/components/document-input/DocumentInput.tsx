import { useCallback, useEffect, useRef, useState } from 'react'
import { type DocumentInputView } from '../../../core/document-input.ts'
import type { FieldDict } from '../../../core/dictionary.ts'
import { ProposalDiff } from '../document/ProposalDiff.tsx'
import { attachDocumentInput } from './attachDocumentInput.ts'
import { api, ApiError } from '../../lib/api.ts'
import { downloadBlob } from '../../lib/download.ts'
import { fieldLabel } from '../document/fields.ts'
import { PetIcon, PetMessage } from '../pet/PetVisuals.tsx'
import './DocumentInput.css'

interface Props {
  documentId: string
  intake: ReturnType<typeof useDocumentInputs>
  dict: FieldDict
  clientName: string
  beforeAdopt: () => Promise<boolean>
  onApplied: () => void
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

const emptyInputs: DocumentInputView[] = []

export function useDocumentInputs(documentId: string | undefined) {
  const [view, setView] = useState<{ documentId: string, inputs: DocumentInputView[], error: string }>()
  const request = useRef(0)
  const active = useRef(documentId)
  active.current = documentId
  const inputs = view?.documentId === documentId ? view?.inputs ?? emptyInputs : emptyInputs
  const error = view?.documentId === documentId ? view?.error ?? '' : ''
  const refresh = useCallback(async () => {
    if (!documentId || active.current !== documentId) return
    const id = ++request.current
    try {
      const r = await api.documentInputs(documentId)
      if (request.current === id && active.current === documentId) setView({ documentId, inputs: r.inputs, error: '' })
    } catch (e) {
      if (request.current === id && active.current === documentId) setView((previous) => ({
        documentId, inputs: previous?.documentId === documentId ? previous.inputs : emptyInputs,
        error: '取り込み一覧を取得できませんでした。',
      }))
      throw e
    }
  }, [documentId])
  useEffect(() => {
    void refresh().catch(() => {})
    return () => { request.current++ }
  }, [refresh])
  const working = inputs.some((input) => input.status === 'queued' || input.status === 'processing')
  useEffect(() => {
    if (!working) return
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    function schedule() {
      timer = setTimeout(async () => {
        await refresh().catch(() => {})
        if (!stopped) schedule()
      }, 3000)
    }
    schedule()
    return () => { stopped = true; clearTimeout(timer) }
  }, [working, refresh])
  return { inputs, error, working, refresh }
}

export function DocumentInput({ documentId, intake: { inputs, error: listError, refresh }, dict, clientName, beforeAdopt, onApplied }: Props) {
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
    {(error || listError) && <p role="alert" className="assistant-error">{error || listError}</p>}
    <div aria-live="polite">
      {inputs.map((input) => <InputReview key={input.id} dict={dict} input={input} clientName={clientName}
        retry={async () => { await api.retryDocumentInput(input.id); await refresh() }} beforeAdopt={beforeAdopt} onApplied={async () => { onApplied(); await refresh().catch(() => {}) }} />)}
    </div>
  </div>
}

function InputReview({ input, dict, clientName, retry, beforeAdopt, onApplied }: { input: DocumentInputView, dict: FieldDict, clientName: string,
  retry: () => Promise<void>, beforeAdopt: Props['beforeAdopt'], onApplied: () => Promise<void> }) {
  const [excluded, setExcluded] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const evidence = new Map(input.result?.evidence.map((entry) => [entry.id, entry]))
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
        ? `${e.message} 同じファイルをもう一度選ぶと、今の用紙に合わせて候補を作り直します。`
        : e instanceof ApiError ? '反映できませんでした。入力内容を確認して、もう一度お試しください。' : e instanceof Error ? e.message : '反映できませんでした。')
    } finally { setBusy(false) }
  }
  return <section className="document-input-source" aria-label={input.fileName}>
    <header><PetIcon name="file-earmark-arrow-down" /><div><strong>{input.fileName}</strong><small>{stateLabel[input.status]}</small></div></header>
    {input.status === 'review' && <>
      <button type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { downloadBlob(await api.documentOriginal(input.id), input.fileName) }
        catch { setError('原本を取得できませんでした。もう一度お試しください。') }
        finally { setBusy(false) }
      }}>原本をダウンロード</button>
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
          {candidate.baseSource && <p>元の値の出典：{candidate.baseSource.fileName}（{candidate.baseSource.recordedOn.map((date) => date ?? '記録日不明').join('、')}）</p>}
          {candidate.cite.some((id) => evidence.has(id)) && <details>
            <summary>提案の根拠</summary>
            {candidate.cite.map((id) => {
              const entry = evidence.get(id)
              return entry && <div key={id}>
                <p>原本 {entry.page}ページ・記録日 {entry.recordedOn ?? '不明'}</p>
                <blockquote>{entry.text}</blockquote>
              </div>
            })}
          </details>}
        </div>
      })}
      {!!input.result?.issues.length && <details className="document-input-warnings"><summary>読み取りにくかった箇所（{input.result.issues.length}件）</summary>
        {input.result.issues.map((issue, i) => <p key={i}>原本 {issue.page}ページ・{issue.text}</p>)}</details>}
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
