import { createLogger } from '@sim/logger'
import { SignJWT } from 'jose'
import {
  buildTableCellTextEndIndexMap,
  buildTableContentRequests,
  expandSlidesForTableOverflow,
  findTableColumnLayout,
  findTableDimensions,
} from '@/tools/google_slides/create-from-template-table'
import { P2_TEAM_MEMBERS } from '@/tools/p2_docs/team-members'
import type { ToolConfig } from '@/tools/types'
import { getPresentationIconLibrary, getTemplateMasterSchema } from './templates'
import type { PresentationSchema } from './templates/schema'

const logger = createLogger('GoogleSlidesCreateFromTemplate')

/** Generate a Google Slides–style object ID (alphanumeric + underscores). */
function generateObjectId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789_'
  let id = 'g'
  for (let i = 0; i < 21; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

interface CreateFromTemplateParams {
  accessToken: string
  presentationName: string
  /** JSON string or pre-parsed schema object (e.g. from agent blocks or UI). */
  schemaJson: string | PresentationSchema | Record<string, unknown>
}

interface CreateFromTemplateResponse {
  success: boolean
  output: {
    presentationId: string
    title: string
    url: string
    slidesCreated: number
  }
}

interface BlockLike {
  type: string
  role?: string
  shapeId: string
  content?: string | string[] | string[][]
  source?: 'icon_library' | 'stock_photo' | 'ai_photo' | 'generated' | 'p2_users'
  maxRows?: number
  maxColumns?: number
  minRows?: number
  minColumns?: number
  headerRow?: boolean
  rowLabelColumn?: boolean
}

interface SlideLike {
  order: number
  templateSlideObjectId: string
  blocks: BlockLike[]
}

const KNOWN_IMAGE_HOST = 'arenav2image.s3.us-west-1.amazonaws.com'
const ICON_LIBRARY_PATH_PREFIX = '/presentation-icons/'
const P2_USERS_PATH_PREFIX = '/presentation-profile-images/'

type KnownImageSource = 'icon_library' | 'p2_users'

function normalizeImagePathForLookup(url: string): string | null {
  try {
    const parsed = new URL(url)
    return decodeURIComponent(parsed.pathname).toLowerCase()
  } catch {
    return null
  }
}

function getKnownImageSourceFromUrl(url: string): KnownImageSource | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== KNOWN_IMAGE_HOST) return null
    if (parsed.pathname.startsWith(ICON_LIBRARY_PATH_PREFIX)) return 'icon_library'
    if (parsed.pathname.startsWith(P2_USERS_PATH_PREFIX)) return 'p2_users'
  } catch {
    // ignore invalid URLs
  }
  return null
}

function isKnownCatalogImage(blockSource: BlockLike['source'], imageUrl: string): boolean {
  if (blockSource === 'icon_library' || blockSource === 'p2_users') return true
  return getKnownImageSourceFromUrl(imageUrl) !== null
}

let knownImageUrlIndex: Map<string, string> | null = null

function getKnownImageUrlIndex(): Map<string, string> {
  if (knownImageUrlIndex) return knownImageUrlIndex

  const index = new Map<string, string>()
  const addUrl = (url: string) => {
    const key = normalizeImagePathForLookup(url)
    if (key && !index.has(key)) {
      index.set(key, url)
    }
  }

  for (const icon of getPresentationIconLibrary().icons) {
    addUrl(icon.pngUrl)
    if (icon.svgUrl) addUrl(icon.svgUrl)
  }
  for (const member of P2_TEAM_MEMBERS) {
    addUrl(member.url)
  }

  knownImageUrlIndex = index
  return index
}

function resolveKnownCatalogImageUrl(imageUrl: string): string | null {
  const key = normalizeImagePathForLookup(imageUrl)
  if (!key) return null
  const canonical = getKnownImageUrlIndex().get(key)
  return canonical && canonical !== imageUrl ? canonical : null
}

// --- Image URL Pre-flight Check ---
async function isImageUrlAccessible(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (res.ok) return true
    // Some servers don't support HEAD; fall back to a byte-range GET
    const getRes = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    })
    return getRes.ok || getRes.status === 206
  } catch (err) {
    logger.warn('Image URL accessibility check threw', {
      url,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Returns an accessible image URL, correcting case for icon-library and P2-user assets when needed.
 */
async function resolveAccessibleImageUrl(
  imageUrl: string,
  blockSource?: BlockLike['source']
): Promise<string | null> {
  if (await isImageUrlAccessible(imageUrl)) return imageUrl

  if (!isKnownCatalogImage(blockSource, imageUrl)) return null

  const correctedUrl = resolveKnownCatalogImageUrl(imageUrl)
  if (correctedUrl && (await isImageUrlAccessible(correctedUrl))) {
    logger.info('Resolved image URL via case-insensitive catalog lookup', {
      original: imageUrl,
      resolved: correctedUrl,
      source: blockSource ?? getKnownImageSourceFromUrl(imageUrl),
    })
    return correctedUrl
  }

  return null
}

/**
 * Returns true for URLs served through the Sim file-serve proxy
 * (`/api/files/serve/…`), which require a Sim bearer token.
 */
function isSimInternalImageUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes('/api/files/serve/')
  } catch {
    return false
  }
}

/**
 * Generates a short-lived internal JWT that satisfies `checkSessionOrInternalAuth` on
 * Sim API routes. Uses only `jose` (browser-safe) so this file stays client-bundle-safe.
 */
async function generateInternalFetchToken(): Promise<string> {
  const secret = new TextEncoder().encode(
    process.env.INTERNAL_JWT_SECRET || process.env.INTERNAL_API_SECRET || ''
  )
  return new SignJWT({ type: 'internal' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer('sim-internal')
    .setAudience('sim-api')
    .sign(secret)
}

/**
 * Converts a Sim file-serve URL into a 1-hour presigned S3 URL that Google Slides
 * can fetch anonymously during `replaceImage`.
 *
 * Calls the internal `/api/tools/google_slides/presign-image` endpoint (server-only,
 * no Node.js imports in this file). Uses a short-lived internal JWT for auth.
 *
 * Returns `null` if any step fails (errors are logged as warnings, not thrown).
 */
async function resolveSimImageToPresignedUrl(imageUrl: string): Promise<string | null> {
  let internalToken: string
  try {
    internalToken = await generateInternalFetchToken()
  } catch (err) {
    logger.warn('Failed to generate internal token for presign request', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const presignRes = await fetch(`${appUrl}/api/tools/google_slides/presign-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${internalToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ imageUrl }),
  })

  if (!presignRes.ok) {
    const err = await presignRes.json().catch(() => ({}))
    logger.warn('Failed to get presigned URL for Sim image', {
      imageUrl,
      status: presignRes.status,
      error: (err as { error?: string }).error,
    })
    return null
  }

  const { url } = (await presignRes.json()) as { url: string }
  logger.info('Resolved Sim image to presigned S3 URL', { imageUrl })
  return url
}

// --- Exponential Backoff Wrapper ---
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 4
): Promise<Response> {
  let delay = 1000
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url, options)
    // Retry on Rate Limit (429) or Server Errors (5xx)
    if (res.status === 429 || res.status >= 500) {
      const jitter = Math.random() * 500
      logger.warn(`API error (${res.status}). Retrying in ${Math.round(delay + jitter)}ms...`, {
        url,
      })
      await new Promise((resolve) => setTimeout(resolve, delay + jitter))
      delay *= 2 // Exponential backoff
      continue
    }
    return res
  }
  // Final attempt
  return fetch(url, options)
}

/**
 * Normalizes schema input from block UI (string), agent output (object), or tool params.
 */
function parseSchema(
  schemaJson: string | PresentationSchema | Record<string, unknown> | unknown
): PresentationSchema {
  let parsed: unknown
  if (typeof schemaJson === 'string') {
    const trimmed = schemaJson.trim()
    if (!trimmed) {
      throw new Error('Schema JSON is required')
    }
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      logger.error('Schema JSON parse failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      throw new Error('Invalid JSON: schema must be valid JSON')
    }
  } else if (schemaJson && typeof schemaJson === 'object' && !Array.isArray(schemaJson)) {
    parsed = schemaJson
  } else {
    throw new Error('Schema must be a JSON string or object with id and slides')
  }
  if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || !('slides' in parsed)) {
    throw new Error('Schema must have id and slides')
  }
  const schema = parsed as PresentationSchema
  if (!Array.isArray(schema.slides)) {
    throw new Error('Schema slides must be an array')
  }
  return schema
}

function validateTemplateId(schema: PresentationSchema): void {
  const templateVersion = schema.templateVersion || 'position2_2026'
  const master = getTemplateMasterSchema(templateVersion)
  if (master.id !== schema.id) {
    logger.error('Schema template id mismatch', {
      schemaId: schema.id,
      templateVersion,
      expectedId: master.id,
    })
    throw new Error(
      `Schema id "${schema.id}" does not match template id "${master.id}" for template "${templateVersion}"`
    )
  }
}

// --- Helper to find text boundaries for lists ---
function buildTextEndIndexMap(presentationData: any): Record<string, number> {
  const map: Record<string, number> = {}
  const slides = presentationData.slides || []
  for (const slide of slides) {
    for (const el of slide.pageElements || []) {
      if (el.shape?.text?.textElements) {
        let maxIndex = 1
        for (const te of el.shape.text.textElements) {
          if (te.endIndex != null && te.endIndex > maxIndex) {
            maxIndex = te.endIndex
          }
        }
        map[el.objectId] = maxIndex
      }
    }
  }
  return map
}

async function duplicatePresentation(
  accessToken: string,
  sourcePresentationId: string,
  title: string
): Promise<string> {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${sourcePresentationId}/copy`)
  url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('fields', 'id,name,mimeType,webViewLink,parents,createdTime,modifiedTime')

  const res = await fetchWithRetry(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: title }),
  })
  const data = await res.json()
  if (!res.ok) {
    logger.error('Duplicate presentation failed', {
      sourcePresentationId,
      title,
      status: res.status,
      error: data.error?.message,
    })
    throw new Error(data.error?.message || 'Failed to duplicate presentation')
  }
  logger.info('Presentation duplicated', {
    sourcePresentationId,
    title,
    newPresentationId: data.id,
  })
  return data.id
}

async function getPresentationSlides(
  accessToken: string,
  presentationId: string
): Promise<{ objectId: string }[]> {
  const res = await fetchWithRetry(
    `https://slides.googleapis.com/v1/presentations/${presentationId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  )
  const data = await res.json()
  if (!res.ok) {
    logger.error('Get presentation slides failed', {
      presentationId,
      status: res.status,
      error: data.error?.message,
    })
    throw new Error(data.error?.message || 'Failed to read presentation')
  }
  return (data.slides || []).map((s: { objectId: string }) => ({
    objectId: s.objectId,
  }))
}

export const createFromTemplateTool: ToolConfig<
  CreateFromTemplateParams,
  CreateFromTemplateResponse
> = {
  id: 'google_slides_create_from_template',
  name: 'Create Presentation from Template',
  description:
    'Create a new presentation from a template: duplicate the template by id, duplicate slides as needed, then replace text, images, and lists from the provided schema JSON.',
  version: '1.0',

  oauth: {
    required: true,
    provider: 'google-drive',
  },

  params: {
    accessToken: {
      type: 'string',
      required: true,
      visibility: 'hidden',
      description: 'The access token for the Google Slides API',
    },
    presentationName: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Title for the new presentation',
    },
    schemaJson: {
      type: 'json',
      required: true,
      visibility: 'user-or-llm',
      description:
        'Valid JSON schema (id, templateVersion, slides with templateSlideObjectId and blocks with shapeId and content). Accepts a JSON string or object.',
    },
  },

  request: {
    url: '/api/tools/google_slides/create_from_template',
    method: 'POST',
    headers: () => ({}),
  },

  outputs: {
    presentationId: { type: 'string', description: 'The new presentation ID' },
    title: { type: 'string', description: 'The presentation title' },
    url: { type: 'string', description: 'URL to open the presentation' },
    slidesCreated: { type: 'number', description: 'Number of slides created' },
  },
}

export async function executeCreateFromTemplateDirect(
  params: CreateFromTemplateParams
): Promise<CreateFromTemplateResponse> {
  const accessToken = params.accessToken?.trim()
  const presentationName = (params.presentationName ?? '').trim()
  if (!accessToken) {
    throw new Error('Access token is required')
  }
  if (!presentationName) {
    throw new Error('Presentation name is required')
  }

  logger.info('Create from template started', {
    presentationName,
    schemaJsonLength:
      typeof params.schemaJson === 'string'
        ? params.schemaJson.length
        : JSON.stringify(params.schemaJson).length,
  })

  const schema = parseSchema(params.schemaJson)
  validateTemplateId(schema)

  logger.info('Schema validated', {
    templateId: schema.id,
    templateVersion: schema.templateVersion,
    slideCount: schema.slides.length,
  })

  // 1. Duplicate Presentation
  const presentationId = await duplicatePresentation(accessToken, schema.id, presentationName)

  // Keep track of the original template slides so we can delete them at the end
  const originalSlidesToDelete = (await getPresentationSlides(accessToken, presentationId)).map(
    (s) => s.objectId
  )

  logger.info('Original slides to delete after content fill', {
    presentationId,
    originalSlideCount: originalSlidesToDelete.length,
  })

  const templatePresRes = await fetchWithRetry(
    `https://slides.googleapis.com/v1/presentations/${schema.id}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const templatePresData = await templatePresRes.json()
  if (!templatePresRes.ok) {
    throw new Error(
      templatePresData.error?.message || 'Failed to read template presentation for tables'
    )
  }

  const slidesOrdered = expandSlidesForTableOverflow([...schema.slides], templatePresData)
  if (slidesOrdered.length > schema.slides.length) {
    logger.info('Expanded slides for table overflow', {
      originalSlideCount: schema.slides.length,
      expandedSlideCount: slidesOrdered.length,
    })
  }

  const slideIndexToShapeMap: Record<string, string>[] = []

  // 2. Duplicate Slides & Reorder (Batch)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const duplicateRequests: any[] = []

  for (let i = 0; i < slidesOrdered.length; i++) {
    const slideSchema = slidesOrdered[i]
    const templateSlideId = (slideSchema as SlideLike).templateSlideObjectId
    const blocks = (slideSchema as SlideLike).blocks || []

    const objectIds: Record<string, string> = {}
    const newSlideId = generateObjectId()

    objectIds[templateSlideId] = newSlideId

    for (const b of blocks) {
      if (b.shapeId) {
        objectIds[b.shapeId] = generateObjectId()
      }
    }

    duplicateRequests.push({
      duplicateObject: {
        objectId: templateSlideId,
        objectIds,
      },
    })

    duplicateRequests.push({
      updateSlidesPosition: {
        slideObjectIds: [newSlideId],
        insertionIndex: originalSlidesToDelete.length + i + 1,
      },
    })

    slideIndexToShapeMap.push(objectIds)
  }

  logger.info('Executing batch slide duplication', { requestCount: duplicateRequests.length })

  if (duplicateRequests.length > 0) {
    const duplicateBatchRes = await fetchWithRetry(
      `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests: duplicateRequests }),
      }
    )

    if (!duplicateBatchRes.ok) {
      const errData = await duplicateBatchRes.json()
      logger.error('Batch slide duplication failed', {
        presentationId,
        status: duplicateBatchRes.status,
        error: errData.error?.message,
      })
      throw new Error(errData.error?.message || 'Failed to duplicate template slides')
    }
  }

  logger.info('Fetching presentation state to build list maps', { presentationId })

  // 3. Fetch presentation ONCE to get text endIndexes AND shape geometry
  const presRes = await fetchWithRetry(
    `https://slides.googleapis.com/v1/presentations/${presentationId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  )
  const presData = await presRes.json()
  if (!presRes.ok) {
    throw new Error(presData.error?.message || 'Failed to read presentation state for mapping')
  }
  const textEndIndexMap = buildTextEndIndexMap(presData)
  const tableCellTextEndIndexMap = buildTableCellTextEndIndexMap(presData)

  // Build shape geometry map for image size restoration
  const shapeGeometryMap: Record<string, { size: any; transform: any }> = {}
  for (const slide of presData.slides || []) {
    for (const el of slide.pageElements || []) {
      if (el.size && el.transform) {
        shapeGeometryMap[el.objectId] = {
          size: el.size,
          transform: el.transform,
        }
      }
    }
  }

  logger.info('Preparing batch content replacements', {
    presentationId,
    slideCount: slidesOrdered.length,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batchRequests: any[] = []

  // Collect pending image checks: { objectId, imageUrl, source }
  const imageCheckQueue: {
    objectId: string
    imageUrl: string
    source?: BlockLike['source']
  }[] = []

  for (let s = 0; s < slidesOrdered.length; s++) {
    const slideSchema = slidesOrdered[s] as SlideLike
    const shapeMap = slideIndexToShapeMap[s] ?? {}
    const blocks = slideSchema.blocks || []

    for (const block of blocks) {
      const objectId = shapeMap[block.shapeId] ?? block.shapeId
      if (!objectId) continue

      const isList = block.type === 'TEXT' && (block as BlockLike).role === 'LIST'
      const content = block.content

      if (block.type === 'TEXT' && !isList) {
        const text = typeof content === 'string' ? content : ''
        if (text) {
          batchRequests.push({ deleteText: { objectId, textRange: { type: 'ALL' } } })
          batchRequests.push({ insertText: { objectId, insertionIndex: 0, text } })
        }
      } else if (block.type === 'TABLE') {
        const tableObjectId = objectId
        const maxRows = block.maxRows ?? 0
        const maxColumns = block.maxColumns ?? 0
        if (!maxRows || !maxColumns) {
          logger.warn('Skipping table block with missing maxRows/maxColumns', {
            shapeId: block.shapeId,
          })
          continue
        }

        const dimensions = findTableDimensions(presData, tableObjectId)
        if (!dimensions) {
          logger.warn('Table element not found after duplication', {
            tableObjectId,
            shapeId: block.shapeId,
          })
          continue
        }

        const layout = findTableColumnLayout(presData, tableObjectId)

        const tableContent: string[][] =
          Array.isArray(content) && Array.isArray(content[0]) ? (content as string[][]) : []
        if (tableContent.length === 0) {
          logger.info('Skipping empty table content; leaving template placeholders', {
            tableObjectId,
            shapeId: block.shapeId,
          })
          continue
        }

        batchRequests.push(
          ...buildTableContentRequests({
            tableObjectId,
            content: tableContent,
            templateRows: dimensions.rows,
            templateColumns: dimensions.columns,
            maxRows: block.maxRows,
            maxColumns: block.maxColumns,
            minRows: block.minRows,
            minColumns: block.minColumns,
            cellTextEndIndexMap: tableCellTextEndIndexMap,
            layout: layout ?? undefined,
          })
        )
      } else if (block.type === 'IMAGE' && content) {
        const imageUrl = typeof content === 'string' ? content : ''
        if (imageUrl) {
          imageCheckQueue.push({ objectId, imageUrl, source: block.source })
        }
      } else if (isList && Array.isArray(content) && content.length > 0) {
        const listText = content.join('\n')
        const endIndex = textEndIndexMap[objectId] || 1

        batchRequests.push({
          deleteText: {
            objectId,
            textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: endIndex - 1 },
          },
        })
        batchRequests.push({ insertText: { objectId, insertionIndex: 0, text: listText } })
      }
    }
  }

  // Run all image URL checks in parallel, then add only passing ones to the batch
  if (imageCheckQueue.length > 0) {
    logger.info('Running image URL pre-flight checks', { count: imageCheckQueue.length })

    const checkResults = await Promise.all(
      imageCheckQueue.map(async ({ objectId, imageUrl, source }) => {
        // Sim-internal URLs: resolve to a presigned S3 URL via internal endpoint
        if (isSimInternalImageUrl(imageUrl)) {
          const presignedUrl = await resolveSimImageToPresignedUrl(imageUrl)
          return { objectId, imageUrl: presignedUrl, accessible: presignedUrl !== null }
        }

        const resolvedUrl = await resolveAccessibleImageUrl(imageUrl, source)
        return {
          objectId,
          imageUrl: resolvedUrl,
          accessible: resolvedUrl !== null,
        }
      })
    )

    for (const { objectId, imageUrl, accessible } of checkResults) {
      if (accessible && imageUrl) {
        // Replace the image content
        batchRequests.push({
          replaceImage: {
            imageObjectId: objectId,
            url: imageUrl,
            imageReplaceMethod: 'CENTER_CROP',
          },
        })

        // Reset crop properties so the new image is shown in full
        batchRequests.push({
          updateImageProperties: {
            objectId,
            imageProperties: {
              cropProperties: {},
            },
            fields: 'cropProperties',
          },
        })

        // Restore the original shape's size and position so the element
        // doesn't shrink/expand after the image swap
        const geo = shapeGeometryMap[objectId]
        if (geo) {
          batchRequests.push({
            updatePageElementTransform: {
              objectId,
              transform: {
                ...geo.transform,
                unit: 'EMU',
              },
              applyMode: 'ABSOLUTE',
            },
          })
        } else {
          logger.warn('No geometry found for image shape — size may not be preserved', {
            objectId,
          })
        }
      } else {
        logger.warn('Skipping image replacement — URL not accessible', { objectId, imageUrl })
      }
    }
  }

  // 5. Append original slide deletions to the same batch payload
  for (const objectId of originalSlidesToDelete) {
    batchRequests.push({ deleteObject: { objectId } })
  }

  // 6. Execute ALL content replacements and deletions in ONE network call
  if (batchRequests.length > 0) {
    logger.info('Executing master batch update', {
      presentationId,
      requestCount: batchRequests.length,
    })

    const batchRes = await fetchWithRetry(
      `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests: batchRequests }),
      }
    )

    if (!batchRes.ok) {
      const errData = await batchRes.json()
      logger.error('Master batch update failed', {
        presentationId,
        status: batchRes.status,
        error: errData.error?.message,
      })
      throw new Error(errData.error?.message || 'Failed to apply template updates')
    }
  }

  logger.info('Create from template completed', {
    presentationId,
    title: presentationName,
    slidesCreated: slidesOrdered.length,
  })

  return {
    success: true,
    output: {
      presentationId,
      title: presentationName,
      url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
      slidesCreated: slidesOrdered.length,
    },
  }
}
