import type { Doc, Person } from './model.ts'
/** Semantic layout: co-residents occupy their own lane; outside/unknown people never enter its box. */
export function familyLayout(family: Doc['family']) {
  const people = [...family.people].sort((a, b) => a.id.localeCompare(b.id))
  const parent = new Map(people.map((p) => [p.id, p.id]))
  const root = (id: string): string => parent.get(id) === id ? id : root(parent.get(id)!)
  for (const r of family.relations.filter((r) => r.kind === '婚姻' || r.kind === '離婚')) {
    if (parent.has(r.source) && parent.has(r.target)) parent.set(root(r.target), root(r.source))
  }
  const levels = new Map<string, number>()
  const visiting = new Set<string>()
  function level(id: string): number {
    const group = root(id)
    if (levels.has(group)) return levels.get(group)!
    if (visiting.has(group)) return 0
    visiting.add(group)
    const ancestors = family.relations.filter((r) => r.kind === '親子' && root(r.target) === group && root(r.source) !== group)
    const n = Math.max(0, ...ancestors.map((r) => level(r.source) + 1))
    visiting.delete(group); levels.set(group, n); return n
  }
  const groupBy = (co: boolean) => {
    const rows = new Map<number, Person[]>()
    for (const p of people.filter((p) => (p.household === '同居') === co)) {
      const n = level(p.id); rows.set(n, [...(rows.get(n) ?? []), p])
    }
    return rows
  }
  const home = groupBy(true), away = groupBy(false)
  const homeWidth = Math.max(1, ...[...home.values()].map((row) => row.length)) * 170
  const placed = new Map<string, Person>()
  for (const [co, rows] of [[true, home], [false, away]] as const) for (const [level, row] of rows) row.forEach((p, i) => {
    placed.set(p.id, { ...p, x: (co ? 50 : home.size ? homeWidth + 150 : 50) + i * 170, y: 65 + level * 210 })
  })
  return people.map((p) => placed.get(p.id)!)
}
