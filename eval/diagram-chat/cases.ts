// Shared synthetic cases. Importing this file never calls a model.
import assert from 'node:assert/strict'
import type { runChat, ChatDocument, ChatRecording } from '../../api/chat.ts'
import { blank } from '../../core/diagram/model.ts'
import { normalizeBodyProposal } from '../../core/diagram/body.ts'
import { nextDiagram, diagramSchema } from '../../core/diagram/fields.ts'
const base = blank()
base.family.people = [
  { id: 'subject', name: '検証本人', sex: 'unknown', household: '同居', deceased: null, isSubject: true, x: 0, y: 0 },
  { id: 'older-son', name: '長男・一郎', sex: 'male', household: '同居', deceased: null, x: 0, y: 0 },
  { id: 'younger-son', name: '次男・二郎', sex: 'male', household: '別居', deceased: null, x: 0, y: 0 },
]
base.family.relations = [{ id: 'older-link', source: 'subject', target: 'older-son', kind: '親子' }, { id: 'younger-link', source: 'subject', target: 'younger-son', kind: '親子' }]
const family = nextDiagram('family', base, 0)
const doc: ChatDocument = { id: 'synthetic-document', kind: 'assessment', fields: { 'person.name': { value: '検証本人', by: 'cm' }, 'family.genogram': { value: family, by: 'cm' } }, saved: { 'family.genogram': { value: family } } }
export const records: ChatRecording[] = [{ id: 'synthetic-recording', recordedAt: '2026-11-20T01:00:00Z', utterances: [
  { id: 'f1', speaker: '本人', text: 'これは検証用の架空の記録です。私は検証本人です。長男の一郎と同居しています。次男の二郎は別居です。両方とも私の子です。' },
  { id: 'b1', speaker: '本人', text: '右膝が痛いです。左手がしびれます。麻痺と言われたことはありません。' },
] }]
const bodyBefore = diagramSchema.parse(normalizeBodyProposal({ version: 1, kind: 'body', revision: 1, data: { items: [
  { id: 'right-pain', kind: 'pain', label: '右膝の痛み', x: 0, y: 0, width: 32, height: 52, rotation: 0, view: 'front', anatomy: { region: 'knee', side: 'right', view: 'front' } },
  { id: 'left-note', kind: 'note', label: '左手のしびれ', x: 0, y: 0, width: 32, height: 52, rotation: 0, view: 'front', anatomy: { region: 'hand', side: 'left', view: 'front' } },
] } }))
export const cases = [
  { name: 'family-from-records', document: { ...doc, fields: { 'person.name': doc.fields['person.name'] } }, text: '訪問記録と既存書類から家族構成図を作成して', check(reply: Awaited<ReturnType<typeof runChat>>) { const p = reply.proposals.find((p) => p.key === 'family.genogram'); assert.ok(p, reply.reply); const value = diagramSchema.parse(p.after); assert.equal(value.kind, 'family'); if (value.kind === 'family') { assert.ok(value.data.people.length >= 3); assert.ok(value.data.people.filter((p) => p.deceased !== null).length === 0, '不明な生死を断定'); assert.ok(value.data.relations.length >= 2) } } },
  { name: 'family-target-correction', document: doc, text: '記録に同居とあるのは誤りです。次男・二郎ではなく、長男・一郎だけを別居に変更して。他の人や関係は変えないで。', check(reply: Awaited<ReturnType<typeof runChat>>) { const p = reply.proposals.find((p) => p.key === 'family.genogram'); assert.ok(p, reply.reply); const value = diagramSchema.parse(p.after); assert.equal(value.kind, 'family'); if (value.kind === 'family') { assert.equal(value.data.people.find((p) => p.id === 'older-son')?.household, '別居'); assert.equal(value.data.people.find((p) => p.id === 'younger-son')?.household, '別居'); assert.equal(value.data.relations.length, 2); assert.equal(value.data.people.find((p) => p.id === 'subject')?.household, '同居') } } },
  { name: 'body-person-right-and-numbness', document: doc, text: '訪問記録から身体図を作って。左右は本人基準で、しびれを麻痺にしないで。', check(reply: Awaited<ReturnType<typeof runChat>>) { const p = reply.proposals.find((p) => p.key === 'health.bodyMap'); assert.ok(p, reply.reply); const value = diagramSchema.parse(p.after); assert.equal(value.kind, 'body'); if (value.kind === 'body') { assert.ok(value.data.items.some((i) => /膝/.test(i.label) && i.anatomy?.side === 'right')); assert.ok(value.data.items.some((i) => /しびれ/.test(i.label) && i.kind === 'note' && i.anatomy?.side === 'left')); assert.ok(!value.data.items.some((i) => i.kind === 'paralysis')) } } },
  { name: 'body-ambiguous-location', document: doc, text: '体のどこかが痛いそうです。本人にも左右や部位は分かりません。この情報だけで身体図を作って。訪問記録の症状とは別件です。', check(reply: Awaited<ReturnType<typeof runChat>>) { const p = reply.proposals.find((p) => p.key === 'health.bodyMap'); if (!p) { assert.match(reply.reply, /どこ|部位|場所|確認|教え|指定/); return } assert.ok(p.pendingLocations?.length || p.questions?.length); const value = diagramSchema.parse(p.after); assert.equal(value.kind, 'body'); if (value.kind === 'body') assert.equal(value.data.items.length, 0, '不明な部位に仮の座標を断定') } },
  { name: 'family-conflict-question', document: doc, text: '一郎が同居なのか別居なのか、どちらなのか分かりません。記録と違うかもしれません。勝手に家族図を書き換えず、確認が必要な点を教えて。', check(reply: Awaited<ReturnType<typeof runChat>>) { assert.equal(reply.proposals.length, 0, '曖昧な矛盾を勝手に採用'); assert.match(reply.reply, /確認|教え|同居|別居/) } },
  { name: 'body-target-correction', document: { ...doc, fields: { ...doc.fields, 'health.bodyMap': { value: bodyBefore, by: 'cm' } } }, text: '記録の右膝は誤りです。右膝ではなく右足首の痛みに訂正して。左手のしびれや他の症状は変えないで。', check(reply: Awaited<ReturnType<typeof runChat>>) { const p = reply.proposals.find((p) => p.key === 'health.bodyMap'); assert.ok(p, reply.reply); const value = diagramSchema.parse(p.after); assert.equal(value.kind, 'body'); if (value.kind === 'body' && bodyBefore.kind === 'body') { assert.equal(value.data.items.find((i) => i.id === 'right-pain')?.anatomy?.region, 'ankle'); assert.equal(value.data.items.find((i) => i.id === 'right-pain')?.anatomy?.side, 'right'); const old = bodyBefore.data.items.find((i) => i.id === 'left-note'), next = value.data.items.find((i) => i.id === 'left-note'); assert.deepEqual(next, old); assert.equal(value.data.items.length, 2) } } },
]
