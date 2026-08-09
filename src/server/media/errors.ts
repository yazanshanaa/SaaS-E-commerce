import { t, type MessageParams } from '@/shared/i18n';

/**
 * Every refusal the media pipeline can hand back to a human.
 *
 * The CODE is English (it is an identifier, and B2 switches on it); the MESSAGE is Arabic and
 * comes from `messages/ar/media.json` through the i18n layer, never from a literal in a
 * component or a route. That split is the language policy in one class.
 *
 * The two limit errors deliberately carry their numbers. "الملف كبير" without the number leaves
 * the merchant guessing which of two limits they hit and by how much — and the answer differs
 * per plan, so guessing is a support ticket every time.
 */

export const MEDIA_ERROR_CODES = [
  'unsupportedType',
  'vectorRejected',
  'emptyFile',
  'noFile',
  'fileTooLarge',
  'tooLargeForServer',
  'storageFull',
  'limitsUnavailable',
  'rateLimited',
  'notFound',
  'altMissing',
  'altNotArabic',
  'altTooShort',
  'inUse',
  'queueUnavailable',
  'processingFailed',
  'unauthorized',
  'forbidden',
  'server',
] as const;

export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];

const HTTP_STATUS: Record<MediaErrorCode, number> = {
  unsupportedType: 415,
  vectorRejected: 415,
  emptyFile: 400,
  noFile: 400,
  fileTooLarge: 413,
  tooLargeForServer: 413,
  storageFull: 413,
  limitsUnavailable: 503,
  rateLimited: 429,
  notFound: 404,
  altMissing: 422,
  altNotArabic: 422,
  altTooShort: 422,
  inUse: 409,
  queueUnavailable: 503,
  processingFailed: 500,
  unauthorized: 401,
  forbidden: 403,
  server: 500,
};

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  /** The Arabic sentence a merchant reads. Already interpolated. */
  readonly arabicMessage: string;
  readonly httpStatus: number;

  constructor(code: MediaErrorCode, params?: MessageParams) {
    // `message` stays English: it is what lands in a log line and a stack trace, and logs are
    // read by developers. The Arabic lives next to it, for the human.
    super(`media error: ${code}`);
    this.name = 'MediaError';
    this.code = code;
    this.arabicMessage = t('media', `errors.${code}`, params);
    this.httpStatus = HTTP_STATUS[code];
  }
}

export function isMediaError(error: unknown): error is MediaError {
  return error instanceof MediaError;
}

/**
 * Why a processing job failed, stored on `Media.failureReason`.
 *
 * A CODE is stored rather than a sentence: the column outlives any copy change, and a merchant
 * must never be shown a raw English string from a worker.
 */
export const MEDIA_FAILURE_CODES = ['decode', 'tooLarge', 'sourceMissing', 'unknown'] as const;
export type MediaFailureCode = (typeof MEDIA_FAILURE_CODES)[number];

export function isMediaFailureCode(value: string): value is MediaFailureCode {
  return (MEDIA_FAILURE_CODES as readonly string[]).includes(value);
}

/** Turn a stored failure code into the Arabic sentence B2 renders. */
export function mediaFailureMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return t('media', `failure.${isMediaFailureCode(code) ? code : 'unknown'}`);
}
