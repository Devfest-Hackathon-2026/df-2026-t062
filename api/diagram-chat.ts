import { BY_KEY } from '../core/fields.ts'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { diagramSchema, diagramKinds } from '../core/diagram/fields.ts'
import { bodyPlacement } from '../core/diagram/body.ts'
import { diagramObjects, semantic } from '../core/diagram/changes.ts'
import { sameValue } from '../core/apply-batch.ts'
import { pendingLocationSchema, type DiagramSource } from '../core/diagram/evidence.ts'
import type { Item, Person, Relation } from '../core/diagram/model.ts'
import type { ChatDocument, ChatMessage, ChatProposal, ChatRecording } from './chat.ts'

const changesSchema = z.object({
  targetIds: z.array(z.string().min(1).max(100)).max(800),
  evidence: z.array(z.object({ objectId: z.string(), sourceIds: z.array(z.string()).min(1).max(20) }).strict()).max(800),
  questions: z.array(z.string().min(1).max(300)).max(20).optional(),
  pendingLocations: z.array(pendingLocationSchema.omit({ sources: true })).max(100).optional(),
}).strict()
export const diagramChangeParameters = z.toJSONSchema(changesSchema)
export interface DiagramContext {
  sources: Map<string, DiagramSource>
  familyRows: Map<string, unknown[]>
  recordParts: DiagramSource[]
  readParts: Set<string>
  documents: ChatDocument[]
  requireRecordScan: boolean
}
const quote = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 5000)
export function makeDiagramContext(documents: ChatDocument[], recordings: ChatRecording[], messages: ChatMessage[]): DiagramContext {
  const sources = new Map<string, DiagramSource>()
  for (const message of messages.filter((m) => m.role === 'user')) {
    const id = `message:${createHash('sha256').update(message.text).digest('hex').slice(0, 24)}`
    sources.set(id, { id, type: 'message', label: 'チャットでの指示・訂正', quote: message.text })
  }
  const recordParts = recordings.flatMap((r, ri) => r.utterances.flatMap((u) => {
    const parts: DiagramSource[] = []
    for (let at = 0; at < u.text.length; at += 3500) parts.push({ id: `record:${r.id ?? ri}:${u.id}:${at}`, type: 'record', label: `${r.recordedAt.slice(0, 10)} ${u.person ?? u.speaker}の発言`, recordedAt: r.recordedAt, quote: u.text.slice(at, at + 3500) })
    return parts
  }))
  return { sources, familyRows: new Map(), recordParts, readParts: new Set(), documents, requireRecordScan: /訪問|録音|記録|文字起こし/.test(messages.filter((m) => m.role === 'user').at(-1)?.text ?? '') }
}
export function readDiagramRecords(context: DiagramContext, cursor: unknown) {
  const offset = cursor == null ? 0 : cursor
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > context.recordParts.length) return { error: 'cursorは0からtotalPartsまでの整数です' }
  const page: DiagramSource[] = []
  let chars = 0, next = offset
  while (next < context.recordParts.length && page.length < 30) {
    const source = context.recordParts[next]
    if (page.length && chars + source.quote.length > 16000) break
    page.push(source); chars += source.quote.length; next++
    context.sources.set(source.id, source); context.readParts.add(source.id)
  }
  return { parts: page, totalParts: context.recordParts.length, readParts: context.readParts.size, nextCursor: next < context.recordParts.length ? next : null, complete: context.readParts.size === context.recordParts.length }
}
export function readDiagramContext(context: DiagramContext, field: unknown) {
  if (field !== 'family.genogram' && field !== 'health.bodyMap') return { error: '対象の図欄を指定してください' }
  const documents = context.documents.map((doc) => ({
    id: doc.id ?? doc.kind, kind: doc.kind,
    fields: [...new Set([...Object.keys(doc.fields), ...Object.keys(doc.saved ?? {})])].flatMap((key) => {
      if (diagramKinds[key]) return []
      const current = doc.fields[key]?.value, saved = doc.saved?.[key]?.value
      const same = !!doc.saved?.[key] && sameValue(saved, current)
      const name = `${doc.kind === 'assessment' ? 'アセスメント' : doc.kind === 'admission' ? '入院時情報提供書' : '関連書類'}・${BY_KEY.get(key)?.label ?? key}`
      const rows = [
        { value: current, id: `field:${doc.id ?? doc.kind}:${key}`, confirmed: same, state: same ? '保存版と一致' : '未保存／確認状況不明' },
        ...(!same && saved != null ? [{ value: saved, id: `field:${doc.id ?? doc.kind}:${key}:saved`, confirmed: true, state: '保存版・現在値と異なる' }] : []),
      ]
      return rows.flatMap((row) => {
        if (row.value == null || row.value === '') return []
        const source: DiagramSource = { id: row.id, type: 'field', label: `${name}（${row.state}）`, quote: quote(row.value), documentId: doc.id, field: key, confirmed: row.confirmed }
        context.sources.set(source.id, source)
        if (key === 'family.members' && Array.isArray(row.value)) context.familyRows.set(source.id, row.value)
        return [{ key, value: row.value, source }]
      })
    }),
  }))
  return { documents, messages: [...context.sources.values()].filter((s) => s.type === 'message'), recordings: readDiagramRecords(context, 0), visitNotes: { available: false, reason: '独立した訪問メモの保存・取得経路は未実装。書類の欄に保存された記載と録音の文字起こしのみ参照できる' }, guidance: '記録を根拠に図を作るときはnextCursorを辿りcomplete=trueを確認する。未確認・矛盾・不明点は質問し、推測で確定しない' }
}
function changedObjects(before: unknown, after: unknown) {
  const b = new Map(diagramObjects(before).map((o) => [o.id, o])), a = new Map(diagramObjects(after).map((o) => [o.id, o]))
  return [...new Set([...b.keys(), ...a.keys()])].filter((id) => !sameValue(b.has(id) ? semantic(b.get(id)!) : null, a.has(id) ? semantic(a.get(id)!) : null))
}
function clinicalReason(kind: string, label: string, sources: DiagramSource[]) {
  if (/しびれ|痺れ/.test(label) && kind !== 'note') return 'しびれは注記として本人の表現を残してください。麻痺等に変換できません'
  const required: Record<string, RegExp> = { paralysis: /麻痺/, contracture: /拘縮/, pressure: /褥瘡|床ずれ/, loss: /欠損|切断/, disability: /障害/ }
  if (required[kind] && !sources.some((s) => s.quote.split(/[。\n]/).some((clause) => required[kind].test(clause) && !/なし|ない|ません|否定|不明|疑い|未確認/.test(clause)))) return '医学的分類の根拠がありません。本人の訴えは注記として残すか確認してください'
  return null
}
const aliveStatement = /^(?:現在|今も)?(?:存命|健在|生存)(?:です|しています|している)?$|^(?:現在|今も)?生きて(?:いる|います)$/
const deathStatement = /^(?:すでに|(?:約)?[0-9]+年前に?)?(?:(?:死亡|死去|他界|逝去)(?:です|した|しました|している|しています)?|亡くな(?:った|りました|っている|っています))$/
const personName = (name: string) => name.normalize('NFKC').replace(/^※\s*/, '').replace(/\s/g, '')

function lifeStatus(person: Person, sources: DiagramSource[], context: DiagramContext): boolean | null {
  const claims = new Set<boolean>()
  const name = personName(person.name)
  let hasCurrentActivity = false
  function readText(value: string, ownRow: boolean) {
    for (const clause of value.split(/[。\n；;]/)) {
      const compact = personName(clause)
      const named = name && compact.startsWith(name)
        ? /^(?:さん|様)?(?:は|が|:|、)(.+)$/.exec(compact.slice(name.length))?.[1]
        : undefined
      // 主語の省略を認めるのは、氏名で照合した家族欄の行だけ。
      const statement = named ?? (ownRow ? compact : '')
      if (deathStatement.test(statement)) claims.add(true)
      if (aliveStatement.test(statement)) claims.add(false)
    }
  }
  for (const source of sources) {
    const rows = context.familyRows.get(source.id)
    if (!rows) {
      readText(source.quote, false)
      continue
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !('name' in row) || typeof row.name !== 'string' || !name || personName(row.name) !== name) continue
      if ('deceased' in row && typeof row.deceased === 'boolean') claims.add(row.deceased)
      const notes = ['health', 'employment', 'note'].flatMap((key) => {
        const value = (row as Record<string, unknown>)[key]
        return typeof value === 'string' ? [value] : []
      })
      for (const note of notes) readText(note, true)
      // Current health/employment describes this row's person. A bare household label or age does not.
      const currentHealth = 'health' in row && typeof row.health === 'string' && /^(?:良好|健康|元気|特に問題なし)[。\s]*$/.test(row.health.trim())
      const currentEmployment = 'employment' in row && typeof row.employment === 'string' && /^(?:会社員|公務員|自営業|パート(?:[（(][^）)]*[）)])?|アルバイト|勤務中|就労中)$/.test(row.employment.trim())
      hasCurrentActivity ||= currentHealth || currentEmployment
    }
  }
  if (claims.size === 0) return hasCurrentActivity ? false : null
  return claims.size === 1 ? [...claims][0] : null
}

/** The model declares only the intended delta; source text is always copied from actual reads. */
export function prepareDiagramProposal(proposal: ChatProposal, raw: unknown, context: DiagramContext): ChatProposal | string {
  const parsed = changesSchema.safeParse(raw)
  if (!parsed.success) return '図の変更対象ID・根拠・確認事項をdiagramChangesに指定してください'
  const meta = parsed.data
  const before = diagramSchema.safeParse(proposal.before)
  let after = diagramSchema.parse(proposal.after)
  const pending = meta.pendingLocations ?? []
  if (pending.length && after.kind !== 'body') return '家族構成図では位置指定を使いません'
  if (new Set(pending.map((p) => p.id)).size !== pending.length) return '位置指定の対象IDが重複しています'
  const changed = new Set([...changedObjects(proposal.before, after), ...pending.map((p) => p.id)])
  const previous = new Map(diagramObjects(proposal.before).map((o) => [o.id, o]))
  if (![...changed].every((id) => meta.targetIds.includes(id)) || meta.targetIds.some((id) => !changed.has(id))) return '変更対象とtargetIdsが一致しません。依頼された人物・関係・症状だけを変更してください'
  if (!changed.size) return '図の内容に変更がありません'
  const evidence = new Map(meta.evidence.map((e) => [e.objectId, e.sourceIds]))
  const verified = new Map<string, DiagramSource[]>()
  for (const id of changed) {
    const ids = evidence.get(id)
    if (!ids?.length || ids.some((id) => !context.sources.has(id))) return '取得していない出典が指定されています。read_diagram_contextで根拠を確認してください'
    verified.set(id, ids.map((id) => context.sources.get(id)!))
  }
  const fromRecords = [...verified.values()].flat().some((s) => s.type === 'record')
  if ((fromRecords || context.requireRecordScan) && context.readParts.size !== context.recordParts.length) return '録音の未取得部分があります。read_recordsでnextCursorを辿り、全ページを取得してから提案してください'
  for (const id of changed) if (previous.has(id) && !diagramObjects(after).some((o) => o.id === id) && !pending.some((p) => p.id === id)) {
    if (!verified.get(id)?.some((s) => /消失|なくな|治ま|削除|消して|取り消|誤り|間違|除いて/.test(s.quote))) return '削除の明示的な根拠がありません。依頼されていない人物・関係・症状を削除しないでください'
  }
  function attach<T extends Item | Person | Relation>(object: T): T {
    if (!changed.has(object.id) && previous.has(object.id)) return previous.get(object.id) as T
    const { sources: _untrusted, ...value } = object
    return { ...value, sources: verified.get(object.id) } as T
  }
  if (after.kind === 'family') {
    const removed = before.success && before.data.kind === 'family' ? before.data.data.people.filter((p) => !after.data || !(after.data as { people: Person[] }).people.some((n) => n.id === p.id)) : []
    if (after.data.people.some((p) => !previous.has(p.id) && removed.some((old) => old.name && old.name === p.name))) return '既存人物のIDを付け直すことはできません'
    const people = after.data.people.map((person) => {
      const attached = attach(person)
      const old = previous.get(person.id) as Person | undefined
      if (!changed.has(person.id) || (old && old.deceased === person.deceased && old.deceased !== null)) return attached
      const status = lifeStatus(person, verified.get(person.id) ?? [], context)
      const deceased = status ?? old?.deceased ?? null
      return { ...attached, deceased }
    })
    after = { ...after, data: { people, relations: after.data.relations.map(attach) } }
    const actual = new Set(changedObjects(proposal.before, after))
    if (!actual.size) return '図の内容に変更がありません。生死の確認には根拠が必要です'
    for (const id of verified.keys()) if (!actual.has(id)) verified.delete(id)
    after = { ...after, data: { ...after.data, people: people.map((p) => actual.has(p.id) ? p : (previous.get(p.id) as Person)) } }
  } else if (after.kind === 'body') {
    const items: Item[] = []
    for (const original of after.data.items) {
      let item = attach(original)
      if (changed.has(item.id) && !pending.some((p) => p.id === item.id)) {
        const reason = clinicalReason(item.kind, item.label, verified.get(item.id) ?? [])
        if (reason) return reason
        const anchor = item.anatomy && bodyPlacement(item.anatomy)
        if (!anchor) return '部位が確定していません。推測座標を入れず、pendingLocationsで位置の指定を求めてください'
        item = { ...item, ...anchor }
      }
      items.push(item)
    }
    after = { ...after, data: { items } }
  }
  for (const p of pending) {
    const reason = clinicalReason(p.kind, p.label, verified.get(p.id) ?? [])
    if (reason) return reason
  }
  const result = diagramSchema.safeParse(after)
  if (!result.success) return '図の構造または部位の位置が正しくありません'
  return { ...proposal, after: result.data, questions: meta.questions ?? [], pendingLocations: pending.map((p) => ({ ...p, sources: verified.get(p.id) })), evidence: [...verified.entries()].map(([objectId, sources]) => ({ objectId, sources })) }
}
