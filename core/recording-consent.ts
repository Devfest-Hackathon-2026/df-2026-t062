export const RECORDING_CONSENT_POLICY_VERSION = 'recording-consent-v1'
export const RECORDING_CONSENT_SCOPE = 'recording_and_ai_processing'
export const RECORDING_CONSENT_POLICY_TEXT = '面談の音声を録音し、文字起こしと AI によるケア記録の下書き作成に利用します。AI の下書きは職員が確認・修正してから正式な記録にします。'

export type RecordingConsentEventType = 'granted' | 'withdrawn'

export interface RecordingConsentView {
  active: boolean
  policyVersion: string | null
  grantedAt: string | null
  withdrawnAt: string | null
}

export interface RecordingConsentPolicy {
  version: string
  scope: string
  text: string
}
