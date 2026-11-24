// 聞き取りの話題（まだ埋まっていない必須の欄から選ぶ）と、AI や書類から入れた値の確かめる項目
import { sameValue } from '../../../core/apply-batch.ts'
import { isEmpty, type Values } from '../../../core/binding.ts'
import { missingRequiredKeys, type RequiredKeys } from '../../../core/required.ts'
import type { DocumentView } from '../../lib/api.ts'
import type { fieldTargets } from '../document/fields.ts'
import type { SurveyDraft } from '../survey/stage.ts'

export const interviewTopics = [
  { title: '日常での様子の変化', icon: 'calendar-event', description: '生活リズム・活動量・できることの変化 など', keys: ['person.lifeHistory', 'dailySchedule', 'health.history'] },
  { title: '困っている場面', icon: 'exclamation-triangle', description: '生活の中で負担や不安を感じる場面 など', keys: ['survey.2_2', 'survey.1_7', 'survey.2_5', 'housing.toiletStyle'] },
  { title: 'ご本人の感じ方', icon: 'person', description: '今の気持ち・希望・大切にしたいこと など', keys: ['complaint.person'] },
  { title: 'ご家族の気づき', icon: 'people', description: 'ご家族から見た変化・気になる点 など', keys: ['family.members'] },
  { title: '場面ごとの具体例', icon: 'house', description: '食事・入浴・移動・外出などの様子 など', keys: ['survey.2_4', 'survey.1_10', 'survey.2_2', 'survey.2_12'] },
]

/** required: 書類の種類の必須の欄（GET /api/form-kinds の required） */
export function availableTopics(values: Values, targets: ReturnType<typeof fieldTargets>, required: RequiredKeys) {
  const missing = missingRequiredKeys(values, required)
  return interviewTopics.flatMap((topic) => {
    const keys = topic.keys.filter((key) => missing.has(key) && targets.has(key))
    return keys.length ? [{ ...topic, keys }] : []
  })
}

export interface ReviewItem {
  key: string
  value: string
  confirmed: boolean
  reason?: string
}

export function reviewItems(doc: Pick<DocumentView, 'fields'> | null, current: Values, saved: Values, drafts: SurveyDraft[], targets: ReturnType<typeof fieldTargets>) {
  const items = new Map<string, ReviewItem>()
  for (const [key, field] of Object.entries(doc?.fields ?? {})) {
    if (!targets.has(key) || isEmpty(current[key]) || !(field.by === 'ai' || field.batchId || field.surveySource)) continue
    const value = current[key]
    items.set(key, { key, value: displayValue(value), confirmed: !!field.reviewedAt && sameValue(value,field.value) })
  }
  const pendingSources: ReviewItem[] = []
  for (const { candidate, value, baseline, conflicts } of drafts) {
    const { key, reason } = candidate
    if (!targets.has(key)) continue
    const now = current[key]
    const confirmed = !!doc?.fields[key]?.reviewedAt && sameValue(now,doc.fields[key].value) && !isEmpty(now) && !sameValue(now, baseline)
    const detail = confirmed ? undefined : conflicts?.length ? '読み取った書類同士で値が異なります'
      : reason ?? (!isEmpty(now) && !sameValue(now, value) ? `用紙の現在値：${displayValue(now)}` : undefined)
    const item = { key, value: confirmed ? displayValue(now) : value ?? (isEmpty(now) ? '' : `用紙：${displayValue(now)}`), confirmed, reason: detail }
    if (!confirmed && items.get(key)?.confirmed) pendingSources.push(item)
    else items.set(key, item)
  }
  return [...items.values(), ...pendingSources]
}

function displayValue(value: unknown): string {
  if (isEmpty(value)) return ''
  if (typeof value !== 'object') return String(value)
  return Object.values(value as Record<string, unknown>).map(displayValue).filter(Boolean).join('、')
}
