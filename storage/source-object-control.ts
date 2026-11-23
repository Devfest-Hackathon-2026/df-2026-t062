export type DecimalString = string & { readonly __decimalString: unique symbol }

export const SOURCE_OBJECT_ERROR_CODES = [
  'permission_denied',
  'rate_limited',
  'unavailable',
  'precondition_failed',
  'invalid_request',
] as const
export type SourceObjectErrorCode = typeof SOURCE_OBJECT_ERROR_CODES[number]

export const RETRYABLE_SOURCE_OBJECT_ERROR_CODES = new Set<SourceObjectErrorCode>(['rate_limited', 'unavailable'])

export function decimalString(value: unknown): DecimalString {
  const text = String(value)
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error('invalid_decimal_string')
  return text as DecimalString
}

export interface StoredObjectMetadata {
  size: number
  generation: DecimalString
  metageneration: DecimalString
  temporaryHold: boolean
}

export type MetadataResult =
  | { kind: 'found', metadata: StoredObjectMetadata }
  | { kind: 'not_found' }
  | { kind: 'error', code: Exclude<SourceObjectErrorCode, 'precondition_failed'> }

export type HoldResult =
  | { kind: 'updated', metadata: StoredObjectMetadata }
  | { kind: 'not_found' }
  | { kind: 'error', code: SourceObjectErrorCode }

export type DeleteResult =
  | { kind: 'deleted' }
  | { kind: 'not_found' }
  | { kind: 'error', code: SourceObjectErrorCode }

export type CancelUploadResult =
  | { kind: 'cancelled' }
  | { kind: 'inactive' }
  | { kind: 'error', code: Exclude<SourceObjectErrorCode, 'precondition_failed'> }

export interface SourceObjectControl {
  getLiveObjectMetadata(path: string): Promise<MetadataResult>
  setTemporaryHold(path: string, generation: DecimalString, metageneration: DecimalString, enabled: boolean): Promise<HoldResult>
  deleteObjectGeneration(path: string, generation: DecimalString): Promise<DeleteResult>
  cancelUploadSession(uploadSessionUrl: string): Promise<CancelUploadResult>
}

export function sourceObjectErrorCode(error: unknown): SourceObjectErrorCode {
  const code = (error as { code?: unknown })?.code
  if (code === 401 || code === 403 || code === 7 || code === 'EACCES') return 'permission_denied'
  if (code === 412 || code === 9) return 'precondition_failed'
  if (code === 429 || code === 8) return 'rate_limited'
  if (code === 400 || code === 3) return 'invalid_request'
  return 'unavailable'
}

export function isNotFoundError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code
  return code === 404 || code === 5 || code === 'ENOENT'
}

