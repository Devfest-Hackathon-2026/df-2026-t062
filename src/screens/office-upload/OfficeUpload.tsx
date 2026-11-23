// 責任者の画面（#102）: 書式を上げる。
import { useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api.ts'
import { linkProps, navigate } from '../../lib/router.tsx'
import { upload } from '../../lib/upload.ts'
import { BackLink, Icon, OfficeShell } from '../../components/office-shell/OfficeShell.tsx'
import { useOfficeForms } from '../../components/form-status/formStatus.ts'
import { AddSteps } from '../../components/office-add/AddSteps.tsx'
import { adding } from '../../components/office-add/addFlow.ts'

const MAX_BYTES = 20 * 1024 * 1024

export function OfficeUpload({ staffName, kind }: { staffName: string, kind: string }) {
  const { kinds } = useOfficeForms()
  const k = kinds?.find((x) => x.key === kind)
  const [file, setFile] = useState<File | null>(null)
  const [over, setOver] = useState(false)
  const [pct, setPct] = useState<number | null>(null)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const back = `/office/forms/${encodeURIComponent(kind)}`
  const name = k?.name ?? ''

  const pick = (f: File | undefined | null) => {
    setError('')
    if (!f) return
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) { setError('PDF だけ上げられます。'); return }
    if (f.size > MAX_BYTES) { setError('20MB までの PDF を上げてください。'); return }
    setFile(f)
  }
  const go = async () => {
    if (!file) return
    setError('')
    setPct(0)
    try {
      const r = await api.startFormImport(kind)
      if (r.uploadUrl && await upload(r.uploadUrl, file, setPct) === 'expired') throw new Error('送れませんでした。もう一度上げてください')
      await api.completeFormImport(r.import.id)
      navigate(back)
    } catch (e) {
      setPct(null)
      setError(e instanceof ApiError ? e.message : String((e as Error).message))
    }
  }

  // 事業所の書類を足している途中（#153）なら、手順 2 として出す
  const add = !!k && adding(k)
  const content = (
      <div className="of-upload" style={add ? { margin: '0 auto' } : undefined}>
        {add ? <h2 className="of-h1" style={{ fontSize: 20 }}>{name}の書式を上げる</h2> : <h1 className="of-h1">事業所の書式を上げる</h1>}
        <p className="of-lead">{add ? `いつも使っている${name}の書式（PDF）を上げてください。` : `いつも使っている${name}の書式（PDF）を上げると、その形で書類を作れます。`}</p>
        <h2 style={{ margin: '24px 0 0', fontSize: 16 }}>上げる前に</h2>
        <div className="of-conds">
          <div className="of-cond"><h3>何も書き込んでいない書式</h3><p>記入済みのものを上げると、利用者の情報がこのサービスに残ってしまいます。</p></div>
          <div className="of-cond"><h3>Word や Excel から PDF に書き出したもの</h3><p>紙をスキャンしたものや写真は、線や □ を正しく読み取れないことがあります。</p></div>
          <div className="of-cond"><h3>全部のページ</h3><p>上げなかったページは、作る書類に入りません。1 つの PDF にまとめて上げてください。</p></div>
        </div>
        <div
          className={`of-drop${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]) }}
        >
          {Icon.upload}
          <strong>書式の PDF をここに置く</strong>
          <button type="button" className="btn" onClick={() => input.current?.click()}>ファイルを選ぶ</button>
          <input ref={input} type="file" accept="application/pdf" className="sr" tabIndex={-1} aria-label="書式の PDF を選ぶ" onChange={(e) => pick(e.target.files?.[0])} />
          <div className="of-muted">PDF だけ上げられます（20MB まで）</div>
        </div>
        <div className="of-file-row">
          <div className="main">
            {file ? <><div className="of-file-name">{file.name}</div><div className="of-muted">{(file.size / 1024 / 1024).toFixed(1)} MB</div></> : !error && <div className="of-muted">まだ PDF を選んでいません</div>}
            {error && <div role="alert" className="of-err">{error}</div>}
          </div>
          <a className="btn" {...linkProps(add ? '/office' : back)}>{add ? '戻る' : 'やめる'}</a>
          <button type="button" className="btn btn-p" disabled={!file || pct !== null} onClick={() => void go()}>{pct !== null ? `送っています（${pct}%）` : '上げて読み取る'}</button>
        </div>
        <p className="of-muted" style={{ marginTop: 12 }}>{add ? '読み取りには数分かかります。この画面を離れても、読み取りは続きます。' : '読み取りには数分かかります。そのあいだも、今の書式で書類を作れます。'}</p>
      </div>
  )
  if (add) return <OfficeShell staffName={staffName} active={null} wide><AddSteps step={2} name={name} /><main className="oa-body">{content}</main></OfficeShell>
  return (
    <OfficeShell staffName={staffName} active="forms">
      <BackLink to={back} label={name || '戻る'} />
      {content}
    </OfficeShell>
  )
}
