import type { DocState } from '../document/useDocument.ts'

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
