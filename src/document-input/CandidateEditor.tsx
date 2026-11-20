import { useId } from 'react'
import { choicesOf, subFieldsOf, type FieldSpec } from '../../core/fields.ts'

/** 既存の欄の定義で修正する。原文から候補の値を補完しない。 */
export function CandidateEditor({ field, value, disabled, onChange }: { field: FieldSpec, value: unknown, disabled: boolean, onChange: (value: unknown) => void }) {
  const id = useId()
  if (field.type === 'object' || field.type === 'list') {
    const rows = field.type === 'list' ? value as Record<string, unknown>[] : [value as Record<string, unknown>]
    return <fieldset disabled={disabled}><legend>{field.label}</legend>
      {rows.map((row, i) => <div key={i} className="document-input-row">
        {field.type === 'list' && <strong>{i + 1}行目</strong>}
        {subFieldsOf(field).map((sub) => <CandidateEditor key={sub.key} field={sub} value={row?.[sub.key] ?? null} disabled={disabled}
          onChange={(next) => {
            const changed = { ...row, [sub.key]: next }
            onChange(field.type === 'list' ? rows.map((r, index) => index === i ? changed : r) : changed)
          }} />)}
        {field.type === 'list' && <button type="button" disabled={disabled} onClick={() => onChange(rows.filter((_, index) => index !== i))}>この行を削除</button>}
      </div>)}
      {field.type === 'list' && <button type="button" disabled={disabled} onClick={() => onChange([...rows, {}])}>行を追加</button>}
    </fieldset>
  }
  if (field.type === 'multi') return <fieldset disabled={disabled}><legend>{field.label}</legend>
    {choicesOf(field).map((choice) => <label key={choice}><input type="checkbox" checked={(value as string[] ?? []).includes(choice)}
      onChange={(e) => onChange(e.target.checked ? [...(value as string[] ?? []), choice] : (value as string[] ?? []).filter((v) => v !== choice))} />{choice}</label>)}
  </fieldset>
  if (field.type === 'enum' || field.type === 'bool') {
    const choices = field.type === 'bool' ? ['はい', 'いいえ'] : choicesOf(field)
    return <label htmlFor={id}>{field.label}<select id={id} disabled={disabled} value={value == null ? '' : field.type === 'bool' ? value ? 'はい' : 'いいえ' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? null : field.type === 'bool' ? e.target.value === 'はい' : e.target.value)}>
      <option value="">未記入</option>{choices.map((choice) => <option key={choice}>{choice}</option>)}
    </select></label>
  }
  return <label htmlFor={id}>{field.label}
    {field.type === 'longtext' ? <textarea id={id} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      : <input id={id} disabled={disabled} type={field.type === 'number' ? 'number' : 'text'} value={String(value ?? '')}
        onChange={(e) => onChange(field.type === 'number' ? e.target.value === '' ? null : Number(e.target.value) : e.target.value)} />}
  </label>
}
