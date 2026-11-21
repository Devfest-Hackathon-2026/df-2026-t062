// Synthetic data only. Explicit command for real Gemini; never part of npm test.
import { writeFile } from 'node:fs/promises'
import { runChat } from '../../api/chat.ts'
import { geminiChatModel } from '../../api/gemini-chat.ts'
import { cases, records } from './cases.ts'
import { saveDiagramArtifacts } from './artifacts.ts'
import { chatError } from '../../core/chat-error.ts'
if (!process.env.GOOGLE_CLOUD_PROJECT) throw new Error('GOOGLE_CLOUD_PROJECTが必要です（架空データだけを送信します）')
const model = geminiChatModel(process.env, { retries: 0 })
const results: { name: string, ok: boolean, reply?: unknown, error?: string }[] = []
const selected = cases.filter((c) => !process.env.DIAGRAM_CASE || c.name === process.env.DIAGRAM_CASE)
if (!selected.length) throw new Error('DIAGRAM_CASEに一致する検証ケースがありません')
for (const c of selected) {
  let reply: Awaited<ReturnType<typeof runChat>> | undefined
  try {
    reply = await runChat({ model, document: c.document, recordings: records, diagramField: c.name.startsWith('family-') ? 'family.genogram' : 'health.bodyMap', messages: [{ role: 'user', text: c.text }] })
    c.check(reply)
    if (process.env.DIAGRAM_EVAL_ARTIFACT_DIR) await saveDiagramArtifacts(c.name, reply, process.env.DIAGRAM_EVAL_ARTIFACT_DIR)
    results.push({ name: c.name, ok: true, reply })
    console.log(JSON.stringify({ case: c.name, ok: true }))
  } catch (e) {
    // Provider errors can contain request details. Only assertion text is synthetic.
    const error = e instanceof Error && e.name === 'AssertionError' ? e.message : chatError(e).code
    results.push({ name: c.name, ok: false, error, reply })
    console.log(JSON.stringify({ case: c.name, ok: false, error }))
  }
}
if (process.env.DIAGRAM_EVAL_OUTPUT) await writeFile(process.env.DIAGRAM_EVAL_OUTPUT, JSON.stringify(results, null, 2))
if (results.some((r) => !r.ok)) process.exitCode = 1
