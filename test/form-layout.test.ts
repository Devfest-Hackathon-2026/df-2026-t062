// 手で作った様式（forms/seed/<種類>/template.json）の欄の置き場所を確かめる。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSeed } from '../forms/admin/files.ts'

test('アセスメント p.9 の「具体的内容」: どの行も、現状の □ は左の列（見出し「現状↓」）、計画の □ は右の列（「計画↓」）にある（#119）', () => {
  const slots = readSeed('assessment').schemas.flat()
  const box = (name: string) => {
    const s = slots.find((x) => x.name === name)
    assert.ok(s, `欄がない: ${name}`)
    return s.position
  }
  const rows = [...new Set(slots.map((s) => s.name.match(/^p9_具体的内容_(.+)_(?:現状|計画)$/)?.[1]).filter((x) => x !== undefined))]
  assert.equal(rows.length, 21)
  const current = rows.map((r) => box(`p9_具体的内容_${r}_現状`))
  const plan = rows.map((r) => box(`p9_具体的内容_${r}_計画`))
  const left = Math.min(...current.map((p) => p.x))
  rows.forEach((r, i) => {
    assert.ok(Math.abs(current[i].y - plan[i].y) < 1, `${r}: 現状と計画が同じ行にない`)
    assert.equal(current[i].x, left, `${r}: 現状の □ が左の列にない`)
    assert.ok(plan[i].x > current[i].x + 2, `${r}: 計画の □ が現状の右にない`)
  })
})
