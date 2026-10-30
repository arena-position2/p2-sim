import type { AssistantGeneratedImage } from '@/lib/chat/assistant-assets'
import {
  getChatImageFetchUrl,
  isInternalServeUrl,
  resolveChatImageSourceUrl,
} from '@/lib/chat/image-fetch-url'
import { ensureFileNameExtension, getExtensionFromMimeType } from '@/lib/uploads/utils/file'

export interface SelectedGeneratedImage extends AssistantGeneratedImage {
  messageId: string
}

export interface MaterializedSelectedGeneratedImage {
  id: string
  name: string
  size: number
  type: string
  file: File
  dataUrl: string
  url?: string
}

interface MessageWithGeneratedImages {
  id: string
  generatedImages?: AssistantGeneratedImage[]
}

export interface ToggleGeneratedImageInput {
  id: string
  name: string
  url: string
  key?: string
  type: string
  size?: number
}

function resolveMaterializedFileSize(image: SelectedGeneratedImage, byteLength?: number): number {
  if (typeof byteLength === 'number' && byteLength > 0) {
    return byteLength
  }
  if (typeof image.size === 'number' && image.size > 0) {
    return image.size
  }
  return 1
}

function isConcreteImageMimeType(type: string | undefined): type is string {
  return Boolean(type && /^image\/(?!\*)([a-z0-9.+-]+)$/i.test(type.trim()))
}

function inferImageMimeTypeFromPath(value: string): string | undefined {
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
  return undefined
}

function resolveImageMimeType(image: SelectedGeneratedImage, sourceUrl?: string): string {
  if (isConcreteImageMimeType(image.type)) {
    return image.type.toLowerCase()
  }

  return (
    inferImageMimeTypeFromPath(sourceUrl ?? '') ??
    inferImageMimeTypeFromPath(image.name ?? '') ??
    'image/png'
  )
}

/**
 * Chat labels generated images "Generated image". Upload validation allowlists by
 * filename extension, so a display name with none is rejected before the edit runs.
 */
function toUploadFileName(name: string | undefined, type: string): string {
  const trimmed = name?.trim()
  if (!trimmed) {
    return `generated-image.${getExtensionFromMimeType(type) ?? 'png'}`
  }
  return ensureFileNameExtension(trimmed, type)
}

export function toSelectedGeneratedImage(
  messageId: string,
  image: ToggleGeneratedImageInput
): SelectedGeneratedImage {
  return {
    ...image,
    messageId,
  }
}

/**
 * Returns the most recent generated image in a message list.
 */
export function getLatestGeneratedImage(
  messages: MessageWithGeneratedImages[]
): SelectedGeneratedImage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const lastImage = message.generatedImages?.[message.generatedImages.length - 1]
    if (lastImage) {
      return {
        ...lastImage,
        messageId: message.id,
      }
    }
  }

  return undefined
}

function isInlineImageDataUrl(url: string): boolean {
  const trimmed = url.trim()
  return trimmed.startsWith('data:image/') && trimmed.includes(';base64,')
}

function materializeInlineDataUrlImage(
  image: SelectedGeneratedImage,
  dataUrl: string
): MaterializedSelectedGeneratedImage {
  const trimmed = dataUrl.trim()
  const mimeMatch = trimmed.match(/^data:(image\/[a-z0-9.+-]+);base64,/i)
  const type = mimeMatch?.[1]?.toLowerCase() ?? resolveImageMimeType(image)
  const base64Data = trimmed.slice(trimmed.indexOf(';base64,') + ';base64,'.length)
  const binary = atob(base64Data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  const blob = new Blob([bytes], { type })
  const name = toUploadFileName(image.name, type)
  const file = new File([blob], name, { type })

  return {
    id: image.id,
    name,
    size: file.size,
    type,
    file,
    dataUrl: trimmed,
  }
}

/**
 * Converts a generated image URL back into a File-like object so it can reuse the
 * existing chat upload pipelines.
 */
export async function materializeSelectedGeneratedImage(
  image: SelectedGeneratedImage
): Promise<MaterializedSelectedGeneratedImage> {
  const sourceUrl = resolveChatImageSourceUrl(image)
  if (isInlineImageDataUrl(sourceUrl)) {
    return materializeInlineDataUrlImage(image, sourceUrl)
  }

  if (isInternalServeUrl(sourceUrl)) {
    const fetchUrl = getChatImageFetchUrl(sourceUrl)
    const type = resolveImageMimeType(image, sourceUrl)
    const name = toUploadFileName(image.name, type)
    const size = resolveMaterializedFileSize(image)
    return {
      id: image.id,
      name,
      size,
      type,
      file: new File([], name, { type }),
      dataUrl: fetchUrl,
      url: sourceUrl,
    }
  }

  if (image.key?.trim()) {
    const serveUrl = resolveChatImageSourceUrl({ url: '', key: image.key })
    if (isInternalServeUrl(serveUrl)) {
      const fetchUrl = getChatImageFetchUrl(serveUrl)
      const type = resolveImageMimeType(image, serveUrl)
      const name = toUploadFileName(image.name, type)
      const size = resolveMaterializedFileSize(image)
      return {
        id: image.id,
        name,
        size,
        type,
        file: new File([], name, { type }),
        dataUrl: fetchUrl,
        url: serveUrl,
      }
    }
  }

  const response = await fetch(getChatImageFetchUrl(sourceUrl), { credentials: 'include' })
  if (!response.ok) {
    throw new Error(`Failed to load selected image: ${response.status} ${response.statusText}`)
  }

  const blob = await response.blob()
  const type = isConcreteImageMimeType(blob.type)
    ? blob.type
    : resolveImageMimeType(image, sourceUrl)
  const name = toUploadFileName(image.name, type)
  const file = new File([blob], name, { type })
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read selected image'))
    reader.readAsDataURL(file)
  })

  return {
    id: image.id,
    name,
    size: file.size,
    type,
    file,
    dataUrl,
  }
}
