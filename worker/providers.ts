// AI の中身を選ぶ。AI_PROVIDER=vertex で本物（Speech-to-Text Chirp 3 と Gemini）、既定は fake（費用なし）。
// RECORDING_WRITER=summary で、録音からの書き込みを作り替えた流れ（要約から書く。docs/再設計/17）にする。既定は 2 層改（比べてから切り替える）。
import type { Providers } from './types.ts'

let cached: Promise<Providers> | undefined

export function defaultProviders(env: NodeJS.ProcessEnv = process.env): Promise<Providers> {
  cached ??= (async () => {
    if (env.AI_PROVIDER === 'vertex') {
      const m = await import('./vertex/index.ts')
      return m.vertexProviders(env)
    }
    const f = await import('./fake.ts')
    return {
      stt: new f.FakeStt(), speakers: new f.FakeSpeakers(), writer: new f.FakeWriter(), formImport: f.fakeFormImport,
      documentRead: f.fakeDocumentRead,
      documentWrite: { summarizer: new f.FakeSummarizer(), writer: new f.FakeTopicWriter() },
      ...(env.RECORDING_WRITER === 'summary' ? { recording: { summarizer: new f.FakeSummarizer(), writer: new f.FakeTopicWriter() } } : {}),
    }
  })()
  return cached
}
