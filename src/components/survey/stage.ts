// 読み取った認定調査票の値を、用紙に入れる前の下書きにする
import { sameValue } from '../../../core/apply-batch.ts'
import { isEmpty, renderSlot, type Values } from '../../../core/binding.ts'
import { surveyChoice } from '../../../core/survey-import.ts'
import type { fieldTargets } from '../document/fields.ts'
import type { SurveyPreview } from './readSurvey.ts'

export interface SurveyDraft {
  candidate: SurveyPreview['candidates'][number]
  source: Omit<SurveyPreview, 'candidates'>
  value: string | undefined
  conflicts?: SurveyDraft[]
  baseline: unknown
  blocked: boolean
}

export function stageSurvey(preview: SurveyPreview, current: Values, saved: Values) {
  const { candidates, ...source } = preview
  return candidates.flatMap((candidate): SurveyDraft[] => {
    const { key, choice } = candidate
    const value = choice === null ? undefined : surveyChoice(key, choice)
    if (value !== undefined && sameValue(current[key], value)) return []
    return [{ candidate, source, value, baseline: current[key], blocked: !isEmpty(current[key]) || !isEmpty(saved[key]) }]
  })
}

export function mergeSurveyDrafts(previous: SurveyDraft[], incoming: SurveyDraft[]) {
  const merged = new Map(previous.map((draft) => [draft.candidate.key, draft]))
  for (const draft of incoming) {
    const key = draft.candidate.key
    const prior = merged.get(key)
    if (prior?.source.sha256 === draft.source.sha256 || prior?.conflicts?.some((other) => other.source.sha256 === draft.source.sha256)) continue
    if (prior && prior.value !== undefined && draft.value !== undefined && prior.value !== draft.value) {
      const { conflicts = [], ...earlier } = prior
      merged.set(key, { ...draft, blocked: true, conflicts: [...conflicts, earlier] })
    } else if (!prior || (prior.value === undefined && draft.value !== undefined)) {
      merged.set(key, draft)
    }
  }
  return [...merged.values()]
}

export function surveyOverlays(drafts: SurveyDraft[], current: Values, saved: Values, targets: ReturnType<typeof fieldTargets>) {
  const slots = new Map<string, SurveyDraft>()
  for (const draft of drafts) {
    const { key } = draft.candidate
    if (draft.blocked || draft.value === undefined || !isEmpty(current[key]) || !isEmpty(saved[key])) continue
    const values = { ...current, [key]: draft.value }
    const slot = targets.get(key)?.slots.find((s) => s.kind === 'circle' && s.binding && renderSlot(s.binding, values) === 'true')
    if (slot) slots.set(slot.name, draft)
  }
  return slots
}
