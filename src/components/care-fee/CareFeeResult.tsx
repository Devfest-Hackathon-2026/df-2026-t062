import { FEE_REASONS } from '../../../core/care-fees.ts'
import type { CareFeeCalculation } from '../../../core/care-fee-api.ts'
export function CareFeeResult({calculation}:{calculation:CareFeeCalculation}) {
 const r=calculation.result
 return <section className="care-fee-result" aria-label="保存済みの算定結果"><h2>保存版 {calculation.revision} の算定結果</h2><p>{calculation.month} ・ {calculation.input.basis==='planned'?'予定':'実績'} ／ 第6表 保存版 {calculation.sourceRevision}</p>
  <p role="status">{calculation.confirmedAt?'確定済み':r.status==='calculated'?'限定範囲の計算済み（未確定）':'未計算・要確認'}</p>
  {r.status==='needs_review'?<ul>{r.reasons.map(reason=><li key={reason}>{FEE_REASONS[reason]}</li>)}</ul>:<dl><dt>サービス単位数</dt><dd>{r.units.toLocaleString('ja-JP')} 単位（{r.count}回）</dd><dt>区分支給限度基準額</dt><dd>{r.limit.toLocaleString('ja-JP')} 単位</dd><dt>残り</dt><dd>{r.remaining.toLocaleString('ja-JP')} 単位</dd><dt>費用総額</dt><dd>{r.gross.toLocaleString('ja-JP')} 円</dd><dt>保険給付額</dt><dd>{r.benefit.toLocaleString('ja-JP')} 円</dd><dt>利用者負担額</dt><dd>{r.patient.toLocaleString('ja-JP')} 円</dd></dl>}
  <p>マスター：{calculation.masterId}</p>{calculation.confirmedAt&&<p>確定日時：{new Date(calculation.confirmedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}</p>}
 </section>
}
