import { createLogger } from '@sim/logger'
import type {
  DevelopmentReferenceMedia,
  ResolveDevelopmentReferenceImageInput,
} from '@/lib/development/resolve-development-reference-image'
import {
  getDevelopmentReferenceImageErrorMessage,
  resolveDevelopmentReferenceImage,
} from '@/lib/development/resolve-development-reference-image'
import type { RawFileInput } from '@/lib/uploads/utils/file'

const logger = createLogger('DevelopmentToolReferenceImage')

export type ResolveDevelopmentToolReferenceImageResult =
  | { ok: true; referenceImage: DevelopmentReferenceMedia | undefined }
  | { ok: false; error: string }

interface ResolveDevelopmentToolReferenceImageParams {
  referenceImage?: unknown
  userId?: string
  requestId: string
}

/**
 * Returns true when the value is already base64 PDF media ready for Anthropic.
 */
export function isResolvedDevelopmentReferenceMedia(
  value: unknown
): value is DevelopmentReferenceMedia {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const media = value as Partial<DevelopmentReferenceMedia>
  return (
    media.mediaType === 'application/pdf' &&
    typeof media.base64 === 'string' &&
    media.base64.trim().length > 0
  )
}

/**
 * Resolves Development / Arena Development tool reference PDFs for direct execution.
 * Accepts already-resolved media or raw upload file shapes used by the block UI.
 */
export async function resolveDevelopmentToolReferenceImage(
  input: ResolveDevelopmentToolReferenceImageParams
): Promise<ResolveDevelopmentToolReferenceImageResult> {
  if (input.referenceImage == null) {
    return { ok: true, referenceImage: undefined }
  }

  if (isResolvedDevelopmentReferenceMedia(input.referenceImage)) {
    return { ok: true, referenceImage: input.referenceImage }
  }

  if (!input.userId) {
    return { ok: false, error: 'Authentication required to resolve reference PDF' }
  }

  try {
    const resolveInput: ResolveDevelopmentReferenceImageInput = {
      referenceImage: input.referenceImage as RawFileInput,
      userId: input.userId,
      requestId: input.requestId,
      logger,
    }
    const referenceImage = await resolveDevelopmentReferenceImage(resolveInput)
    return { ok: true, referenceImage }
  } catch (error) {
    return { ok: false, error: getDevelopmentReferenceImageErrorMessage(error) }
  }
}
