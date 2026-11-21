/** Only fixed, non-sensitive reasons cross the API boundary. Never forward provider messages. */
const messages = {
  overloaded: 'AIが混み合っています。少し待って、もう一度送ってください。',
  rate_limited: 'AIの利用上限に達しました。時間をおくか、管理者に利用設定を確認してください。',
  timeout: 'AIの応答が時間内に終わりませんでした。もう一度送ってください。',
  access_denied: 'AIへの接続権限を確認できません。管理者に接続設定を確認してください。',
  model_unavailable: '指定されたAIモデルを利用できません。管理者にモデル設定を確認してください。',
  interrupted: '通信が途中で切れました。もう一度送ってください。',
  unknown: 'ペットに相談できませんでした。少し待ってから、もう一度送ってください。',
} as const
export type ChatErrorCode = keyof typeof messages
export class ChatError extends Error {
  readonly code: ChatErrorCode
  constructor(code: ChatErrorCode) { super(messages[code]); this.name = 'ChatError'; this.code = code }
}
export function chatErrorFromCode(code: unknown): ChatError {
  return new ChatError(typeof code === 'string' && Object.hasOwn(messages, code) ? code as ChatErrorCode : 'unknown')
}
export function chatError(error: unknown): ChatError {
  if (error instanceof ChatError) return error
  if (typeof error !== 'object' || error === null) return new ChatError('unknown')
  const e = error as { status?: unknown, code?: unknown, name?: unknown }
  const status = Number(e.status ?? e.code)
  if (status === 429) return new ChatError('rate_limited')
  if (status === 503 || status === 502) return new ChatError('overloaded')
  if (status === 408 || status === 504 || e.name === 'TimeoutError' || e.name === 'AbortError') return new ChatError('timeout')
  if (status === 401 || status === 403) return new ChatError('access_denied')
  if (status === 404) return new ChatError('model_unavailable')
  return new ChatError('unknown')
}
