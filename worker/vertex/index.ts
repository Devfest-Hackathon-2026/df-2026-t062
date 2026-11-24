// 本物の中身（Speech-to-Text Chirp 3 と Gemini）。AI_PROVIDER=vertex のときだけ読み込まれる。
// 環境変数: GOOGLE_CLOUD_PROJECT、GEMINI_LOCATION（既定 global）、GEMINI_MODEL（既定 gemini-3.8-flash）、
// GEMINI_CONCURRENCY（既定 4）、GEMINI_THINKING_LEVEL（既定 LOW。DEFAULT でモデルの既定）、
// GEMINI_YEN_IN／GEMINI_YEN_OUT／GEMINI_YEN_CACHED（キャッシュに当たった入力。既定は入力の 1 割）、STT_LOCATION（既定 us）
import { DocumentReadError } from '../../core/document-input.ts'
import type { Providers } from '../types.ts'
import { geminiFactory } from './gemini.ts'
import { speakerAssigner } from './speakers.ts'
import { vertexStt } from './stt.ts'
import { summarizer } from './summarizer.ts'
import { topicWriter } from './topic-writer.ts'

export function vertexProviders(env: NodeJS.ProcessEnv): Providers {
  if (!env.GOOGLE_CLOUD_PROJECT) throw new Error('GOOGLE_CLOUD_PROJECT が未設定です')
  const newLlm = geminiFactory(env)
  return {
    stt: vertexStt(env),
    speakers: speakerAssigner(newLlm),
    recording: { summarizer: summarizer(newLlm), writer: topicWriter(newLlm, { concurrency: Number(env.GEMINI_CONCURRENCY) || 4 }) },
    formImport: newLlm,
    documentWrite: { summarizer: summarizer(newLlm), writer: topicWriter(newLlm, { concurrency: Number(env.GEMINI_CONCURRENCY) || 4 }) },
    documentRead: () => {
      if (env.DOCUMENT_INPUT_APPROVED_LOCATION !== (env.GEMINI_LOCATION ?? 'global')) throw new DocumentReadError('location_not_approved')
      return newLlm()
    },
    inspect: newLlm,
    documentFill: newLlm,
  }
}
