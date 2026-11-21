// 欄の名前と、欄が用紙のどのページ・どの印字欄に出るか
import { spec } from '../../../core/fields.ts'
import type { PageLayout, SlotView } from './layout.ts'

export const fieldLabel = (key: string) => spec(key)?.label ?? key

export function fieldTargets(pages: PageLayout[]) {
  const targets = new Map<string, { pageIndex: number, slots: SlotView[] }>()
  pages.forEach((page, pageIndex) => {
    for (const slot of page.slots) {
      const key = slot.binding?.ref.key
      if (!key || slot.binding?.op === 'ageAt@1') continue
      const target = targets.get(key)
      if (!target) targets.set(key, { pageIndex, slots: [slot] })
      else if (target.pageIndex === pageIndex) target.slots.push(slot)
    }
  })
  return targets
}
