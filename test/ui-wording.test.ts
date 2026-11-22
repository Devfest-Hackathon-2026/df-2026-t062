// 画面の文言に「印刷」を使わない（欄の中身は「欄に入る／書く」と言う）。#163
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

const SRC = join(import.meta.dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

test('src の画面の文言に「印刷」を使わない', () => {
  const hits: string[] = []
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('印刷')) hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(hits, [])
})
