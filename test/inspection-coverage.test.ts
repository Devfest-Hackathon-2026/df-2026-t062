import assert from 'node:assert/strict'
import {test} from 'node:test'
import {checkSet,DEFAULT_CHECK_SET} from '../core/checks/index.ts'
import {inspectionCoverage} from '../core/checks/coverage.ts'
const set=checkSet(DEFAULT_CHECK_SET)
test('点検しない項目を重複せず、対象外・書類なし・書類だけで判断できないものに分ける',()=>{
 const coverage=inspectionCoverage(set,new Set(['care_plan_2']),new Set(['care_plan_1','care_plan_2','assessment']),new Map([['35','2'],['36',null]]))
 assert.equal(coverage.applicable,9);assert.equal(coverage.evaluated,1);assert.equal(coverage.unjudged,8);assert.equal(coverage.uninspected,53)
 assert.equal(coverage.groups.reduce((sum,g)=>sum+g.count,0),53)
 assert.equal(coverage.groups.find(g=>g.kinds.includes('assessment'))?.reason,'outside_scope')
 assert.equal(coverage.groups.find(g=>g.kinds.includes('care_plan_4'))?.reason,'missing_document')
 assert.equal(coverage.groups.find(g=>!g.kinds.length)?.count,2)
 const all=inspectionCoverage(set,new Set(set.items.flatMap(i=>i.docs)),new Set())
 assert.equal(all.applicable,60);assert.equal(all.uninspected,2)
})
