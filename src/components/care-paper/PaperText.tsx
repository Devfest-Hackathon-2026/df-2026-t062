import type { CSSProperties } from 'react'

export interface PaperTextField {
  key?:string
  label: string
  value: string
  onChange: (value: string) => void
  multiline?: boolean
  inputMode?: 'numeric'
  maxLength?: number
}

/** 印字用に折り返した文字列ではなく、原文を用紙上の欄で編集する。 */
export function PaperText({ field, placeholder, className, style, disabled }: {
  field: PaperTextField
  placeholder?: string
  className: string
  style: CSSProperties
  disabled: boolean
}) {
  const props = {
    className: `${className} paper-text`,
    'aria-label': field.label,
    'data-field-key':field.key,
    style,
    value: field.value,
    placeholder,
    disabled,
    maxLength: field.maxLength,
    inputMode: field.inputMode,
  }
  return field.multiline
    ? <textarea {...props} onChange={(e) => field.onChange(e.target.value)} />
    : <input {...props} type="text" onChange={(e) => field.onChange(e.target.value)} />
}
