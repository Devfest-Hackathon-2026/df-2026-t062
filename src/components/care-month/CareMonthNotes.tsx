import type { MonthEntry } from '../../../core/care-month.ts'

export function CareMonthNotes({ entries, disabled, onChange }: {
  entries: MonthEntry[], disabled: boolean, onChange: (entry: MonthEntry) => void,
}) {
  return <section aria-label="第6表の明細">
    <strong>第6表の明細・補足</strong>
    {entries.map((entry, index) => <fieldset key={entry.id} disabled={disabled}>
      <legend>{index + 1}. {entry.plan.date} {entry.content}</legend>
      <label>予定の補足<textarea aria-label={`予定${index + 1}の補足`} rows={2} maxLength={10000}
        value={entry.plan.note} onChange={e => onChange({ ...entry, plan: { ...entry.plan, note: e.target.value } })} /></label>
      {entry.actual && <label>実績の補足<textarea aria-label={`実績${index + 1}の補足`} rows={2} maxLength={10000}
        value={entry.actual.note} onChange={e => {
          if (entry.actual) onChange({ ...entry, actual: { ...entry.actual, note: e.target.value } })
        }} /></label>}
    </fieldset>)}
  </section>
}
