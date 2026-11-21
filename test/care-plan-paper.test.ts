import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { officialPlanPages } from '../src/care-plan/paper.ts'
import type { FormDef } from '../core/form.ts'
import { pagesOf } from '../src/form/layout.ts'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const form = (no: number) => {
  const root = new URL(`../forms/seed/care_plan_${no}/`, import.meta.url)
  const meta = JSON.parse(readFileSync(new URL('form.json', root), 'utf8'))
  const template = JSON.parse(readFileSync(new URL('template.json', root), 'utf8'))
  return { ...meta, id: `official-test-${no}`, schemas: template.schemas, bindings: JSON.parse(readFileSync(new URL('bindings.json', root), 'utf8')) } as FormDef
}
test('第2表は公式様式の行座標を使い、続きも同じ原紙を使用する', () => {
  const needs = Array.from({ length: 6 }, (_, i) => ({ need: `課題${i}`, longGoal: { goal: '長期目標' }, shortGoals: [] }))
  const pages = officialPlanPages(form(2), {}, needs, [])
  assert.equal(pages.length, 2)
  assert.ok(pages.every((p) => p.sourceIndex === 0))
  assert.equal(pages[0].input['ニーズ__row0'], '課題0')
  assert.equal(pages[1].input['ニーズ__row0'], '課題5')
})
test('第2・3表の画面は公式原紙画像を使い、独自の表や週間グリッドを作らない', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  try {
    const { OfficialPlanSheet } = await server.ssrLoadModule('/src/care-plan/OfficialPlanSheet.tsx')
    for (const no of [2, 3]) {
      const definition = form(no)
      const image = `https://example.invalid/official-care-plan-${no}.png`
      const state = {
        form: definition, pages: pagesOf(definition), current: {}, marks: new Map(), reasons: new Map(),
        imageOf: () => image, display: () => '', diffOf: () => undefined,
      }
      const html = renderToStaticMarkup(createElement(OfficialPlanSheet, {
        state, needs: [], slots: [], touch: false, busy: false, readOnly: false, zoom: 100, changed: false, aiChanged: false,
        onNeed: () => {}, onSchedule: () => {}, onActivities: () => {},
      }))
      assert.ok(html.includes(`src="${image}"`))
      assert.doesNotMatch(html, /<table|cp-week|cp-day|cp-hours/)
      assert.match(html, /class="pg"/)
      assert.match(html, /cp-paper-field/)
    }
  } finally { await server.close() }
})
test('第3表は公式様式の週間枠と生活活動欄に展開し、未完成の予定を消さない', () => {
  const pages = officialPlanPages(form(3), { dailySchedule: [{ time: '7', rhythm: '起床' }] }, [], [
    { serviceId: '', scheduleType: 'weekly', weekday: 1, start: '09:00', end: '10:00' },
    { serviceId: '', scheduleType: 'weekly', weekday: 2, start: '', end: '' },
  ])
  assert.ok(pages[0].schemas.some((s) => s.name.startsWith('週間枠__slot')))
  assert.ok(Object.values(pages[0].input).some((v) => v.includes('起床')))
  assert.equal(pages[0].sourceIndex, 0)
})
