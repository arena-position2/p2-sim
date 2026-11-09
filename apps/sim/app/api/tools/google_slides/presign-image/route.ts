import { createLogger } from '@sim/logger'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { googleSlidesPresignContract } from '@/lib/api/contracts/google-slides-presign'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { checkInternalAuth } from '@/lib/auth/hybrid'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { S3_AGENT_GENERATED_IMAGES_CONFIG } from '@/lib/uploads/config'

const logger = createLogger('PresignImageAPI')

const FILE_SERVE_PREFIX = '/api/files/serve/'

/**
 * Extracts the S3 storage key from a Sim file-serve URL.
 * e.g. `https://…/api/files/serve/agent-generated-images%2F…` → `agent-generated-images/…`
 */
function extractKeyFromServeUrl(imageUrl: string): string | null {
  try {
    const { pathname } = new URL(imageUrl)
    const idx = pathname.indexOf(FILE_SERVE_PREFIX)
    if (idx === -1) return null
    return decodeURIComponent(pathname.slice(idx + FILE_SERVE_PREFIX.length))
  } catch {
    return null
  }
}

/**
 * Internal-only endpoint called by `create_from_template` to convert a Sim
 * file-serve URL into a 1-hour presigned S3 URL that Google Slides can fetch
 * without any authentication headers.
 *
 * Only accepts requests authenticated with an internal JWT
 * (`Authorization: Bearer <internal_jwt>`).
 */
export const POST = withRouteHandler(async (request: NextRequest) => {
  const authResult = await checkInternalAuth(request, { requireWorkflowId: false })
  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = await parseRequest(googleSlidesPresignContract, request, undefined, {
    validationErrorResponse: (error) =>
      NextResponse.json({ error: getValidationErrorMessage(error) }, { status: 400 }),
  })
  if (!parsed.success) return parsed.response
  const { imageUrl } = parsed.data.body

  const key = extractKeyFromServeUrl(imageUrl)
  if (!key) {
    logger.warn('Could not extract S3 key from imageUrl', { imageUrl })
    return NextResponse.json({ error: 'Invalid imageUrl' }, { status: 400 })
  }

  if (!key.startsWith('agent-generated-images/')) {
    logger.warn('presign-image only supports agent-generated-images keys', { key })
    return NextResponse.json({ error: 'Unsupported image path' }, { status: 400 })
  }

  const { bucket, region } = S3_AGENT_GENERATED_IMAGES_CONFIG
  if (!bucket || !region) {
    logger.warn('agent-generated-images S3 not configured', { bucket, region })
    return NextResponse.json({ error: 'Storage not configured' }, { status: 500 })
  }

  const { getPresignedUrlWithConfig } = await import('@/lib/uploads/providers/s3/client')
  const presignedUrl = await getPresignedUrlWithConfig(key, { bucket, region }, 3600)

  logger.info('Generated presigned URL for agent image', { key })
  return NextResponse.json({ url: presignedUrl })
})
