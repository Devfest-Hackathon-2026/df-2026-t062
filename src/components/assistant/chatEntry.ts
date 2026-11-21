const names: Record<string, string> = { 'family.genogram': '家族構成図', 'health.bodyMap': '身体図' }
export function diagramChatName(key?: string): string | undefined { return key ? names[key] : undefined }
export function diagramChatTitle(key?: string): string { const name = diagramChatName(key); return name ? `${name}の書き方を相談する` : '書き方を相談する' }
/** Keep the selected figure explicit even if the user replaces the suggested opening text. */
export function diagramChatQuestion(text: string, key?: string): string {
  const name = diagramChatName(key)
  return name && !text.includes(name) ? `${name}について：${text}` : text
}
/** Keep both the failed question and anything typed while the request was running. */
export function restoreChatText(failed: string, current: string): string {
  return current && current !== failed ? `${failed}\n\n${current}` : failed
}
