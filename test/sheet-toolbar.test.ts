import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('アセスメントと計画は同じ用紙ツールバーの凡例・拡大操作・保存を使う', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  try {
    const { SheetToolbar } = await server.ssrLoadModule('/src/form/SheetToolbar.tsx')
    const common = { zoom: 100, onZoom: () => {}, onSave: () => {} }
    const assessment = renderToStaticMarkup(createElement(SheetToolbar, { ...common, title: 'フェースシート', page: '1 / 11 ページ' }))
    const plan = renderToStaticMarkup(createElement(SheetToolbar, {
      ...common, title: '第1表', page: '1 / 3 表', aiLabel: 'AI原案から',
      saveHint: '第1〜3表の変更をまとめて保存します', disabled: true,
    }))
    for (const html of [assessment, plan]) {
      assert.match(html, /class="sheet-toolbar"/)
      assert.match(html, /入力できる欄/)
      assert.match(html, /直したところ/)
      assert.match(html, /aria-label="小さくする"/)
      assert.match(html, /aria-label="大きくする"/)
      assert.match(html, /class="savebtn pc-work-save"/)
    }
    assert.match(assessment, /今回の録音から/)
    assert.match(plan, /AI原案から/)
    assert.match(plan, /第1〜3表の変更をまとめて保存します/)
    assert.match(plan, /aria-label="書類を保存" disabled=""/)
  } finally { await server.close() }
})
