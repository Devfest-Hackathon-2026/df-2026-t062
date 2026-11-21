import { api } from '../../lib/api.ts'
import { upload } from '../../lib/upload.ts'
import type { PendingRecording } from './recordingStore.ts'

export async function sendRecording(recording: PendingRecording, onPct: (n: number) => void) {
  const { clientId, id, mime, blob, durationMs } = recording
  let session = await api.startRecording(clientId, mime, id)
  if (session.uploadUrl && await upload(session.uploadUrl, blob, onPct) === 'expired') {
    session = await api.startRecording(clientId, mime, id, session.uploadUrl)
    if (session.uploadUrl && await upload(session.uploadUrl, blob, onPct) === 'expired') {
      throw new Error('ファイルを送れませんでした')
    }
  }
  await api.completeRecording(session.recordingId, durationMs, blob.size)
  onPct(100)
}
