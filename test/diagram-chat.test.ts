import { seedFormDef } from '../forms/admin/files.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeDiagramContext, readDiagramContext, readDiagramRecords, prepareDiagramProposal } from '../api/diagram-chat.ts'
import { checkProposal, runChat, diagramChatSystem, chatSystem, type ChatDocument, type ChatProposal, type ChatRecording } from '../api/chat.ts'
import { blank, type Item } from '../core/diagram/model.ts'
import { nextDiagram, diagramSchema } from '../core/diagram/fields.ts'
import { anatomySchema, bodyAnchor, normalizeBodyProposal, tapPosition, BODY_VIEWS } from '../core/diagram/body.ts'
import { familyLayout, familyRelationPaths } from '../core/diagram/family-layout.ts'
import { diagramSvg } from '../core/diagram/svg.ts'
import { diagramChanges } from '../core/diagram/changes.ts'
import { cardAction, pendingDiagramDraft, diagramCardStatus, type ProposalCard } from '../src/components/assistant/petChat.ts'
const doc: ChatDocument = { id: 'doc-a', kind: 'assessment', name: 'アセスメント', form: seedFormDef('assessment'), fields: { 'family.members': { value: [{ name: '一郎', relationship: '子' }], by: 'cm' } }, saved: { 'family.members': { value: [{ name: '一郎', relationship: '子' }] } } }
const context = (text: string, recordings: ChatRecording[] = []) => makeDiagramContext([doc], recordings, [{ role: 'user', text }])
const userSource = (c: ReturnType<typeof context>) => [...c.sources.values()].find((s) => s.type === 'message')!.id
const meta = (ids: string[], source: string) => ({ targetIds: ids, evidence: ids.map((id) => ({ objectId: id, sourceIds: [source] })) })
const candidate = (key: string, before: unknown, after: unknown): ChatProposal => ({ key, label: key, before, after })
const pendingValue = () => nextDiagram('body', blank(), 0)
const pain = (id = 'pain'): Item => ({ id, kind: 'pain', label: '右膝の痛み', x: 0, y: 0, width: 32, height: 52, rotation: 0, view: 'front', anatomy: { region: 'knee', side: 'right', view: 'front' } })

test('selected diagram is preloaded with its shape and real sources; unrelated edits and tools are rejected', async () => {
  const document: ChatDocument = { ...doc, fields: { ...doc.fields, 'complaint.person': { value: '元の文章', by: 'cm' } } }
  const before = structuredClone(document)
  let turn = 0
  const reply = await runChat({ document, recordings: [], diagramField: 'health.bodyMap', messages: [{ role: 'user', text: '本人の右膝が痛いので身体図を作って' }], model: async ({ system, contents, tools }) => {
    assert.match(system, /health.bodyMap/)
    assert.ok(!tools.some((t) => t.name === 'missing_fields' || t.name === 'search_records'))
    if (turn++ === 0) return [
      { functionCall: { name: 'propose_edit', args: { key: 'complaint.person', value: '勝手な変更' } } },
      { functionCall: { name: 'propose_edit', args: { key: 'family.genogram', value: '{}' } } },
      { functionCall: { name: 'missing_fields' } },
    ]
    if (turn === 2) {
      const responses = contents.at(-1)!.parts.map((p) => p.functionResponse!.response)
      assert.match(String(responses[0].reason), /相談対象/)
      assert.match(String(responses[1].reason), /相談対象/)
      assert.ok(responses[2].error)
      const attachment = contents[0].parts[1].text!
      const preloaded = JSON.parse(attachment.slice(attachment.indexOf('{')))
      assert.equal(preloaded.field, 'health.bodyMap')
      assert.equal(preloaded.form.empty[0].key, 'health.bodyMap')
      assert.ok(preloaded.form.empty[0].shape.schema)
      const id = preloaded.context.messages[0].id
      return [{ functionCall: { name: 'propose_edit', args: { key: 'health.bodyMap', baseRevision: 0, value: JSON.stringify({ version: 1, kind: 'body', revision: 1, data: { items: [pain()] } }), diagramChanges: meta(['pain'], id) } } }]
    }
    return [{ text: '右膝の痛みの案です。まだ用紙には反映していません。' }]
  } })
  assert.equal(reply.proposals.length, 1)
  assert.equal(reply.proposals[0].key, 'health.bodyMap')
  assert.deepEqual(document, before)
  assert.ok(diagramChatSystem('health.bodyMap').length < chatSystem(doc).length)
  assert.doesNotMatch(diagramChatSystem('health.bodyMap'), /欄の置き場所の決まり/)
})

test('focused diagram cannot use a different draft or a missing published diagram slot', async () => {
  let called = false
  const base = { document: doc, recordings: [], messages: [{ role: 'user' as const, text: '直して' }], model: async () => { called = true; return [] } }
  await assert.rejects(runChat({ ...base, diagramField: 'family.genogram', draft: { key: 'health.bodyMap', after: pendingValue() } }), /一致/)
  await assert.rejects(runChat({ ...base, diagramField: 'family.genogram', document: { ...doc, editableKeys: [] } }), /図欄/)
  assert.equal(called, false)
})

test('preloaded record page is not mistaken for complete retrieval', async () => {
  let turn = 0
  const reply = await runChat({ document: doc, diagramField: 'health.bodyMap', recordings: [{ recordedAt: '2026-11-20', utterances: Array.from({ length: 35 }, (_, i) => ({ id: `r${i}`, speaker: '本人', text: '右膝が痛いです' })) }], messages: [{ role: 'user', text: '訪問記録から身体図を作って' }], model: async ({ contents }) => {
    if (turn++ === 0) {
      const attachment = contents[0].parts[1].text!
      const context = JSON.parse(attachment.slice(attachment.indexOf('{'))).context
      assert.equal(context.recordings.complete, false)
      assert.equal(context.recordings.nextCursor, 30)
      return [{ functionCall: { name: 'propose_edit', args: { key: 'health.bodyMap', baseRevision: 0, value: JSON.stringify({ version: 1, kind: 'body', revision: 1, data: { items: [pain()] } }), diagramChanges: meta(['pain'], context.recordings.parts[0].id) } } }]
    }
    assert.match(String(contents.at(-1)!.parts[0].functionResponse!.response.reason), /未取得/)
    return [{ text: 'まだ読み取っていない記録があります。' }]
  } })
  assert.equal(reply.proposals.length, 0)
})

test('an expired chat deadline never calls the model or changes the sheet', async () => {
  let called = false
  const before = structuredClone(doc)
  await assert.rejects(runChat({ document: doc, diagramField: 'family.genogram', recordings: [], messages: [{ role: 'user', text: '作って' }], signal: AbortSignal.abort(new DOMException('deadline', 'TimeoutError')), model: async () => { called = true; return [] } }), { name: 'TimeoutError' })
  assert.equal(called, false)
  assert.deepEqual(doc, before)
})

test('record retrieval pages every utterance, including non-keyword and very long statements, without truncation', () => {
  const utterances = Array.from({ length: 93 }, (_, i) => ({ id: `u-${i}`, speaker: '本人', text: i === 70 ? '長い発言'.repeat(3000) : `語句に一致しない発言${i}` }))
  const c = context('訪問記録から作って', [{ id: 'r', recordedAt: '2026-11-20T00:00:00Z', utterances }])
  let cursor: number | null = 0
  const read: { id: string, quote: string }[] = []
  while (cursor !== null) { const page = readDiagramRecords(c, cursor); assert.ok(page.parts); read.push(...page.parts); cursor = page.nextCursor ?? null }
  assert.equal(c.readParts.size, c.recordParts.length)
  for (const u of utterances) assert.equal(read.filter((r) => r.id.startsWith(`record:r:${u.id}:`)).map((r) => r.quote).join(''), u.text)
  assert.ok('error' in readDiagramRecords(c, -1))
  assert.ok('error' in readDiagramRecords(c, .5))
})
test('diagram context reports real saved fields and provenance, without claiming a visit memo importer', () => {
  const c = context('家族構成図を作成して')
  const result = readDiagramContext(c, 'family.genogram')
  assert.ok(result.documents && result.visitNotes)
  assert.equal(result.visitNotes.available, false)
  assert.equal(result.documents[0].fields[0].source.confirmed, true)
  assert.equal(result.documents[0].fields[0].source.quote, JSON.stringify(doc.fields['family.members'].value))
  assert.ok('error' in readDiagramContext(c, 'unknown'))
})
test('different saved and current field values are both returned, with honest confirmation states', () => {
  const different: ChatDocument = { ...doc, fields: { 'family.members': { value: [{ name: '一郎', relationship: '子', livingTogether: false }], by: 'cm' } } }
  const c = makeDiagramContext([different], [], [])
  const result = readDiagramContext(c, 'family.genogram')
  assert.ok(result.documents)
  const rows = result.documents[0].fields
  assert.equal(rows.length, 2)
  assert.equal(rows[0].source.confirmed, false)
  assert.equal(rows[1].source.confirmed, true)
  assert.match(rows[1].source.label, /現在値と異なる/)
})

test('family updates preserve IDs and unrelated people, and only store evidence copied from actual sources', () => {
  const drawing = blank()
  drawing.family.people = [ { id: 'one', name: '一郎', sex: 'unknown', deceased: null, household: '同居', x: 0, y: 0 }, { id: 'two', name: '二郎', sex: 'unknown', deceased: null, household: '別居', x: 0, y: 0 } ]
  const before = nextDiagram('family', drawing, 0)
  drawing.family.people[0] = { ...drawing.family.people[0], household: '別居', sources: [{ id: 'invented', type: 'message', label: '捏造', quote: '捏造' }] }
  const after = nextDiagram('family', drawing, 1)
  const c = context('一郎だけ別居に訂正。他は変更しない')
  const r = prepareDiagramProposal(candidate('family.genogram', before, after), meta(['one'], userSource(c)), c)
  assert.notEqual(typeof r, 'string')
  if (typeof r === 'string') return
  const value = diagramSchema.parse(r.after)
  assert.equal(value.kind, 'family')
  if (value.kind === 'family') {
    assert.equal(value.data.people[0].id, 'one')
    assert.equal(value.data.people[0].sources![0].quote, '一郎だけ別居に訂正。他は変更しない')
    assert.deepEqual(value.data.people[1], (before.kind === 'family' ? before.data.people[1] : null))
  }
  assert.match(String(prepareDiagramProposal(candidate('family.genogram', before, after), meta([], userSource(c)), c)), /targetIds/)
  assert.match(String(prepareDiagramProposal(candidate('family.genogram', before, after), meta(['one'], 'fabricated-source'), c)), /出典/)
})
test('unknown life status stays unknown; medical negations and numbness cannot be classified as paralysis', () => {
  const drawing = blank()
  drawing.family.people = [{ id: 'one', name: '一郎', sex: 'unknown', deceased: false, household: '不明', x: 0, y: 0 }]
  const c = context('一郎さんを図に追加してください。生死は未確認です')
  const proposal = prepareDiagramProposal(candidate('family.genogram', null, nextDiagram('family', drawing, 0)), meta(['one'], userSource(c)), c)
  assert.ok(typeof proposal !== 'string')
  const value = diagramSchema.parse(proposal.after)
  assert.equal(value.kind, 'family')
  assert.equal(value.data.people[0].deceased, null)
  for (const label of ['左手のしびれ', '左手の麻痺']) {
    const d = blank(); d.body.items = [{ ...pain(), label, kind: 'paralysis' }]
    const body = diagramSchema.parse(normalizeBodyProposal(nextDiagram('body', { ...d, body: { items: [] } }, 0)))
    const raw = normalizeBodyProposal({ ...body, data: { items: d.body.items } })
    const negative = context('左手がしびれます。麻痺ではありません')
    assert.equal(typeof prepareDiagramProposal(candidate('health.bodyMap', null, raw), meta(['pain'], userSource(negative)), negative), 'string')
  }
})
test('body anchors use person-relative sides across front/back and reject unknown paired parts', () => {
  const rightFront = bodyAnchor({ region: 'knee', side: 'right', view: 'front' })!, leftFront = bodyAnchor({ region: 'knee', side: 'left', view: 'front' })!
  const rightBack = bodyAnchor({ region: 'knee', side: 'right', view: 'back' })!, leftBack = bodyAnchor({ region: 'knee', side: 'left', view: 'back' })!
  assert.ok(rightFront.x < leftFront.x)
  assert.ok(rightBack.x > leftBack.x)
  assert.equal(bodyAnchor({ region: 'knee', side: 'unknown', view: 'front' }), null)
  assert.equal(bodyAnchor({ region: 'knee', side: 'midline', view: 'front' }), null)
  assert.equal(bodyAnchor({ region: 'back', side: 'midline', view: 'front' }), null)
  assert.ok(tapPosition('front', rightFront.x, rightFront.y))
  assert.ok(tapPosition('back', rightBack.x, rightBack.y))
  assert.equal(tapPosition('front', rightBack.x, rightBack.y), null)
  assert.equal(tapPosition('back', 610, 300), null)
  assert.equal(tapPosition('front', NaN, 300), null)
})
test('body proposals get canonical locations; ambiguous locations wait separately, without inserting an arbitrary item', () => {
  const d = blank(); d.body.items = [pain()]
  const c = context('右膝の痛みを追加して')
  const proposal = checkProposal(doc, 'health.bodyMap', { version: 1, kind: 'body', revision: 1, data: d.body }, 0)
  assert.notEqual(typeof proposal, 'string')
  if (typeof proposal === 'string') return
  const result = prepareDiagramProposal(proposal, meta(['pain'], userSource(c)), c)
  assert.notEqual(typeof result, 'string')
  if (typeof result !== 'string') {
    const value = diagramSchema.parse(result.after)
    assert.equal(value.kind, 'body')
    if (value.kind === 'body') assert.equal(value.data.items[0].x + 16, bodyAnchor(pain().anatomy!)!.x)
  }
  const vague = context('どこかが痛い、部位は分からない')
  const pending = prepareDiagramProposal(candidate('health.bodyMap', null, pendingValue()), { ...meta(['uncertain'], userSource(vague)), pendingLocations: [{ id: 'uncertain', label: '部位不明の痛み', kind: 'pain' }] }, vague)
  assert.notEqual(typeof pending, 'string')
  if (typeof pending !== 'string') {
    const value = diagramSchema.parse(pending.after)
    assert.equal(value.kind, 'body')
    if (value.kind === 'body') assert.equal(value.data.items.length, 0)
    assert.equal(pending.pendingLocations?.length, 1)
  }
})
test('incomplete records block a record-based diagram rather than claiming comprehensive extraction', () => {
  const c = context('訪問記録から図を作って', [{ id: 'r', recordedAt: '2026-11-20T00:00:00Z', utterances: Array.from({ length: 70 }, (_, i) => ({ id: String(i), speaker: '本人', text: '一郎と同居しています。' })) }])
  readDiagramContext(c, 'family.genogram')
  const d = blank(); d.family.people = [{ id: 'one', name: '一郎', sex: 'unknown', household: '同居', deceased: null, x: 0, y: 0 }]
  const p = candidate('family.genogram', null, nextDiagram('family', d, 0))
  assert.match(String(prepareDiagramProposal(p, meta(['one'], userSource(c)), c)), /未取得/)
  let cursor = 30
  for (;;) { const page = readDiagramRecords(c, cursor); assert.ok(page.parts); if (page.nextCursor == null) break; cursor = page.nextCursor }
  assert.notEqual(typeof prepareDiagramProposal(p, meta(['one'], userSource(c)), c), 'string')
})
test('co-resident bounding boxes do not include outsiders, regardless of original coordinates', () => {
  const d = blank()
  d.family.people = Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `人物${i}`, sex: 'unknown', household: i % 2 ? '同居' : '別居', deceased: null, x: i * 50, y: i * 30 }))
  d.family.relations = [{ id: 'parent', kind: '親子', source: '1', target: '3' }]
  const positions = familyLayout(d.family), home = positions.filter((p) => p.household === '同居')
  const maxX = Math.max(...home.map((p) => p.x)) + 148, minX = Math.min(...home.map((p) => p.x)) - 14
  assert.ok(positions.filter((p) => p.household !== '同居').every((p) => p.x > maxX || p.x + 120 < minX))
  assert.equal(d.family.people[0].x, 0)
  const svg = diagramSvg(d, 'family')
  assert.ok(svg.includes('同居'))
  assert.ok(svg.includes('生死未確認'))
  assert.ok(!svg.includes('塗りつぶしで存命'))
})
test('saved status, apply/undo revisions and per-object summaries distinguish a proposal from confirmed data', () => {
  const d = blank(); d.family.people = [{ id: 'one', name: '一郎', sex: 'unknown', household: '不明', deceased: null, x: 0, y: 0 }]
  const value = nextDiagram('family', d, 0)
  const card: ProposalCard = { ...candidate('family.genogram', null, value), state: 'ready' }
  assert.match(diagramCardStatus(card, null, null), /未反映/)
  assert.match(diagramCardStatus({ ...card, undone: true, before: value }, value, null), /取り消し.*未保存/)
  assert.match(diagramCardStatus({ ...card, undone: true, before: value }, value, value), /確定済み/)
  assert.match(diagramCardStatus({ ...card, state: 'applied' }, value, null), /未保存/)
  assert.match(diagramCardStatus({ ...card, state: 'applied' }, value, value), /確定済み/)
  assert.match(diagramCardStatus({ ...card, state: 'applied' }, { ...value, revision: 2 }, value), /変更/)
  const action = cardAction(card, null); assert.equal(action.kind, 'set')
  const undo = cardAction({ ...card, state: 'applied' }, value); assert.equal(undo.kind, 'set')
  if (undo.kind === 'set') assert.equal(diagramSchema.parse(undo.value).revision, 2)
  assert.deepEqual(diagramChanges(null, value).map((c) => c.id), ['one'])
})
test('runChat uses existing proposal flow with verified evidence; draft context remains separate from current document', async () => {
  const d = blank(); d.family.people = [{ id: 'one', name: '一郎', sex: 'unknown', household: '同居', deceased: null, x: 0, y: 0 }]
  const after = nextDiagram('family', d, 0)
  let n = 0
  const reply = await runChat({ document: doc, recordings: [], messages: [{ role: 'user', text: '一郎と同居です。家族図に追加して' }], draft: { key: 'family.genogram', after }, model: async ({ contents }) => {
    if (n++ === 0) { assert.match(contents.at(-1)!.parts.at(-1)!.text!, /未反映案/); return [{ functionCall: { name: 'read_diagram_context', args: { field: 'family.genogram' } } }] }
    if (n === 2) {
      const response = contents.at(-1)!.parts[0].functionResponse!.response as any
      return [{ functionCall: { name: 'propose_edit', args: { key: 'family.genogram', value: JSON.stringify(after), baseRevision: 0, diagramChanges: meta(['one'], response.messages[0].id) } } }]
    }
    return [{ text: '一郎を追加する案です。' }]
  } })
  assert.equal(reply.proposals.length, 1)
  assert.equal(reply.proposals[0].evidence![0].sources[0].quote, '一郎と同居です。家族図に追加して')
  assert.equal(doc.fields['family.genogram'], undefined)
})

test('broad back pain is displayed as an area; anatomy and view mismatches are rejected by shared schema', async () => {
  const raw = { version: 1, kind: 'body', revision: 1, data: { items: [{ ...pain('back'), label: '背中が痛い', view: 'back', anatomy: { region: 'back', side: 'midline', view: 'back' } }] } }
  const value = diagramSchema.parse(normalizeBodyProposal(raw))
  assert.equal(value.kind, 'body')
  if (value.kind !== 'body') return
  assert.equal(value.data.items[0].range, 'area')
  assert.ok(value.data.items[0].width > 32 && value.data.items[0].height > 52)
  const wrong = structuredClone(value); wrong.data.items[0].view = 'front'
  assert.equal(diagramSchema.safeParse(wrong).success, false)
  const custom = structuredClone(value); custom.data.items[0] = { ...pain('custom'), anatomy: { region: 'custom', side: 'unknown', view: 'front' }, x: 700, y: 400 }
  assert.equal(diagramSchema.safeParse(custom).success, false)
  const { diagramImage } = await import('../api/diagram-image.ts')
  assert.ok((await diagramImage(value, 85, 77)).startsWith('data:image/png;base64,'))
})

test('diagram entry names the selected figure and preserves its context when the opening text is replaced', async () => {
  const { diagramChatTitle, diagramChatQuestion } = await import('../src/components/assistant/chatEntry.ts')
  assert.equal(diagramChatTitle('family.genogram'), '家族構成図の書き方を相談する')
  assert.equal(diagramChatTitle('health.bodyMap'), '身体図の書き方を相談する')
  assert.equal(diagramChatTitle(), '書き方を相談する')
  assert.equal(diagramChatQuestion('長男は別居です', 'family.genogram'), '家族構成図について：長男は別居です')
  assert.equal(diagramChatQuestion('身体図の右膝を直して', 'health.bodyMap'), '身体図の右膝を直して')
  assert.equal(diagramChatQuestion('相談内容を短くして'), '相談内容を短くして')
})


test('chat continues only the latest matching unapplied diagram, keeping edits and other figure topics safe', () => {
  const body = pendingValue()
  const card: ProposalCard = { key: 'health.bodyMap', label: '身体図', before: null, after: body, state: 'ready' }
  const entry = (p: ProposalCard) => ({ id: 1, role: 'pet' as const, text: '案', proposals: [p] })
  assert.equal(pendingDiagramDraft([entry(card)], {}, 'health.bodyMap'), card)
  assert.equal(pendingDiagramDraft([entry(card)], {}), card)
  assert.equal(pendingDiagramDraft([entry(card)], {}, 'family.genogram'), undefined)
  for (const altered of [{ ...card, superseded: true }, { ...card, undone: true }, { ...card, state: 'applied' as const }]) {
    assert.equal(pendingDiagramDraft([entry(card), entry(altered)], {}), undefined)
  }
  assert.equal(pendingDiagramDraft([entry(card)], { 'health.bodyMap': body }), undefined)
  const family = { ...card, key: 'family.genogram', label: '家族構成図' }
  assert.equal(pendingDiagramDraft([entry(card), entry(family)], {}, 'health.bodyMap'), card)
  assert.equal(pendingDiagramDraft([{ ...entry(card), proposals: [card, family] }], {}), undefined)
})

test('family proposal uses each person’s own current health, employment and death records', () => {
  const rows = [
    { name: '見本 太郎', note: '5年前に死去', livingTogether: '同居' },
    { name: '※見本 由美', health: '良好', livingTogether: '別居' },
    { name: '見本 健', employment: '会社員', livingTogether: '別居' },
    { name: '見本 春', employment: '以前は会社員', livingTogether: '別居' },
    { name: '見本 冬', deceased: false },
  ]
  const document: ChatDocument = { ...doc, fields: { 'family.members': { value: rows, by: 'cm' } }, saved: { 'family.members': { value: rows } } }
  const c = makeDiagramContext([document], [], [])
  const read = readDiagramContext(c, 'family.genogram')
  assert.ok(read.documents)
  const source = read.documents[0].fields[0].source.id
  const d = blank()
  d.family.people = rows.map((row, index) => ({
    id: String(index), name: row.name.replace(/^※/, ''), sex: 'unknown', household: index === 0 ? '同居' : '別居',
    deceased: index === 3 ? false : null, x: 0, y: 0,
  }))
  const result = prepareDiagramProposal(candidate('family.genogram', null, nextDiagram('family', d, 0)), meta(d.family.people.map((p) => p.id), source), c)
  assert.ok(typeof result !== 'string')
  const value = diagramSchema.parse(result.after)
  assert.equal(value.kind, 'family')
  assert.deepEqual(value.data.people.map((p) => p.deceased), [true, false, false, null, false])
  d.family = value.data
  for (const editing of [false, true]) {
    const svg = diagramSvg(d, 'family', { editing })
    assert.doesNotMatch(svg, /stroke-dasharray="8 5"/, 'a deceased person cannot enter the household enclosure')
    assert.match(svg, />別居・生存</)
    assert.match(svg, />別居・生死未確認</)
    assert.doesNotMatch(svg, /見本 太郎<\/text><text[^>]*>[^<]*居/)
  }
})

test('family routes never share an orthogonal segment, even with more than ten edges in one gap', () => {
  const d = blank()
  const ids = ['a', 'b', ...Array.from({ length: 12 }, (_, i) => `child-${i}`), 'grandchild']
  d.family.people = ids.map((id) => ({ id, name: id, household: '不明', sex: 'unknown', deceased: null, x: 0, y: 0 }))
  d.family.relations = [
    { id: 'spouses', kind: '離婚', source: 'a', target: 'b' },
    ...ids.slice(2, -1).flatMap((id) => (['a', 'b'].map((parent) => ({ id: parent + id, kind: '親子' as const, source: parent, target: id })))),
    { id: 'next', kind: '親子', source: 'child-0', target: 'grandchild' },
    { id: 'skip', kind: '親子', source: 'a', target: 'grandchild' },
  ]
  const people = familyLayout(d.family)
  const right = Math.max(...people.map((p) => p.x + 160))
  const layout = familyRelationPaths(people, d.family.relations, right)
  assert.equal(layout.paths.length, d.family.relations.length)
  assert.ok(layout.paths[0].divorceMark)
  assert.ok(layout.right > right)

  const segments: { axis: string, fixed: number, from: number, to: number }[] = []
  for (const { path } of layout.paths) {
    const [start, ...commands] = path.split(/ (?=[HV])/)
    let [x, y] = start.slice(1).split(' ').map(Number)
    for (const command of commands) {
      const axis = command[0], next = Number(command.slice(1))
      const [fixed, current] = axis === 'H' ? [y, x] : [x, y]
      const [from, to] = [Math.min(current, next), Math.max(current, next)]
      assert.ok(!segments.some((s) => s.axis === axis && s.fixed === fixed && Math.max(s.from, from) < Math.min(s.to, to)), path)
      segments.push({ axis, fixed, from, to })
      if (axis === 'H') x = next
      else y = next
    }
  }
})

test('family life status requires a statement about the named person in chat, recordings and notes', () => {
  const d = blank()
  d.family.people = [{ id: 'father', name: '見本 太郎', sex: 'male', household: '別居', deceased: null, x: 0, y: 0 }]
  const p = candidate('family.genogram', null, nextDiagram('family', d, 0))
  const life = (c: ReturnType<typeof context>, sourceId: string) => {
    const r = prepareDiagramProposal(p, meta(['father'], sourceId), c)
    assert.ok(typeof r !== 'string')
    const value = diagramSchema.parse(r.after)
    assert.equal(value.kind, 'family')
    return value.data.people[0].deceased
  }
  for (const text of [
    '見本太郎を図に追加。母の見本花子は亡くなりました。',
    '見本太郎の母は亡くなりました。',
    '見本太郎は亡くなった母のことを話しました。',
    '見本太郎は亡くなったかもしれません。',
    '見本太郎子さんは死亡。',
  ]) {
    const c = context(text)
    assert.equal(life(c, userSource(c)), null, text)
  }
  const confirmed = context('見本 太郎さんは5年前に亡くなりました。')
  assert.equal(life(confirmed, userSource(confirmed)), true)
  const alive = context('見本太郎は今も健在です。')
  assert.equal(life(alive, userSource(alive)), false)

  const recorded = context('録音を使ってください', [{
    recordedAt: '2026-11-20', utterances: [{ id: 'event', speaker: '本人', text: '花子が亡くなりました。' }],
  }])
  const part = readDiagramRecords(recorded, 0).parts?.[0]
  assert.ok(part)
  assert.equal(life(recorded, part.id), null)

  const document = { ...doc, fields: { 'family.members': { value: [{ name: '見本太郎', note: '母の花子が亡くなりました。' }], by: 'cm' as const } } }
  const listed = makeDiagramContext([document], [], [])
  const details = readDiagramContext(listed, 'family.genogram')
  assert.ok(details.documents)
  assert.equal(life(listed, details.documents[0].fields[0].source.id), null)
})
