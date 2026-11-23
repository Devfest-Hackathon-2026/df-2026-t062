// 責任者の画面（#102）: 書類の設定（一覧）。
// #111 で採用した試作（prototypes/111-admin-adopted）の並びと言葉を、本番の部品に合わせたもの。
// 責任者には、裏側の言葉（様式・版・対応など）を見せない。AI に事業所のやり方を教える入口（AI 特訓部屋）は、書類の画面に置く（#115）。
import { linkProps } from '../../lib/router.tsx'
import { OfficeShell } from '../../components/office-shell/OfficeShell.tsx'
import { day, phaseOf, useOfficeForms } from '../../components/form-status/formStatus.ts'
import { adding, resumePath } from '../../components/office-add/addFlow.ts'
import '../../components/office-add/office-add.css'

export function OfficeForms({ staffName }: { staffName: string }) {
  const { kinds, error } = useOfficeForms()
  return (
    <OfficeShell staffName={staffName} active="forms">
      <div className="of-list">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <h1 className="of-h1">書類の設定</h1>
          <a className="btn btn-p" {...linkProps('/office/add')}>＋ 事業所の書類を足す</a>
        </div>
        <p className="of-lead" style={{ marginTop: 0 }}>書類ごとに、事業所でいつも使っている書式（PDF）を上げると、その形で書類を作れます。</p>
        {error && <div role="alert" className="of-err">読み込めませんでした（{error}）</div>}
        {!error && !kinds && <div role="status" className="of-muted">読み込んでいます</div>}
        {kinds && (
          <div className="of-rows">
            {kinds.filter((k) => !adding(k)).map((k) => {
              const p = phaseOf(k)
              const notice = p === 'review' ? ['', k.draft!.review.length ? '上げた書式に、AI が迷った欄があります' : '上げた書式を読み取りました。確かめてください']
                : p === 'reading' ? ['muted', '上げた書式を読み取っています']
                  : p === 'failed' || p === 'empty' ? ['danger', '上げた書式を読み取れませんでした']
                    : p === 'fixing' ? ['', '書式を直している途中です'] : null
              return (
                <a key={k.key} className="of-row" {...linkProps(`/office/forms/${encodeURIComponent(k.key)}`)}>
                  <div>
                    <span className="of-row-name">{k.name}</span>
                    {notice && <span className={`of-notice ${notice[0]}`}>{notice[1]}</span>}
                    <div className="of-row-sub">{k.own ? `事業所で足した書類（${day(k.current?.since ?? null)} から）` : k.current?.office ? `事業所の書式（${day(k.current.since)} から）` : '最初から入っている書式'}</div>
                  </div>
                  <span className="of-chev" aria-hidden="true">›</span>
                </a>
              )
            })}
            {kinds.filter(adding).map((k) => {
              // 事業所の書類を足している途中（#153）。試作の一覧の「足している途中」の行
              const p = phaseOf(k)
              const n = p === 'reading' ? ['muted', '書式を読み取っています'] : p === 'review' ? ['', 'AI が迷った欄があります'] : p === 'failed' || p === 'empty' ? ['danger', '書式を読み取れませんでした'] : ['muted', '足している途中です']
              return (
                <a key={k.key} className="of-row" {...linkProps(resumePath(k))}>
                  <div>
                    <span className="of-row-name">{k.name}</span><span className="oa-draft-tag">足している途中</span>
                    <span className={`of-notice ${n[0]}`}>{n[1]}</span>
                  </div>
                  <span className="of-chev" style={{ display: 'inline-flex', gap: 8, fontSize: 14, fontWeight: 700 }}>続ける<span aria-hidden="true">›</span></span>
                </a>
              )
            })}
          </div>
        )}
      </div>
    </OfficeShell>
  )
}
