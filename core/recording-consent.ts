export const RECORDING_CONSENT_POLICY_VERSION = 'recording-consent-v1'
export const RECORDING_CONSENT_SCOPE = 'recording_and_ai_processing'

export type RecordingConsentEventType = 'granted' | 'withdrawn'

export interface RecordingConsentView {
  active: boolean
  policyVersion: string | null
  grantedAt: string | null
  withdrawnAt: string | null
}
