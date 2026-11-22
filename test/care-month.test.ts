import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expandMonth, mergeMonthGeneration, copyMonth, monthCounts, type MonthEntry, type ConfirmedSchedule } from '../core/care-month.ts'
const snapshot = (weekday = 4): ConfirmedSchedule => ({ schemaVersion: 1, plan: { id: 'plan1', clientId: 'client1', effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' }, services: [{ serviceId: 'service1', content: '架空の訪問介護', serviceKind: '訪問介護', provider: '架空事業所', insured: true, periodFrom: null, periodTo: null, weekly: [{ slotId: 'slot1', weekday, start: '09:00', end: '10:00', endsNextDay: false, periodFrom: null, periodTo: null }], other: [] }] })
test('月間展開: 閏年2月、月末、曜日をJSTの暦日で展開し、休日を推測しない', () => {
 const r = expandMonth('2024-02', 'confirmation1', snapshot())
 assert.deepEqual(r.entries.map(e => e.plan.date), ['2024-02-01','2024-02-08','2024-02-15','2024-02-22','2024-02-29'])
 assert.ok(r.entries.every(e => e.actual === null && e.serviceId === 'service1' && e.slotId === 'slot1'))
 assert.deepEqual(expandMonth('2024-02', 'confirmation1', snapshot()), r)
 assert.throws(() => expandMonth('2024-13', 'confirmation1', snapshot()))
 assert.throws(() => expandMonth('2024-2', 'confirmation1', snapshot()))
 const ordinary = snapshot(); ordinary.plan.effectiveTo = null
 assert.equal(expandMonth('2025-02', 'confirmation1', ordinary).entries.length, 4)
})
test('計画・サービス・枠の適用期間は優先上書きせず全ての積集合。週外予定を勝手に展開しない', () => {
 const s = snapshot(); s.plan.effectiveFrom = '2024-02-05'; s.plan.effectiveTo = '2024-02-25'
 s.services[0].periodFrom = '2024-02-10'; s.services[0].periodTo = '2024-03-01'
 s.services[0].weekly[0].periodFrom = '2024-01-01'; s.services[0].weekly[0].periodTo = '2024-02-20'
 s.services[0].other = [{ slotId: 'other', note: '受診時に調整', periodFrom: null, periodTo: null }]
 const r = expandMonth('2024-02','confirmation1',s)
 assert.deepEqual(r.entries.map(e => e.plan.date), ['2024-02-15'])
 assert.deepEqual(r.unexpanded.map(e => e.slotId), ['other'])
})
test('月末・年末の跨日は開始日の月へ所属し、終了日と時刻を落とさない。同日時の別枠は別ID', () => {
 const s = snapshot(2); s.services[0].weekly[0] = { ...s.services[0].weekly[0], start: '23:00', end: '01:00', endsNextDay: true }
 s.services[0].weekly.push({ ...s.services[0].weekly[0], slotId: 'slot2' })
 const r = expandMonth('2024-12','confirmation1',s)
 assert.equal(r.entries.length,10)
 assert.equal(r.entries.at(-1)!.plan.date,'2024-12-31')
 assert.equal(r.entries.at(-1)!.plan.endDate,'2025-01-01')
 assert.notEqual(r.entries[0].sourceKey,r.entries[1].sourceKey)
 assert.throws(() => expandMonth('2024-12','confirmation1',{ ...s, services:[{ ...s.services[0], weekly:[{...s.services[0].weekly[0], endsNextDay:false}] }] }))
})
test('再生成: 人の変更・取消・実績を保持し、消える原予定も自動削除しない。再送は差分なし', () => {
 const generated = expandMonth('2024-02','c1',snapshot()).entries
 const current: MonthEntry[] = structuredClone(generated)
 current[0].plan.start = '11:00'; current[0].plan.end = '12:00'; current[0].plan.status = 'cancelled'
 current[0].actual = { status:'not_provided', date:null, start:null, end:null, endDate:null, note:'本人希望で中止' }
 const s = snapshot(); s.services[0].weekly[0].periodFrom = '2024-02-10'
 const merged = mergeMonthGeneration(current,expandMonth('2024-02','c1',s).entries)
 assert.deepEqual(merged.entries,current)
 assert.deepEqual(merged.removed.map(e=>e.sourceKey),generated.slice(0,2).map(e=>e.sourceKey))
 assert.equal(mergeMonthGeneration(current,generated).added.length,0)
 assert.deepEqual(monthCounts(current),{ planned:4, actual:0, notProvided:1, unentered:4 })
})
test('前月コピーは日番号を明示的に保持し、存在しない日を保留する。実績をコピーせず既存月へ上書きしない', () => {
 const source = expandMonth('2024-01','c1',snapshot(3)).entries
 const r = copyMonth(source,'2024-02',[])
 assert.equal(r.skipped.length,1,'1月31日は2月へ丸めない')
 assert.deepEqual(r.entries.map(e=>e.plan.date),['2024-02-03','2024-02-10','2024-02-17','2024-02-24'])
 assert.ok(r.entries.every(e=>e.actual===null && e.sourceKey===null))
 const existing = expandMonth('2024-02','c1',snapshot()).entries
 assert.deepEqual(copyMonth(source,'2024-02',existing).entries.slice(0,existing.length),existing)
 assert.throws(()=>copyMonth(source,'2024-03',existing))
})

test('不正な確定入力、重複ID、週次の時刻・期間の逆転は予定を作らず失敗する', () => {
 const duplicate=snapshot(); duplicate.services.push(structuredClone(duplicate.services[0]))
 assert.throws(()=>expandMonth('2024-02','c1',duplicate))
 const invalid=snapshot(); invalid.services[0].weekly[0].start='24:00'
 assert.throws(()=>expandMonth('2024-02','c1',invalid))
 const reversed=snapshot(); reversed.plan.effectiveTo='2023-12-31'
 assert.throws(()=>expandMonth('2024-02','c1',reversed))
})

import { careMonthPrint } from '../core/care-month-print.ts'
import { expandPrintLayout } from '../core/print-layout.ts'
import { readSeed } from '../forms/admin/files.ts'
test('第6表の印字は予定と未入力・未実施を分け、長文・実績時刻・補足・安定IDを明細から落とさない',()=>{
 const expanded=expandMonth('2024-02','c1',snapshot()),entries=expanded.entries
 entries[0].plan.status='cancelled';entries[0].actual={status:'not_provided',date:null,start:null,end:null,endDate:null,note:'本人希望で中止'}
 entries[1].content='長いサービス名'.repeat(200);entries[1].plan.note='長い補足'.repeat(500)
 const month={id:'m',clientId:'client1',planId:'plan1',planVersion:1,confirmationId:'c1',sourceHash:'hash',month:'2024-02',documentId:'d',lockVersion:1,revision:1,services:[],entries,unexpanded:[]}
 const projected=careMonthPrint(month),rows=projected['monthly.printRows']
 assert.equal(rows[0].p1,'×');assert.equal(rows[0].a1,'0');assert.equal(rows[2].totalActual,'')
 assert.match(projected['monthly.details'],/本人希望で中止/)
 assert.equal(projected['monthly.weekdays'][0].label,'木')
 const pages=expandPrintLayout(readSeed('care_plan_6'),projected)
 const text=pages.filter(p=>p.sourceIndex===1).map(p=>p.input['明細']).join('').replaceAll('\n','')
 assert.ok(text.includes(entries[1].content));assert.ok(text.includes(entries[1].plan.note));assert.ok(text.includes(entries[1].id));assert.ok(pages.length>2)
})

import { monthOverlaps } from '../core/care-month.ts'
test('同じサービスの重複は跨日も検出し、接する予定や取消・別サービスを重複扱いしない',()=>{
 const a=expandMonth('2024-02','c1',snapshot()).entries[0],b=structuredClone(a),c=structuredClone(a)
 a.plan={...a.plan,date:'2024-02-01',start:'23:30',end:'01:00',endDate:'2024-02-02'}
 b.id='b';b.plan={...b.plan,date:'2024-02-02',start:'00:30',end:'01:30',endDate:'2024-02-02'}
 c.id='c';c.plan={...c.plan,date:'2024-02-02',start:'01:30',end:'02:30',endDate:'2024-02-02'}
 assert.deepEqual(monthOverlaps([a,b,c]),new Set([a.id,b.id]))
 b.plan.status='cancelled';assert.equal(monthOverlaps([a,b,c]).size,0)
 b.plan.status='scheduled';b.serviceId='other';assert.equal(monthOverlaps([a,b,c]).size,0)
})
