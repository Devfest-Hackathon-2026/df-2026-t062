/** 記録の構造・予定対応・使用量だけを再計算する。文章の正確さは人の照合が必要。通信しない。 */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const dir = resolve(process.argv[2] ?? 'eval/care-plan-real-gemini/results')
const rows: { key: string, responseId: string, startedAt: string, promptSha256: string, apiMs: number, input: number, visibleOutput: number, thoughts: number, total: number, estimatedUsd: number, services: number, slots: number }[] = []
let services = 0, slots = 0
for (const id of 'ABCDEF') for (let repeat = 1; repeat <= 2; repeat++) {
  const key = `${id}${repeat}`
  const r = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'))
  assert.equal(r.synthetic, true)
  assert.equal(r.environment.provider, 'vertex')
  assert.ok(r.captured.responseId)
  assert.deepEqual(r.captured.finishReasons, ['STOP'])
  assert.equal(r.generated.status, 201)
  assert.equal(r.generated.draft.status, 'proposed')
  assert.equal(r.adopted.status, 200)
  for (const [name, value] of Object.entries(r.checks)) assert.equal(value, true, `${key}: ${name}`)
  const raw = JSON.parse(r.captured.text)
  assert.deepEqual(raw, r.generated.draft.proposal)
  const expected = r.expected.slots.map((s: any) => `${s.weekday}|${s.start}|${s.end}`).sort()
  const actual = raw.slots.map((s: any) => `${s.weekday}|${s.start}|${s.end}`).sort()
  assert.deepEqual(actual, expected, `${key}: weekday/time`)
  for (const slot of raw.slots) {
    const ref = slot.serviceRef
    const service = raw.needs[ref.need].shortGoals[ref.shortGoal].services[ref.service]
    const gold = r.expected.slots.find((s: any) => s.weekday === slot.weekday)
    assert.ok(service.content.includes(gold.service), `${key}: serviceRef`)
    const persisted = r.persisted.slots.find((s: any) => s.weekday === slot.weekday && s.start === slot.start && s.end === slot.end)
    const savedServices = r.persisted.needs.flatMap((n: any) => n.shortGoals.flatMap((g: any) => g.services))
    assert.ok(savedServices.some((s: any) => s.id === persisted?.serviceId && s.content === service.content), `${key}: saved reference`)
    assert.equal(slot.endsNextDay, false)
  }
  if (r.expected.emptyProposalExpected) {
    assert.ok(Object.values(raw.plan1).every((s) => s === ''))
    assert.deepEqual(raw.needs, [])
  }
  if (r.expected.conflictsRequired) assert.ok(raw.conflicts.length > 0)
  const serviceCount = raw.needs.flatMap((n: any) => n.shortGoals.flatMap((g: any) => g.services)).length
  services += serviceCount; slots += raw.slots.length
  const u = r.captured.usage
  const input = u.promptTokenCount, visibleOutput = u.candidatesTokenCount, thoughts = u.thoughtsTokenCount ?? 0
  assert.equal(u.totalTokenCount, input + visibleOutput + thoughts)
  rows.push({ key, responseId: r.captured.responseId, startedAt: r.captured.startedAt, promptSha256: r.captured.promptSha256,
    apiMs: r.generated.elapsedMs, input, visibleOutput, thoughts, total: u.totalTokenCount,
    estimatedUsd: (input * .75 + (visibleOutput + thoughts) * 3.75) / 1e6, services: serviceCount, slots: raw.slots.length })
}
for (let i = 0; i < rows.length; i += 2) assert.equal(rows[i].promptSha256, rows[i + 1].promptSha256, rows[i].key)
assert.equal(new Set(rows.map((r) => r.responseId)).size, 12)
const ledger = JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8'))
assert.equal(ledger.sent, 12)
assert.deepEqual(ledger.caseKeys, rows.map((r) => r.key))
const sum = (key: 'input' | 'visibleOutput' | 'thoughts' | 'total' | 'apiMs' | 'estimatedUsd') => rows.reduce((n, r) => n + r[key], 0)
const summary = { calls: 12, services, slots, input: sum('input'), visibleOutput: sum('visibleOutput'), thoughts: sum('thoughts'),
  total: sum('total'), estimatedUsd: Number(sum('estimatedUsd').toFixed(8)), apiMs: { min: Math.min(...rows.map((r) => r.apiMs)), max: Math.max(...rows.map((r) => r.apiMs)), mean: sum('apiMs') / 12 },
  pricing: { checkedOn: '2026-11-22', currency: 'USD', inputPerMillion: .75, outputIncludingReasoningPerMillion: 3.75, source: 'https://cloud.google.com/model-garden/pricing' }, rows }
await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
