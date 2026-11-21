import { sameValue } from '../apply-batch.ts'
import { diagramSchema } from './fields.ts'
import { labels, type Item, type Person, type Relation } from './model.ts'
import { anatomySchema, bodyPartLabel } from './body.ts'
type ObjectValue = Item | Person | Relation
const ignored = new Set(['x', 'y', 'width', 'height', 'rotation', 'labelOffsetY', 'sources'])
export const semantic = (o: ObjectValue) => Object.fromEntries(Object.entries(o).filter(([key]) => !ignored.has(key)))
export function diagramObjects(value: unknown): ObjectValue[] {
  const parsed = diagramSchema.safeParse(value)
  if (!parsed.success) return []
  return parsed.data.kind === 'family' ? [...parsed.data.data.people, ...parsed.data.data.relations] : parsed.data.data.items
}
const fields: Record<string, string> = { name: '名前', age: '年齢', sex: '性別', household: '同居・別居', deceased: '生死', isSubject: '本人の指定', label: '記載', kind: '関係・記号', source: '接続元', target: '接続先', view: '正面・背面', anatomy: '部位', range: '範囲' }
function shown(key: string, value: unknown): string {
  if (value == null) return '未確認'
  if (key === 'deceased') return value ? '死亡' : '存命'
  if (key === 'sex') return value === 'male' ? '男性' : value === 'female' ? '女性' : '不明'
  if (key === 'view') return value === 'front' ? '正面' : '背面'
  if (key === 'range') return value === 'area' ? '領域' : '部位'
  if (key === 'kind') return labels[value as Item['kind']] ?? String(value)
  if (key === 'anatomy') { const anatomy = anatomySchema.safeParse(value); return anatomy.success ? bodyPartLabel(anatomy.data) : '未確認' }
  return typeof value === 'boolean' ? value ? 'あり' : 'なし' : String(value)
}
export function diagramChanges(before: unknown, after: unknown) {
  const b = new Map(diagramObjects(before).map((o) => [o.id, o])), a = new Map(diagramObjects(after).map((o) => [o.id, o]))
  const person = (id: string) => { const p = a.get(id) ?? b.get(id); return p && 'name' in p ? p.name || '名前未確認' : '名前未確認' }
  const caption = (o: ObjectValue): string => 'name' in o ? o.name || '名前未確認' : 'label' in o ? o.label : `${person(o.source)} → ${person(o.target)}（${o.kind}）`
  return [...new Set([...b.keys(), ...a.keys()])].flatMap((id) => {
    const old = b.get(id), next = a.get(id)
    if (!old) return [{ id, text: `追加：${caption(next!)}` }]
    if (!next) return [{ id, text: `削除：${caption(old)}` }]
    const oldFields = semantic(old), newFields = semantic(next)
    const delta = Object.keys({ ...oldFields, ...newFields }).filter((key) => key !== 'id' && !sameValue(oldFields[key], newFields[key]))
    if (!delta.length && !sameValue({ x: (old as Item).x, y: (old as Item).y }, { x: (next as Item).x, y: (next as Item).y })) return [{ id, text: `位置変更：${caption(next)}` }]
    return delta.length ? [{ id, text: `${caption(next)}：${delta.map((key) => `${fields[key] ?? key} ${key === 'source' || key === 'target' ? person(String(oldFields[key])) : shown(key, oldFields[key])} → ${key === 'source' || key === 'target' ? person(String(newFields[key])) : shown(key, newFields[key])}`).join('、')}` }] : []
  })
}
