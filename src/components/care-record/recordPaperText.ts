import type { Binding } from '../../../core/binding.ts'
import type { PaperTextField } from '../care-paper/PaperText.tsx'

interface Attendee { id: string; affiliation: string; profession: string; name: string }
const textKeys: Record<string, { label: string, multiline?: boolean, maxLength?: number } | undefined> = {
  'person.name': { label: '利用者名' },
  'office.careManagerName': { label: '記載者' },
  'meeting.place': { label: '開催場所' },
  'meeting.relationship': { label: '家族の続柄' },
  'meeting.items': { label: '検討した項目', multiline: true, maxLength: 100000 },
  'meeting.discussion': { label: '検討内容', multiline: true, maxLength: 100000 },
  'meeting.conclusion': { label: '結論', multiline: true, maxLength: 100000 },
  'meeting.remaining': { label: '残された課題', multiline: true, maxLength: 100000 },
  'meeting.nextDate': { label: '次回の開催時期', multiline: true, maxLength: 100000 },
  'progress.category': { label: '項目・連絡方法', maxLength: 300 },
  'progress.content': { label: '記録内容', multiline: true, maxLength: 100000 },
}

export function recordPaperText(slot: string, binding: Binding | undefined, page: number, rowOffset: number, values: Record<string, unknown>, setValue: (key: string, value: unknown) => void): PaperTextField | undefined {
  if (binding?.op !== 'text@1') return
  const { key, path } = binding.ref
  if (key === 'meeting.attendees') {
    const [row, field] = path ?? []
    if (typeof row !== 'number' || (field !== 'name' && field !== 'affiliation' && field !== 'profession')) return
    const index = rowOffset + row
    const attendees = Array.isArray(values[key]) ? values[key] as Attendee[] : []
    if (index > attendees.length) return
    const attendee = attendees[index]
    const label = `出席者${index + 1}の${{ name: '氏名', affiliation: '所属', profession: '職種' }[field]}`
    return { key,label, value: attendee?.[field] ?? '', onChange: value => {
      const entry = { ...(attendee ?? { id: crypto.randomUUID(), name: '', affiliation: '', profession: '' }), [field]: value }
      const next = [...attendees]
      next[index] = entry
      setValue(key, next)
    } }
  }
  const field = textKeys[key]
  if (!field || slot.endsWith('_右') || page > 0) return
  const raw = values[key]
  return { key,...field, value: typeof raw === 'string' ? raw : '', onChange: value => setValue(key, value || null) }
}
