import type { Logger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { MAX_BUFFERED_TRANSFER_BYTES } from '@/lib/uploads/shared/types'
import { processSingleFileToUserFile, type RawFileInput } from '@/lib/uploads/utils/file-utils'
import { downloadFileFromStorage } from '@/lib/uploads/utils/file-utils.server'
import { assertToolFileAccess } from '@/app/api/files/authorization'

export type DevelopmentReferenceMediaType = 'application/pdf'

export interface DevelopmentReferenceMedia {
  mediaType: DevelopmentReferenceMediaType
  base64: string
}

/** @deprecated Use DevelopmentReferenceMedia */
export type DevelopmentReferenceImage = DevelopmentReferenceMedia

export interface ResolveDevelopmentReferenceImageInput {
  referenceImage?: RawFileInput | null
  userId: string
  requestId: string
  logger: Logger
}

function isPdfMimeType(mimeType?: string): boolean {
  return mimeType?.trim().toLowerCase() === 'application/pdf'
}

function isPdfFileName(name?: string): boolean {
  return (name ?? '').trim().toLowerCase().endsWith('.pdf')
}

function assertPdfReference(mimeType: string | undefined, fileName: string | undefined): void {
  if (!isPdfMimeType(mimeType) && !isPdfFileName(fileName)) {
    throw new Error('Reference file must be a PDF (.pdf)')
  }
}

/**
 * Resolves an uploaded PDF into base64 media for Development block vision generation.
 */
export async function resolveDevelopmentReferenceImage(
  input: ResolveDevelopmentReferenceImageInput
): Promise<DevelopmentReferenceMedia | undefined> {
  if (!input.referenceImage) {
    return undefined
  }

  const userFile = processSingleFileToUserFile(input.referenceImage, input.requestId, input.logger)
  assertPdfReference(userFile.type, userFile.name ?? userFile.url)

  let base64 = userFile.base64
  if (!base64) {
    const denied = await assertToolFileAccess(
      userFile.key,
      input.userId,
      input.requestId,
      input.logger
    )
    if (denied) {
      throw new Error('Not authorized to access the reference PDF')
    }
    const buffer = await downloadFileFromStorage(userFile, input.requestId, input.logger, {
      maxBytes: MAX_BUFFERED_TRANSFER_BYTES,
    })
    base64 = buffer.toString('base64')
  }

  const data = base64.replace(/^data:[^;]+;base64,/i, '')
  return { mediaType: 'application/pdf', base64: data }
}

/**
 * Maps resolution errors to API-safe messages.
 */
export function getDevelopmentReferenceImageErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'Failed to process reference PDF')
}
