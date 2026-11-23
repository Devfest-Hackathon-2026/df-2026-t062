import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RECORDING_CONSENT_POLICY_VERSION, RECORDING_CONSENT_SCOPE } from '../core/recording-consent.ts'
import { api } from '../src/lib/api.ts'

test('録音同意のポリシー版と対象範囲は固定値を共有する', () => {
  assert.equal(RECORDING_CONSENT_POLICY_VERSION, 'recording-consent-v1')
  assert.equal(RECORDING_CONSENT_SCOPE, 'recording_and_ai_processing')
})

test('録音同意の確認APIは確認済みであることを明示して送る', async (t) => {
  const calls: { url: string, body: unknown }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ consent: { active: true, policyVersion: 'recording-consent-v1', grantedAt: null, withdrawnAt: null } }), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })

  await api.grantRecordingConsent('client-1')
  assert.deepEqual(calls, [{ url: '/api/clients/client-1/recording-consent', body: { confirmed: true } }])
})

test('録音同意の撤回APIは利用者単位で呼ぶ', async (t) => {
  const urls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ consent: { active: false, policyVersion: 'recording-consent-v1', grantedAt: null, withdrawnAt: null } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })

  await api.withdrawRecordingConsent('client-1')
  assert.deepEqual(urls, ['/api/clients/client-1/recording-consent/withdraw'])
})
