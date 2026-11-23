import type { Doc, Person, Relation } from './model.ts'
export const livesInHousehold = (person: Person) => person.deceased !== true && person.household === '同居'
const generationGap = 210
const laneSpacing = 9

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
    for (const p of people.filter((p) => livesInHousehold(p) === co)) {
      const n = level(p.id); rows.set(n, [...(rows.get(n) ?? []), p])
    }
    return rows
  }
  const generations = new Map(people.map((p) => [p.id, level(p.id)]))
  const laneCounts = new Map<string, number>()
  function count(row: number, side: 'above' | 'below') {
    const key = `${row}:${side}`
    laneCounts.set(key, (laneCounts.get(key) ?? 0) + 1)
  }
  for (const r of family.relations) {
    const from = generations.get(r.source), to = generations.get(r.target)
    if (from === undefined || to === undefined) continue
    count(from, r.kind === '親子' ? 'below' : 'above')
    if (r.kind === '親子' ? to !== from + 1 : to !== from) count(to, 'above')
  }
  const rowY = [Math.max(65, 45 + (laneCounts.get('0:above') ?? 0) * laneSpacing)]
  for (let row = 1; row <= Math.max(0, ...generations.values()); row++) {
    const lanes = (laneCounts.get(`${row - 1}:below`) ?? 0) + (laneCounts.get(`${row}:above`) ?? 0)
    rowY.push(rowY[row - 1] + Math.max(generationGap, 170 + lanes * laneSpacing))
  }

  const home = groupBy(true), away = groupBy(false)
  const homeWidth = Math.max(1, ...[...home.values()].map((row) => row.length)) * 170
  const placed = new Map<string, Person>()
  for (const [co, rows] of [[true, home], [false, away]] as const) for (const [level, row] of rows) row.forEach((p, i) => {
    placed.set(p.id, { ...p, x: (co ? 50 : home.size ? homeWidth + 150 : 50) + i * 170, y: rowY[level] })
  })
  return people.map((p) => placed.get(p.id)!)
}

interface RelationPath {
  path: string
  divorceMark?: { x: number, y: number }
}

export function familyRelationPaths(people: Person[], relations: Relation[], right: number) {
  const positions = new Map(people.map((p) => [p.id, p]))
  const rows = [...new Set(people.map((p) => p.y))].sort((a, b) => a - b)
  const edges = relations.flatMap((r) => {
    const a = positions.get(r.source), b = positions.get(r.target)
    return a && b ? [{ r, a, b }] : []
  })
  const bottomCount = new Map<string, number>(), topCount = new Map<string, number>()
  for (const { r, a, b } of edges) {
    const counts = r.kind === '親子' ? bottomCount : topCount
    counts.set(a.id, (counts.get(a.id) ?? 0) + 1)
    topCount.set(b.id, (topCount.get(b.id) ?? 0) + 1)
  }

  // Top and bottom ports occupy separate x ranges, including on vertically aligned people.
  const usedPorts = new Map<string, number>()
  function port(person: Person, bottom: boolean) {
    const key = `${person.id}:${bottom}`
    const index = (usedPorts.get(key) ?? 0) + 1
    usedPorts.set(key, index)
    const count = (bottom ? bottomCount : topCount).get(person.id)!
    return person.x + 60 + (bottom ? 1 : -1) * (3 + 16 * index / (count + 1))
  }
  const usedLanes = new Map<string, number>()
  function lane(person: Person, bottom: boolean) {
    const key = `${person.y}:${bottom}`
    const index = (usedLanes.get(key) ?? 0) + 1
    usedLanes.set(key, index)
    return person.y + (bottom ? 125 + index * laneSpacing : -24 - index * laneSpacing)
  }
  let rail = right
  const paths: RelationPath[] = edges.map(({ r, a, b }) => {
    const parent = r.kind === '親子'
    const x = port(a, parent), xx = port(b, false), y = lane(a, parent)
    const direct = parent ? rows[rows.indexOf(a.y) + 1] === b.y : a.y === b.y
    const start = `M${x} ${a.y + (parent ? 120 : 32)} V${y}`
    const end = `H${xx} V${b.y + 32}`
    if (!direct) {
      rail += laneSpacing
      return {
        path: `${start} H${rail} V${lane(b, false)} ${end}`,
        divorceMark: r.kind === '離婚' ? { x: (x + rail) / 2, y } : undefined,
      }
    }
    return { path: `${start} ${end}`, divorceMark: r.kind === '離婚' ? { x: (x + xx) / 2, y } : undefined }
  })
  return { paths, right: rail }
}
