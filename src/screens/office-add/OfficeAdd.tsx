// 責任者の画面（#153）: 事業所の書類を足す 手順 1「書類について」。試作（prototypes/111-admin-adopted の addKindScreen）の問いと言葉のまま。
// 「次へ」で書類の種類ができ、手順 2「書式を上げる」へ進む。
import { useState, type ReactNode } from 'react'
import { api, ApiError } from '../../lib/api.ts'
import { linkProps, navigate } from '../../lib/router.tsx'
import { OfficeShell } from '../../components/office-shell/OfficeShell.tsx'
import { AddSteps } from '../../components/office-add/AddSteps.tsx'
import { useOfficeForms } from '../../components/form-status/formStatus.ts'

type Answers = { name: string, perClient: 'one' | 'many', copy: 'yes' | 'no', ai: 'yes' | 'no', append: 'yes' | 'no' }

function Opt<K extends keyof Answers>({ a, set, k, v, title, children }: { a: Answers, set: (k: K, v: Answers[K]) => void, k: K, v: Answers[K], title: string, children: ReactNode }) {
  return <button type="button" className="oa-opt" aria-pressed={a[k] === v} onClick={() => set(k, v)}><strong>{title}</strong><span>{children}</span></button>
}

export function OfficeAdd({ staffName }: { staffName: string }) {
  const { kinds } = useOfficeForms()
  const primary = kinds?.[0]?.name ?? 'アセスメント'
  const [a, setA] = useState<Answers>({ name: '', perClient: 'many', copy: 'yes', ai: 'yes', append: 'no' })
  const [bad, setBad] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = <K extends keyof Answers>(k: K, v: Answers[K]) => setA((x) => ({ ...x, [k]: v }))

  const next = async () => {
    if (!a.name.trim()) { setBad(true); return }
    setBad(false)
    setBusy(true)
    setError('')
    try {
      const r = await api.createOfficeKind({ name: a.name.trim(), perClient: a.perClient, copyFromPrimary: a.copy === 'yes', records: a.ai === 'yes', append: a.ai === 'yes' && a.append === 'yes' })
      navigate(`/office/forms/${encodeURIComponent(r.kind.key)}/upload`)
    } catch (e) {
      setBusy(false)
      setError(e instanceof ApiError ? e.message : String((e as Error).message))
    }
  }

  return (
    <OfficeShell staffName={staffName} active={null} wide>
      <AddSteps step={1} records={a.ai === 'yes'} />
      <main className="oa-body">
        <div className="oa-form">
          <p className="oa-lead">この事業所だけで使う書類を足します。ここで足した書類は、この事業所のケアマネの画面にだけ出ます。</p>
          <label className="oa-name">
            <span>書類の名前</span>
            <input type="text" className={bad ? 'bad' : ''} value={a.name} maxLength={40} onChange={(e) => set('name', e.target.value)} />
            {bad && <span className="of-err">書類の名前を書いてください。</span>}
          </label>
          <div>
            <div className="oa-q">利用者 1 人に、何枚作りますか</div>
            <div className="oa-opts">
              <Opt a={a} set={set} k="perClient" v="one" title="1 枚だけ">直しながら使い続ける書類（{primary}のような）</Opt>
              <Opt a={a} set={set} k="perClient" v="many" title="何枚でも">訪問のたびなど、そのつど新しく作る書類</Opt>
            </div>
          </div>
          <div>
            <div className="oa-q">作るとき、ほかの書類の内容を最初から入れておきますか</div>
            <div className="oa-opts">
              <Opt a={a} set={set} k="copy" v="yes" title={`${primary}から入れておく`}>氏名や住所など、同じ欄の内容を写します。写したあとは別々に直せます。</Opt>
              <Opt a={a} set={set} k="copy" v="no" title="入れない">何も入っていない書類から始めます。</Opt>
            </div>
          </div>
          <div>
            <div className="oa-q">訪問の録音から、AI に書かせますか</div>
            <div className="oa-opts">
              <Opt a={a} set={set} k="ai" v="yes" title="書かせる">何を聞き取るかは、あとの手順 4 で決めます。</Opt>
              <Opt a={a} set={set} k="ai" v="no" title="書かせない">ケアマネが手で書きます。</Opt>
            </div>
            {a.ai === 'yes' && (
              <div className="oa-sub">
                <div className="oa-q">2 回目からの録音では、前の録音の内容も使いますか</div>
                <div className="oa-opts">
                  <Opt a={a} set={set} k="append" v="yes" title="前の録音の内容も使う">何回かに分けて聞き取り、1 枚にまとめていく書類</Opt>
                  <Opt a={a} set={set} k="append" v="no" title="今回の録音だけ">その日の訪問だけを書く書類（訪問記録のような）</Opt>
                </div>
              </div>
            )}
          </div>
        </div>
        {error && <div role="alert" className="of-err" style={{ maxWidth: 760, margin: '16px auto 0' }}>足せませんでした（{error}）</div>}
        <div className="oa-actions narrow">
          <a className="btn" {...linkProps('/office')}>やめる</a>
          <button type="button" className="btn btn-p" disabled={busy} onClick={() => void next()}>次へ（書式を上げる）</button>
        </div>
      </main>
    </OfficeShell>
  )
}
