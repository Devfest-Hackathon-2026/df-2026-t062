import { seedFormDef } from '../forms/admin/files.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blank, type Item } from '../core/diagram/model.ts'
import { diagramSchema, nextDiagram, validDiagramUpdate } from '../core/diagram/fields.ts'
import { diagramSvg, roomsBehind } from '../core/diagram/svg.ts'
import { validValue } from '../core/schema.ts'
import { checkBindings, editSlot, formKeys } from '../core/binding.ts'
import { checkVersion } from '../db/forms.ts'
import { readSeed } from '../forms/admin/files.ts'
import { diagramImage } from '../api/diagram-image.ts'
import { checkProposal, type ChatDocument } from '../api/chat.ts'
import { cardAction, type ProposalCard } from '../src/components/assistant/petChat.ts'
const item = (id: string, kind: Item['kind'] = 'bed'): Item => ({ id, kind, label: 'ベッド', x: 30, y: 40, width: 120, height: 70, rotation: 0 })
const house = () => { const doc = blank(); doc.house.items.push(item('bed')); return nextDiagram('house', doc, 0) }

test('diagram values are field-specific and reject unknown properties, duplicate IDs and invalid relationships', () => {
  const value = house()
  assert.ok(validValue('housing.floorPlan', value))
  assert.equal(validValue('family.genogram', value), false)
  assert.equal(diagramSchema.safeParse({ ...value, extra: true }).success, false)
  assert.equal(diagramSchema.safeParse({ ...value, data: { ...value.data, items: [item('same'), item('same')] } }).success, false)
  const doc = blank()
  doc.family.people.push({ id: 'p', name: '本人', sex: 'unknown', household: '不明', deceased: false, x: 30, y: 30 })
  doc.family.relations.push({ id: 'r', kind: '親子', source: 'p', target: 'missing' })
  assert.throws(() => nextDiagram('family', doc, 0))
  doc.family.relations = []
  doc.family.people.push({ ...doc.family.people[0], id: 'q' })
  doc.family.relations.push({ id: 'r1', kind: '親子', source: 'p', target: 'q' }, { id: 'r2', kind: '親子', source: 'q', target: 'p' })
  assert.throws(() => nextDiagram('family', doc, 0))
})
test('revision increments for manual and AI updates; stale, wrong-kind and skipped revisions are rejected', () => {
  const value = house()
  assert.ok(validDiagramUpdate('housing.floorPlan', value, null))
  assert.equal(validDiagramUpdate('housing.floorPlan', value, value), false)
  assert.equal(validDiagramUpdate('housing.floorPlan', { ...value, revision: 3 }, value), false)
  assert.equal(validDiagramUpdate('health.bodyMap', value, null), false)
  assert.ok(validDiagramUpdate('housing.floorPlan', { ...value, revision: 2 }, value))
  assert.equal(validDiagramUpdate('housing.floorPlan', value, { ...value, data: { items: [] } }), false)
})
test('rooms render behind objects; floor-plan labels are hidden during editing and escaped in previews', () => {
  const doc = blank()
  doc.house.items = [item('bed'), item('r1', 'room'), { ...item('evil'), label: '<script>alert("x")</script>' }, item('r2', 'room')]
  assert.deepEqual(roomsBehind(doc.house.items).map((i) => i.id), ['r1', 'r2', 'bed', 'evil'])
  for (const editing of [false, true]) {
    const svg = diagramSvg(doc, 'house', { editing })
    assert.ok(svg.indexOf('data-object-id="r2"') < svg.indexOf('data-object-id="bed"'))
    assert.ok(!svg.includes('<script>'))
    if (editing) assert.doesNotMatch(svg, /<text/)
    else assert.ok(svg.includes('&lt;script&gt;'))
  }
  assert.deepEqual(doc.house.items.map((i) => i.id), ['bed', 'r1', 'evil', 'r2'])
})
test('the verified assessment adapter owns all three positions; normal text edits cannot overwrite a diagram', () => {
  const form = readSeed('assessment')
  for (const key of ['family.genogram', 'housing.floorPlan', 'health.bodyMap']) {
    assert.ok(formKeys(form.bindings).includes(key))
    const [name] = Object.entries(form.bindings).find(([, b]) => b.ref.key === key)!
    const slot = form.schemas.flat().find((s) => s.name === name)!
    assert.equal(slot.type, 'image')
    assert.ok('reason' in editSlot(form.bindings, {}, name, 'arbitrary'))
  }
  const wrong = { ...form, schemas: form.schemas.map((page) => page.map((slot) => form.bindings[slot.name]?.op === 'diagram@1' ? { ...slot, type: 'text' as const } : slot)) }
  assert.ok(checkVersion(wrong).some((message) => message.includes('image型')))
  assert.ok(checkBindings({ invalid: { op: 'diagram@1', ui: 'diagram', ref: { key: 'client.name' } } }).length)
})
test('AI proposals use the shared schema, captured baseRevision and one atomic field value', () => {
  const doc: ChatDocument = { kind: 'assessment', name: 'アセスメント', form: seedFormDef('assessment'), fields: {} }
  const value = house()
  assert.equal(typeof checkProposal({ ...doc, editableKeys: [] }, 'housing.floorPlan', value, 0), 'string')
  assert.equal(typeof checkProposal(doc, 'housing.floorPlan', value), 'string')
  assert.equal(typeof checkProposal(doc, 'housing.floorPlan', value, 1), 'string')
  const proposal = checkProposal(doc, 'housing.floorPlan', value, 0)
  assert.notEqual(typeof proposal, 'string')
  if (typeof proposal === 'string') return
  let card: ProposalCard = { ...proposal, state: 'ready' }
  let action = cardAction(card, null)
  assert.equal(action.kind, 'set')
  if (action.kind !== 'set') return
  const applied = action.value
  card = { ...card, state: action.next, after: applied }
  assert.equal(cardAction(card, { ...value, revision: 2 }).kind, 'stale')
  action = cardAction(card, applied)
  assert.equal(action.kind, 'set')
  if (action.kind !== 'set') return
  const undone = diagramSchema.parse(action.value)
  assert.equal(undone.revision, 2)
  assert.equal(undone.kind, 'house')
  if (undone.kind === 'house') assert.deepEqual(undone.data.items, [])
  assert.ok(validDiagramUpdate('housing.floorPlan', undone, applied))
  card = { ...card, state: action.next, before: undone }
  const redo = cardAction(card, undone)
  assert.equal(redo.kind, 'set')
  if (redo.kind === 'set') assert.ok(validDiagramUpdate('housing.floorPlan', redo.value, undone))
})
test('PDF rasterization embeds Japanese font and artwork without a browser or external image fetch', async () => {
  const uri = await diagramImage(house(), 80, 60)
  assert.ok(uri.startsWith('data:image/png;base64,'))
  const png = Buffer.from(uri.split(',')[1], 'base64')
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(png.length > 1000)
  const body = nextDiagram('body', blank(), 0)
  const output = await diagramImage(body, 85, 77)
  assert.ok(output.length > 3000)
})

test('screen coordinates handle zoom, letterboxing and outside drops; rotated shapes use their painted bounds', async () => {
  const { drawingPoint, contains } = await import('../core/diagram/interaction.ts')
  for (const scale of [.5, 1, 1.5, 2]) {
    const matrix = { a: scale, b: 0, c: 0, d: scale, e: 80, f: 120 }
    assert.deepEqual(drawingPoint({ x: 80 + 300 * scale, y: 120 + 200 * scale }, matrix), { x: 300, y: 200 })
    assert.equal(drawingPoint({ x: 79, y: 130 }, matrix), null)
    assert.equal(drawingPoint({ x: 81, y: 121 + 560 * scale }, matrix), null)
  }
  assert.equal(drawingPoint({ x: 0, y: 0 }, { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }), null)
  assert.ok(contains({ ...item('rotated'), rotation: 90 }, { x: 0, y: 90 }))
  assert.equal(contains({ ...item('rotated'), rotation: 90 }, { x: 100, y: 50 }), false)
})

test('floor-plan corner resize keeps the opposite corner fixed and clamps each axis to the canvas', async () => {
  const { resizeItem } = await import('../core/diagram/interaction.ts')
  const box = item('bed')
  assert.deepEqual(resizeItem(box, 'nw', { x: -100, y: 15 }), { x: 0, y: 55, width: 150, height: 55 })
  assert.deepEqual(resizeItem(box, 'ne', { x: 20, y: -10 }), { x: 30, y: 30, width: 140, height: 80 })
  assert.deepEqual(resizeItem(box, 'se', { x: -200, y: 15 }), { x: 30, y: 40, width: 20, height: 85 })
  assert.deepEqual(resizeItem(box, 'sw', { x: 10, y: 1000 }), { x: 40, y: 40, width: 110, height: 520 })
  const rotated = resizeItem({ ...box, x: 150, rotation: 90 }, 'nw', { x: 12, y: -20 })
  for (const [key, value] of Object.entries({ x: 162, y: 20, width: 140, height: 82 })) {
    assert.ok(Math.abs(rotated[key as keyof typeof rotated] - value) < 1e-8, key)
  }
  const doc = blank()
  doc.house.items.push(box)
  assert.equal((diagramSvg(doc, 'house', { editing: true, selected: box.id }).match(/data-resize-corner=/g) ?? []).length, 4)
  assert.doesNotMatch(diagramSvg(doc, 'house'), /data-resize-corner=/)
})

test('drawn walls snap to 45-degree increments and stay inside the canvas', async () => {
  const { contains, moveHouseItem, rotateHouseItem, lineGeometry } = await import('../core/diagram/interaction.ts')
  const doc = blank()
  const start = { x: 0, y: 0 }
  const { geometry, end } = lineGeometry(start, { x: 820, y: 560 })
  const wall: Item = { id: 'diagonal', kind: 'wall', label: '壁', ...geometry, wallLine: true }
  assert.equal(wall.rotation, 45)
  assert.ok(Math.abs(end.x - 560) < 1e-8 && Math.abs(end.y - 560) < 1e-8)
  for (const [x, y, rotation] of [[80, 20, 0], [70, 60, 45], [20, 80, 90], [-60, 70, 135], [-80, 20, 180], [-70, -60, -135], [-20, -80, -90], [60, -70, -45]]) {
    assert.equal(lineGeometry({ x: 200, y: 200 }, { x: 200 + x, y: 200 + y }).geometry.rotation, rotation)
  }
  const rail: Item = { id: 'drawn-rail', kind: 'rail', label: '手すり', ...lineGeometry({ x: 0, y: 100 }, { x: 820, y: 90 }).geometry, railLine: true }
  doc.house.items.push(wall, rail, item('legacy-wall', 'wall'), item('legacy-rail', 'rail'))
  assert.ok(validValue('housing.floorPlan', nextDiagram('house', doc, 0)))
  assert.ok(contains(wall, { x: 280, y: 280 }))
  assert.equal(contains(wall, { x: 280, y: 310 }), false)
  const moved = moveHouseItem(wall, { x: 150, y: 150 })
  assert.ok(Math.abs(moved.x - 150) < 1e-8 && Math.abs(moved.y) < 1e-8)
  assert.match(diagramSvg(doc, 'house'), /data-object-id="diagonal"[^>]*><line/)
  assert.match(diagramSvg(doc, 'house'), /data-object-id="legacy-wall"[^>]*><rect/)
  assert.match(diagramSvg(doc, 'house'), /data-object-id="drawn-rail"[^>]*><line/)
  assert.match(diagramSvg(doc, 'house'), /data-object-id="legacy-rail"[^>]*><g/)
  assert.doesNotMatch(diagramSvg(doc, 'house', { editing: true, selected: rail.id }), /data-resize-corner=/)
  assert.ok(contains(rail, { x: 410, y: 100 }))
  assert.equal(moveHouseItem(rail, { x: 20, y: 30 }).x, 0)
  const rotated = rotateHouseItem(item('bed'))!
  assert.equal(rotated.rotation, 90)
  assert.ok(Math.abs(rotated.x - 125) < 1e-8 && Math.abs(rotated.y - 15) < 1e-8)
})

test('resizing a drawn line moves only the grabbed endpoint and snaps to 45 degrees', async () => {
  const { lineEnd, resizeLine } = await import('../core/diagram/interaction.ts')
  const rail: Item = { ...item('rail', 'rail'), x: 100, y: 100, width: 100, railLine: true }
  const lengthened = resizeLine(rail, 'end', { x: 46, y: 32 })!
  assert.equal(lengthened.rotation, 0)
  assert.deepEqual({ x: lengthened.x, y: lengthened.y }, { x: 100, y: 100 })
  assert.deepEqual(lineEnd(lengthened), { x: 246, y: 100 })
  const angled = resizeLine(rail, 'start', { x: 30, y: 66 })!
  const fixed = lineEnd(angled)
  assert.ok(Math.abs(fixed.x - 200) < 1e-8 && Math.abs(fixed.y - 100) < 1e-8)
  assert.equal(angled.rotation % 45, 0)
  assert.equal(resizeLine(rail, 'end', { x: -100, y: 0 }), undefined)
  const doc = blank()
  doc.house.items.push(rail)
  const handles = diagramSvg(doc, 'house', { editing: true, selected: rail.id })
  assert.match(handles, /data-line-endpoint="start"/)
  assert.match(handles, /data-line-endpoint="end"/)
  assert.doesNotMatch(diagramSvg(doc, 'house'), /data-line-endpoint=/)
})

test('floor-plan steps render as fixed-size triangular markers without resize handles', () => {
  const doc = blank()
  doc.house.items.push({ ...item('step', 'step'), label: '段差', stepHeightCm: 15 })
  const svg = diagramSvg(doc, 'house', { editing: true, selected: 'step' })
  assert.match(svg, /<polygon points="60,17 78,53 42,53"/)
  assert.doesNotMatch(svg, /段差|data-resize-corner/)
})

test('doorways, toilets and bathtubs are valid floor-plan items with distinct symbols', () => {
  const doc = blank()
  doc.house.items.push(item('door', 'door'), item('toilet', 'toilet'), item('bath', 'bathtub'))
  assert.ok(validValue('housing.floorPlan', nextDiagram('house', doc, 0)))
  const svg = diagramSvg(doc, 'house', { editing: true })
  assert.match(svg, /data-object-id="door"[^>]*><path/)
  assert.match(svg, /data-object-id="toilet"[^>]*><g[^>]*>\s*<ellipse/)
  assert.match(svg, /data-object-id="bath"[^>]*><g[^>]*>\s*<rect/)
  assert.doesNotMatch(svg, /<text/)
  doc.body.items.push(item('body-toilet', 'toilet'))
  assert.equal(validValue('health.bodyMap', { version: 1, kind: 'body', revision: 1, data: doc.body }), false)
})

test('saved diagram values generate a PDF with the normal export pipeline; empty slots remain printable', async () => {
  const { BLANK_PDF } = await import('@pdfme/common')
  const { createHash } = await import('node:crypto')
  const { makePdf } = await import('../api/pdf.ts')
  const { LocalStorage } = await import('../api/storage.ts')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { basePdfPath } = await import('../db/forms.ts')
  const base = Buffer.from(BLANK_PDF.split(',').pop()!, 'base64')
  const folder = await mkdtemp(join(tmpdir(), 'diagram-pdf-'))
  const storage = new LocalStorage(folder)
  const version = { id: 'diagram-export-test', templateId: 'test', officeId: null, kind: 'assessment', name: 'test', title: 'test', version: 1, status: 'published' as const, contentSha: 'test', basePdfSha256: createHash('sha256').update(base).digest('hex'), localFields: [], pages: [{ no: 1, pdfIndex: 0, title: 'test', width: 210, height: 297 }], schemas: [[{ name: 'house', type: 'image' as const, position: { x: 20, y: 20 }, width: 80, height: 60 }]], bindings: { house: { op: 'diagram@1' as const, ui: 'diagram' as const, ref: { key: 'housing.floorPlan' } } } }
  try {
    await storage.writeOnce('forms', basePdfPath(version), base, 'application/pdf')
    const empty = await makePdf(storage, version, {})
    const filled = await makePdf(storage, version, { 'housing.floorPlan': house() })
    assert.equal(Buffer.from(filled).subarray(0, 4).toString(), '%PDF')
    assert.ok(filled.length > empty.length + 1000)
    const {fourPersonFamily}=await import('./fixtures/family-layout.ts')
    const family=nextDiagram('family',fourPersonFamily(),0)
    const familyVersion={...version,id:'family-export-test',bindings:{house:{op:'diagram@1' as const,ui:'diagram' as const,ref:{key:'family.genogram'}}}}
    const familyPdf=await makePdf(storage,familyVersion,{'family.genogram':family})
    assert.equal(Buffer.from(familyPdf).subarray(0,4).toString(),'%PDF')
    const uri=await diagramImage(family,80,60),png=Buffer.from(uri.split(',')[1],'base64')
    assert.equal(png.readUInt32BE(16),960,'家族図は約300dpiで氏名を印字する')
    assert.equal(png.readUInt32BE(20),720)
  } finally { await rm(folder, { recursive: true, force: true }) }
})
test('body map labels of nearby marks are stacked so long labels do not overlap (#198)', () => {
  const doc = blank()
  const knee = (id: string, x: number, side: string): Item => ({ id, kind: 'disability', label: `変形性膝関節症（${side}）`, x, y: 400, width: 40, height: 40, rotation: 0, view: 'front' } as Item)
  doc.body.items = [knee('a', 140, '右膝'), knee('b', 175, '左膝'), knee('far', 600, '右肩')]
  const svg = diagramSvg(doc, 'body')
  const labelY = (id: string) => Number(svg.match(new RegExp(`data-object-id="${id}"[^>]*>(?:<text[^>]*>[^<]*</text>)<text x="[^"]*" y="([^"]*)"`))![1])
  assert.ok(Math.abs(labelY('a') - labelY('b')) >= 17, 'labels of marks 35px apart must not share a line')
  assert.equal(labelY('far'), labelY('a'), 'a mark far away keeps the default label position')
})

test('4人家族は夫婦を水平に結び、両親が共通の子2人へ1本の兄弟線で分岐する',async()=>{
 const {fourPersonFamily}=await import('./fixtures/family-layout.ts')
 const {familyLayout,familyRelationPaths}=await import('../core/diagram/family-layout.ts')
 const d=fourPersonFamily(),people=familyLayout(d.family),routes=familyRelationPaths(people,d.family.relations,820)
 const couple=routes.paths.find(p=>p.kind==='partner')!, parent=routes.paths.find(p=>p.kind==='parent')!
 assert.match(couple.path,/^M[-\d.]+ [-\d.]+ H[-\d.]+$/,'夫婦線に上方迂回がない')
 assert.equal(routes.paths.length,2)
 assert.deepEqual(parent.parents,['father','mother'])
 assert.deepEqual(parent.children,['daughter','son'])
 assert.equal(parent.relationIds.length,4,'両親ごとの親子の意味は落とさず、描画を統合する')
 assert.equal(couple.divorceMark,undefined,'婚姻を離婚に変えない')
})

/** M/H/Vの実線分。複数のMで分かれた共有幹線・兄弟線・子への枝も検査する。 */
function familySegments(path:string) {
 const segments:{x:number;y:number;xx:number;yy:number}[]=[]
 let x=0,y=0
 for(const match of path.matchAll(/M(-?[\d.]+) (-?[\d.]+)|H(-?[\d.]+)|V(-?[\d.]+)/g)) {
   if(match[1]!==undefined){x=Number(match[1]);y=Number(match[2]);continue}
   const xx=match[3]===undefined?x:Number(match[3]), yy=match[4]===undefined?y:Number(match[4])
   segments.push({x,y,xx,yy});x=xx;y=yy
 }
 return segments
}
test('家族図の例外群: 登録関係を過不足なく描画し、記号・ラベルを横断せず、入力順でも変わらない',async()=>{
 const {familyFixtures}=await import('./fixtures/family-layout.ts')
 const {familyLayout,familyRelationPaths,familyPersonBounds,familyHouseholds}=await import('../core/diagram/family-layout.ts')
 for(const [name,doc] of Object.entries(familyFixtures())) {
   const before=JSON.stringify(doc),people=familyLayout(doc.family),layout=familyRelationPaths(people,doc.family.relations,Math.max(820,...people.map(p=>familyPersonBounds(p).right+40)))
   assert.deepEqual(layout.paths.flatMap(p=>p.relationIds).sort(),doc.family.relations.map(r=>r.id).sort(),name)
   for(const path of layout.paths.filter(p=>p.kind==='parent'))for(const child of path.children!) {
     const actual=doc.family.relations.filter(r=>r.kind==='親子'&&r.target===child).map(r=>r.source).sort()
     assert.deepEqual(path.parents,actual,`${name}/${child}: 親の集合を推測しない`)
   }
   if(name==='unmarried'||name==='single')assert.equal(layout.paths.filter(p=>p.kind==='partner').length,0)
   for(const route of layout.paths)for(const seg of familySegments(route.path))for(const p of people) {
     const b=familyPersonBounds(p),boxes=[{left:b.left,right:b.right,top:p.y+78,bottom:b.bottom},{left:p.x+33,right:p.x+87,top:p.y+5,bottom:p.y+59}]
     for(const box of boxes)assert.ok(!(seg.y===seg.yy?seg.y>box.top&&seg.y<box.bottom&&Math.max(seg.x,seg.xx)>box.left&&Math.min(seg.x,seg.xx)<box.right:seg.x>box.left&&seg.x<box.right&&Math.max(seg.y,seg.yy)>box.top&&Math.min(seg.y,seg.yy)<box.bottom),`${name}/${p.id}: ${route.path}`)
   }
   for(const box of familyHouseholds(people)) {
     assert.ok(box.people.every(id=>people.find(p=>p.id===id)!.household==='同居'&&people.find(p=>p.id===id)!.deceased!==true))
     for(const p of people.filter(p=>!box.people.includes(p.id))){const b=familyPersonBounds(p);assert.ok(b.right<box.x||b.left>box.x+box.width||b.bottom<box.y||b.top>box.y+box.height,`${name}: 同居枠に別の人物を巻き込まない`)}
   }
   const svg=diagramSvg(doc,'family')
   const reversed={...doc,family:{people:[...doc.family.people].reverse(),relations:[...doc.family.relations].reverse()}}
   assert.equal(diagramSvg(reversed,'family'),svg,`${name}: 配列順で図が変わらない`)
   assert.equal(JSON.stringify(doc),before,'保存データは書き換えない')
 }
})
