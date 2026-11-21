// 画面のコード（src/）の置き場所の決まり（src/README.md）を確かめる。#158
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'

const SRC = resolve(import.meta.dirname, '../src')
const LAYERS = ['app', 'screens', 'components', 'lib'] as const

const entries = (dir: string) => readdirSync(dir).filter((name) => !name.startsWith('.'))
const isDir = (path: string) => statSync(path).isDirectory()

function filesUnder(dir: string): string[] {
  return entries(dir).flatMap((name) => {
    const path = join(dir, name)
    return isDir(path) ? filesUnder(path) : [path]
  })
}

/** src からの位置。例: components/document/FormPage.tsx → { layer: 'components', unit: 'components/document' } */
function placeOf(path: string) {
  const parts = relative(SRC, path).split(sep)
  const layer = parts[0]
  const unit = layer === 'screens' || layer === 'components' ? parts.slice(0, 2).join('/') : layer
  return { layer, unit }
}

/** src の中への相対の読み込み（import 文・動的 import・CSS の読み込み） */
function importsOf(file: string) {
  const text = readFileSync(file, 'utf8')
  const specs = [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1])
  return specs.map((spec) => resolve(dirname(file), spec)).filter((path) => path.startsWith(SRC + sep))
}

test('src の上の段は main.tsx・README.md と app・screens・components・lib だけ', () => {
  assert.deepEqual(entries(SRC).sort(), ['README.md', 'app', 'components', 'lib', 'main.tsx', 'screens'])
})

test('app と lib の中、screens と components の各フォルダの中には、さらにフォルダを作らない', () => {
  const units = [
    join(SRC, 'app'), join(SRC, 'lib'),
    ...['screens', 'components'].flatMap((layer) => entries(join(SRC, layer)).map((name) => join(SRC, layer, name))),
  ]
  for (const unit of units) {
    assert.ok(isDir(unit), `${relative(SRC, unit)} はフォルダにする（ファイルを直に置かない）`)
    const nested = entries(unit).filter((name) => isDir(join(unit, name)))
    assert.deepEqual(nested, [], `${relative(SRC, unit)} の中にフォルダがある`)
  }
})

test('screens と components のフォルダ名は英小文字とハイフン', () => {
  for (const layer of ['screens', 'components']) {
    for (const name of entries(join(SRC, layer))) assert.match(name, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `${layer}/${name}`)
  }
})

test('読み込む向きは app → screens → components → lib の一方向', () => {
  const wrong: string[] = []
  for (const file of filesUnder(SRC)) {
    const from = placeOf(file)
    if (!(LAYERS as readonly string[]).includes(from.layer)) continue
    for (const target of importsOf(file)) {
      const to = placeOf(target)
      const up = LAYERS.indexOf(to.layer as typeof LAYERS[number]) < LAYERS.indexOf(from.layer as typeof LAYERS[number])
      const otherScreen = from.layer === 'screens' && to.layer === 'screens' && from.unit !== to.unit
      if (up || otherScreen || to.layer === 'main.tsx') wrong.push(`${relative(SRC, file)} → ${relative(SRC, target)}`)
    }
  }
  assert.deepEqual(wrong, [])
})

test('components どうしの読み込みは輪にしない', () => {
  const edges = new Map<string, Set<string>>()
  for (const file of filesUnder(join(SRC, 'components'))) {
    const from = placeOf(file).unit
    for (const target of importsOf(file)) {
      const to = placeOf(target)
      if (to.layer !== 'components' || to.unit === from) continue
      if (!edges.has(from)) edges.set(from, new Set())
      edges.get(from)!.add(to.unit)
    }
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const cycles: string[] = []
  const visit = (unit: string, path: string[]) => {
    if (state.get(unit) === 'done') return
    if (state.get(unit) === 'visiting') { cycles.push([...path.slice(path.indexOf(unit)), unit].join(' → ')); return }
    state.set(unit, 'visiting')
    for (const next of edges.get(unit) ?? []) visit(next, [...path, unit])
    state.set(unit, 'done')
  }
  for (const unit of edges.keys()) visit(unit, [])
  assert.deepEqual(cycles, [])
})
