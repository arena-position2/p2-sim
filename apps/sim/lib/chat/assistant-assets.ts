import { isUserFileDisplayMetadata, isUserFileWithMetadata } from '@/lib/core/utils/user-file'
import { extractStorageKey, inferContextFromKey, isInternalFileUrl } from '@/lib/uploads/utils/file'

export interface AssistantChatFile {
  id: string
  name: string
  url: string
  key: string
  size: number
  type: string
  context?: string
  /** Legacy inline payload; prefer storage key / URL when present. */
  base64?: string
}

export interface AssistantGeneratedImage {
  id: string
  name: string
  url: string
  type: string
  key?: string
  size?: number
  context?: string
}

function isDataImageUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value.trim())
}

function getDataImageMimeType(value: string): string {
  const match = value.trim().match(/^data:(image\/[a-z0-9.+-]+);base64,/i)
  return match?.[1]?.toLowerCase() ?? 'image/png'
}

function inferImageMimeTypeFromUrl(value: string): string {
  const cleanValue = value.split('?')[0].split('#')[0].toLowerCase()
  const decodedValue = (() => {
    try {
      return decodeURIComponent(cleanValue)
    } catch {
      return cleanValue
    }
  })()

  if (/\.(jpg|jpeg)$/.test(decodedValue)) return 'image/jpeg'
  if (/\.png$/.test(decodedValue)) return 'image/png'
  if (/\.webp$/.test(decodedValue)) return 'image/webp'
  if (/\.gif$/.test(decodedValue)) return 'image/gif'
  if (/\.svg$/.test(decodedValue)) return 'image/svg+xml'
  return 'image/png'
}

function getGeneratedImageId(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return `generated-image:${value.length}:${Math.abs(hash)}`
}

/**
 * Normalizes image URLs for deduplication and selection matching.
 * Internal serve URLs compare by storage key so absolute and relative URLs match.
 */
export function normalizeImageUrlForCompare(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) {
    return ''
  }

  const stripQuery = (value: string) => value.split('?')[0].split('#')[0]

  if (isDataImageUrl(trimmed)) {
    return getGeneratedImageId(trimmed)
  }

  try {
    let candidate = decodeURIComponent(trimmed)
    candidate = stripQuery(candidate)

    if (candidate.includes('/api/files/serve/')) {
      return extractStorageKey(candidate)
    }

    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      try {
        const pathname = stripQuery(new URL(candidate).pathname)
        if (pathname.includes('/api/files/serve/')) {
          return extractStorageKey(pathname)
        }
      } catch {
        // Ignore malformed absolute URLs and fall back to the decoded candidate.
      }
    }

    return candidate
  } catch {
    return stripQuery(trimmed)
  }
}

/**
 * Resolves a rendered image URL to selectable generated-image metadata.
 */
export function resolveSelectableGeneratedImage(
  imageUrl: string | undefined,
  generatedImagesByUrl: Map<string, AssistantGeneratedImage>
): AssistantGeneratedImage | undefined {
  if (!imageUrl?.trim()) {
    return undefined
  }

  const existing = generatedImagesByUrl.get(normalizeImageUrlForCompare(imageUrl))
  if (existing) {
    return existing
  }

  if (!isAssistantImageUrl(imageUrl)) {
    return undefined
  }

  const trimmed = imageUrl.trim()
  const key = isInternalFileUrl(trimmed) ? extractStorageKey(trimmed) : undefined

  return {
    id: getGeneratedImageId(normalizeImageUrlForCompare(trimmed)),
    name: 'Generated image',
    url: trimmed,
    type: isDataImageUrl(trimmed)
      ? getDataImageMimeType(trimmed)
      : inferImageMimeTypeFromUrl(trimmed),
    ...(key ? { key, context: inferContextFromKey(key) } : {}),
  }
}

function isGeneratedImageField(key: string): boolean {
  return ['image', 'images', 'generatedImage', 'generatedImages'].includes(key)
}

function isGeneratedImageUrlField(key: string): boolean {
  return isGeneratedImageField(key) || key === 'url'
}

function addGeneratedImageUrl(
  value: string,
  name: string,
  images: AssistantGeneratedImage[],
  seenUrls: Set<string>
): void {
  if (!isAssistantImageUrl(value) || seenUrls.has(value)) {
    return
  }

  seenUrls.add(value)
  const type = isDataImageUrl(value)
    ? getDataImageMimeType(value)
    : inferImageMimeTypeFromUrl(value)
  const key = isInternalFileUrl(value) ? extractStorageKey(value) : undefined
  images.push({
    id: getGeneratedImageId(normalizeImageUrlForCompare(value)),
    name,
    url: value,
    type,
    ...(key ? { key, context: inferContextFromKey(key) } : {}),
  })
}

/**
 * Returns whether the value is a renderable image URL we can show in chat.
 */
export function isAssistantImageUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    (isDataImageUrl(value) ||
      ((value.startsWith('http') || value.startsWith('/api/files/serve/')) &&
        (/\.(png|jpg|jpeg|gif|webp)(\?|#|%|$)/i.test(value.trim()) ||
          value.includes('agent-generated-images'))))
  )
}

/**
 * Converts a UserFile into the assistant chat file shape used by chat UIs.
 */
export function toAssistantChatFile(value: AssistantChatFile): AssistantChatFile {
  return {
    id: value.id,
    name: value.name,
    url: value.url,
    key: value.key,
    size: value.size,
    type: value.type,
    context: value.context,
  }
}

const IMAGE_FILE_NAME = /\.(png|jpe?g|gif|webp)$/i

function hasSafeStorageKey(key: string): boolean {
  const parts = key.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function looksLikeImageFile(value: { name: string; key: string; type: string }): boolean {
  return (
    value.type.startsWith('image/') ||
    IMAGE_FILE_NAME.test(value.name) ||
    IMAGE_FILE_NAME.test(value.key)
  )
}

/**
 * Serve URL for an image file record.
 *
 * Image Generator stores the picture as an execution file. The record that
 * reaches chat can have an empty `url` and `type: application/octet-stream`.
 * Printing that record shows a JSON blob above the picture. The storage key
 * is enough to render it.
 */
function isRenderableStoredUrl(url: string): boolean {
  return (
    url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/api/files/serve/')
  )
}

export function chatDisplayUrlForImageFile(value: unknown): string | null {
  if (isUserFileWithMetadata(value) && looksLikeImageFile(value)) {
    const url = value.url.trim()
    if (isRenderableStoredUrl(url)) {
      return url
    }

    if (hasSafeStorageKey(value.key) && IMAGE_FILE_NAME.test(value.key)) {
      return `/api/files/serve/${encodeURIComponent(value.key)}`
    }
  }

  if (!isUserFileDisplayMetadata(value)) {
    return null
  }

  const file = value as { name?: string; type?: string; url?: string }
  const type = typeof file.type === 'string' ? file.type : ''
  const name = typeof file.name === 'string' ? file.name : ''
  if (!type.startsWith('image/') && !IMAGE_FILE_NAME.test(name)) {
    return null
  }

  const url = typeof file.url === 'string' ? file.url.trim() : ''
  return isRenderableStoredUrl(url) ? url : null
}

/** One image file, or a list of them, as the text chat already knows how to render. */
export function formatChatImageFileText(value: unknown): string | null {
  const single = chatDisplayUrlForImageFile(value)
  if (single) {
    return single
  }

  if (!Array.isArray(value) || value.length === 0) {
    return null
  }

  const urls: string[] = []
  for (const item of value) {
    const url = chatDisplayUrlForImageFile(item)
    if (!url) {
      return null
    }
    urls.push(url)
  }

  return urls.join('\n\n')
}

/**
 * Converts a UserFile into a generated image entry when it is an image.
 */
export function toAssistantGeneratedImage(
  value: AssistantChatFile
): AssistantGeneratedImage | undefined {
  const url = chatDisplayUrlForImageFile(value)
  if (!url) {
    return undefined
  }

  return {
    id: value.id,
    name: value.name,
    url,
    type: value.type.startsWith('image/') ? value.type : inferImageMimeTypeFromUrl(value.name),
    key: value.key,
    size: value.size,
    context: value.context,
  }
}

/**
 * Recursively extracts UserFile values from arbitrary tool output.
 */
export function extractAssistantFilesFromData(
  data: unknown,
  files: AssistantChatFile[] = [],
  seenIds = new Set<string>()
): AssistantChatFile[] {
  if (!data || typeof data !== 'object') {
    return files
  }

  if (isUserFileWithMetadata(data)) {
    if (!seenIds.has(data.id)) {
      seenIds.add(data.id)
      files.push(
        toAssistantChatFile({
          id: data.id,
          name: data.name,
          url: data.url,
          key: data.key,
          size: data.size,
          type: data.type,
          context: data.context,
        })
      )
    }
    return files
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      extractAssistantFilesFromData(item, files, seenIds)
    }
    return files
  }

  for (const value of Object.values(data)) {
    extractAssistantFilesFromData(value, files, seenIds)
  }

  return files
}

/**
 * Recursively extracts image outputs from arbitrary tool output.
 */
export function extractGeneratedImagesFromData(
  data: unknown,
  images: AssistantGeneratedImage[] = [],
  seenUrls = new Set<string>()
): AssistantGeneratedImage[] {
  return collectGeneratedImagesFromData(data, images, seenUrls, true)
}

function collectGeneratedImagesFromData(
  data: unknown,
  images: AssistantGeneratedImage[],
  seenUrls: Set<string>,
  allowBareStringImage: boolean
): AssistantGeneratedImage[] {
  if (!data) {
    return images
  }

  if (isUserFileWithMetadata(data)) {
    const image = toAssistantGeneratedImage(
      toAssistantChatFile({
        id: data.id,
        name: data.name,
        url: data.url,
        key: data.key,
        size: data.size,
        type: data.type,
        context: data.context,
      })
    )
    if (image && !seenUrls.has(image.url)) {
      seenUrls.add(image.url)
      images.push(image)
    }
    return images
  }

  if (typeof data === 'string') {
    if (allowBareStringImage) {
      addGeneratedImageUrl(data, 'Generated image', images, seenUrls)
    }
    return images
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      collectGeneratedImagesFromData(item, images, seenUrls, allowBareStringImage)
    }
    return images
  }

  if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      if (isGeneratedImageUrlField(key) && typeof value === 'string') {
        addGeneratedImageUrl(
          value,
          isGeneratedImageField(key) ? 'Generated image' : 'Image file',
          images,
          seenUrls
        )
        continue
      }

      collectGeneratedImagesFromData(value, images, seenUrls, isGeneratedImageField(key))
    }
  }

  return images
}
