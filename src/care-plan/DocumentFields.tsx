import type { DocState } from '../form/useDocument.ts'
import { sameValue } from '../../core/apply-batch.ts'

export function DocumentHeader({ state, disabled }: { state: DocState, disabled: boolean }) {
  const mark = (key: string) => sameValue(state.current[key], state.saved[key]) ? '' : state.doc?.fields[key]?.by === 'ai' && !state.hasLocalEdits ? 'cp-ai' : 'cp-hand'
  return <fieldset className="cp-meta" disabled={disabled || !state.doc}>
    <label>この表の利用者名<input className={mark('person.name')} value={typeof state.current['person.name'] === 'string' ? state.current['person.name'] : ''} onChange={(e) => state.setValue('person.name', e.target.value)} /></label>
    <label>この表の作成年月日<input className={mark('plan.createdDate')} type="date" value={typeof state.current['plan.createdDate'] === 'string' ? state.current['plan.createdDate'] : ''} onChange={(e) => state.setValue('plan.createdDate', e.target.value || null)} /></label>
    <small>各表の値は独立しています。他の表の氏名・作成日は自動では変わりません。</small>
  </fieldset>
}

export function DailyActivities({ state, disabled }: { state: DocState, disabled: boolean }) {
  const value = state.current.dailySchedule
  const rows = (Array.isArray(value) ? value : []).filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
  const change = (next: Record<string, unknown>[]) => state.setValue('dailySchedule', next.length ? next : null)
  return <fieldset className="cp-activities" disabled={disabled || !state.doc}>
    <legend>主な日常生活上の活動</legend>
    <p>本人の生活リズムを入力します。ここから家族の援助やサービスの予定は変更しません。</p>
    {rows.map((row, index) => <div className="cp-fields" key={index}>
      <label>時刻<select value={String(row.time ?? '')} onChange={(e) => change(rows.map((r, i) => i === index ? { ...r, time: e.target.value } : r))}>
        {Array.from({ length: 24 }, (_, h) => <option key={h} value={String(h)} disabled={rows.some((r, i) => i !== index && r.time === String(h))}>{h}:00</option>)}
      </select></label>
      <label>本人の生活リズム<input value={typeof row.rhythm === 'string' ? row.rhythm : ''} onChange={(e) => change(rows.map((r, i) => i === index ? { ...r, rhythm: e.target.value } : r))} /></label>
    </div>)}
    <button className="btn" type="button" disabled={disabled || !state.doc || rows.length >= 24} onClick={() => {
      const time = Array.from({ length: 24 }, (_, h) => String(h)).find((h) => !rows.some((r) => r.time === h))
      if (time !== undefined) change([...rows, { time, rhythm: '' }])
    }}>＋ 生活時間を追加</button>
  </fieldset>
}
