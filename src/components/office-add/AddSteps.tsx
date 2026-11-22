// 事業所の書類を足す流れ（#153）の上の帯: 「事業所の書類を足す：名前」と 5 つの手順。録音から書かない書類は、手順 4 を「（なし）」で薄く出す。
import { BackLink } from '../office-shell/OfficeShell.tsx'
import { ADD_STEPS } from './addFlow.ts'
import './office-add.css'

export function AddSteps({ step, name, records = true }: { step: 1 | 2 | 3 | 4 | 5, name?: string, records?: boolean }) {
  return (
    <>
      <header className="oa-head">
        <BackLink to="/office" label="書類の設定" />
        <h1>事業所の書類を足す{name ? `：${name}` : ''}</h1>
      </header>
      <ol className="oa-steps" aria-label="手順">
        {ADD_STEPS.map((label, i) => {
          const n = i + 1
          const skip = n === 4 && !records
          return (
            <li key={label} className={n < step ? 'done' : n === step ? 'now' : ''} style={skip ? { opacity: 0.45 } : undefined} aria-current={n === step ? 'step' : undefined}>
              <span>{n < step ? '✓' : n}</span><span>{label}{skip ? '（なし）' : ''}</span>
            </li>
          )
        })}
      </ol>
    </>
  )
}

/** 手順 5「使い始める」の確かめ（試作の文のまま） */
export function AddPublishDialog({ name, busy, error, onCancel, onOk }: { name: string, busy: boolean, error: string, onCancel: () => void, onOk: () => void }) {
  return (
    <>
      <div className="of-modal-back" onClick={() => !busy && onCancel()} />
      <section className="of-modal" role="dialog" aria-modal="true" aria-labelledby="oa-pub-h">
        <h2 id="oa-pub-h">「{name}」を使い始めますか？</h2>
        <p>使い始めると、この事業所のケアマネが利用者の書類を作るときに「{name}」を選べるようになります。</p>
        <p className="of-muted">書式は、使い始めたあとも「書類の設定」から直せます。</p>
        {error && <div role="alert" className="of-err">{error}</div>}
        <div className="of-modal-btns">
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>戻る</button>
          <button type="button" className="btn btn-p" disabled={busy} onClick={onOk}>{busy ? '確かめています…' : '使い始める'}</button>
        </div>
      </section>
    </>
  )
}
