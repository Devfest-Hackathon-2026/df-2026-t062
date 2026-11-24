// 書類の必須の欄のうち、いくつ入っているか（利用者一覧のバー、作業画面の上の数）。
// 必須の欄は書類の種類の行（form_kinds.required）が持つ。要素が配列なら「どれか 1 つに値があればよい」組
import { isEmpty } from './binding.ts'

export type RequiredKeys = (string | string[])[]

const groups = (required: RequiredKeys) => required.map((item) => Array.isArray(item) ? item : [item])
const hasValue = (keys: string[], values: Record<string, unknown>) => keys.some((key) => !isEmpty(values[key]))

export function countRequired(values: Record<string, unknown>, required: RequiredKeys): { filled: number, total: number } {
  return { filled: groups(required).filter((keys) => hasValue(keys, values)).length, total: required.length }
}

export function missingRequiredKeys(values: Record<string, unknown>, required: RequiredKeys): Set<string> {
  return new Set(groups(required).filter((keys) => !hasValue(keys, values)).flat())
}
