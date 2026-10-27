import { GoogleGenAI, type Part } from '@google/genai'
import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { getRotatingApiKey } from '@/lib/core/config/api-keys'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import {
  secureFetchWithPinnedIP,
  validateUrlWithDNS,
} from '@/lib/core/security/input-validation.server'
import {
  assertKnownSizeWithinLimit,
  readResponseToBufferWithLimit,
} from '@/lib/core/utils/stream-limits'
import { MAX_IMAGES_TO_GENERATE } from '@/lib/image-generation/constants'
import { resolveImageGenerationCount } from '@/lib/image-generation/resolve-image-count.server'
import { MAX_MEDIA_BYTES } from '@/lib/media/falai'
import {
  executeCopilotFileUseCase,
  resolveCopilotWorkspaceFileReference,
} from '@/lib/mothership/application/execute-file-use-case'
import { GenerateImage } from '@/lib/mothership/generated/tool-catalog-v1'
import {
  assertServerToolNotAborted,
  type BaseServerTool,
  type ServerToolContext,
} from '@/lib/mothership/tools/server/base-tool'
import { assertOpaqueWorkspaceFileModelSafe } from '@/lib/mothership/tools/server/model-input'
import { writeCopilotWorkspaceFileByPath } from '@/lib/mothership/vfs/resource-writer'
import type { WorkspaceFileRecord } from '@/lib/uploads/contexts/workspace/workspace-file-manager'
import { createWorkspaceFileSecretProvenanceFromRegistry } from '@/lib/uploads/contexts/workspace/workspace-file-secret-provenance'
import { fileOperations } from '@/lib/workspace-files/application/operations'
import { readWorkspaceFileContent } from '@/lib/workspace-files/application/read-workspace-file-content'

const logger = createLogger('GenerateImageTool')

const NANO_BANANA_MODEL = 'gemini-3.1-flash-image-preview'
const NANO_BANANA_IMAGE_COST_USD = 0.101
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024

const ASPECT_RATIO_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1024x768',
  '3:4': '768x1024',
}

interface GenerateImageArgs {
  prompt: string
  inputs?: { files?: Array<{ path: string }> }
  aspectRatio?: string
  outputs?: {
    files?: Array<{
      path: string
      mode?: 'create' | 'overwrite'
      mimeType?: string
    }>
  }
}

interface GenerateImageResult {
  success: boolean
  message: string
  fileId?: string
  fileName?: string
  vfsPath?: string
  downloadUrl?: string
  files?: Array<{
    fileId: string
    fileName: string
    vfsPath: string
    downloadUrl?: string
  }>
  _serviceCost?: { service: string; cost: number }
}

function buildOutputPath(
  basePath: string,
  index: number,
  count: number,
  extension: string
): string {
  if (count <= 1) {
    return basePath
  }

  const dotIndex = basePath.lastIndexOf('.')
  if (dotIndex <= 0 || basePath.includes('/', dotIndex)) {
    return `${basePath}-${index + 1}${extension}`
  }

  return `${basePath.slice(0, dotIndex)}-${index + 1}${basePath.slice(dotIndex)}`
}

async function fetchReferenceImageUrl(url: string): Promise<{ data: string; mimeType: string }> {
  const validation = await validateUrlWithDNS(url, 'imageUrl', 'contentFetch')
  if (!validation.isValid || !validation.resolvedIP) {
    throw new Error(validation.error || 'Reference image URL failed validation')
  }

  const response = await secureFetchWithPinnedIP(url, validation.resolvedIP, {
    method: 'GET',
    maxResponseBytes: MAX_REFERENCE_IMAGE_BYTES,
    profile: 'contentFetch',
  })

  if (!response.ok) {
    throw new Error(`Failed to download reference image: ${response.status}`)
  }

  const contentType = response.headers.get('content-type') || 'image/png'
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Reference URL did not return an image (${contentType})`)
  }

  const buffer = await readResponseToBufferWithLimit(response, {
    maxBytes: MAX_REFERENCE_IMAGE_BYTES,
    label: 'chat reference image',
  })
  assertKnownSizeWithinLimit(buffer.length, MAX_REFERENCE_IMAGE_BYTES, 'chat reference image')

  return {
    data: buffer.toString('base64'),
    mimeType: contentType,
  }
}

/**
 * Loads one declared reference image, or fails the whole call. Rendering from the
 * remaining inputs would hand back an image silently missing what the user attached and
 * report it as a success; a miss instead names the path so the model can correct it
 * rather than hunt for the file. Model-safety refusals keep their own message.
 */
async function loadReferenceImage(
  context: ServerToolContext,
  workspaceId: string,
  filePath: string
): Promise<{ file: WorkspaceFileRecord; buffer: Buffer }> {
  let file: WorkspaceFileRecord
  try {
    file = await resolveCopilotWorkspaceFileReference(context, fileOperations.readContent, {
      workspaceId,
      reference: filePath,
    })
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'not_found') {
      throw new Error(
        `Reference image "${filePath}" was not found. Pass the exact path as \`files ls\` prints it (e.g. "files/photo.png"), or the "uploads/<name>" path from the upload notice.`
      )
    }
    throw error
  }
  await assertOpaqueWorkspaceFileModelSafe({ workspaceId, file })
  try {
    const { content } = await executeCopilotFileUseCase(
      context,
      readWorkspaceFileContent,
      {
        fileId: file.id,
        assertedWorkspaceId: workspaceId,
        maxBytes: MAX_MEDIA_BYTES,
      },
      { fileId: file.id }
    )
    return { file, buffer: content }
  } catch (error) {
    throw new Error(
      `Reference image "${filePath}" could not be read: ${getErrorMessage(error, 'unknown error')}`
    )
  }
}

export const generateImageServerTool: BaseServerTool<GenerateImageArgs, GenerateImageResult> = {
  name: GenerateImage.id,

  async execute(
    params: GenerateImageArgs,
    context?: ServerToolContext
  ): Promise<GenerateImageResult> {
    if (!context?.userId) {
      throw new Error('Authentication required')
    }
    const workspaceId = context.workspaceId
    if (!workspaceId) {
      return { success: false, message: 'Workspace ID is required' }
    }

    const prompt = params.prompt
    if (!prompt) {
      return { success: false, message: 'prompt is required' }
    }

    try {
      const { imageCount, promptImageUrl, singleImagePrompt, singleImagePrompts } =
        await resolveImageGenerationCount({ prompt })
      const apiKey = getRotatingApiKey('google')
      const ai = new GoogleGenAI({ apiKey })

      const aspectRatio = params.aspectRatio || '1:1'
      const sizeHint = ASPECT_RATIO_TO_SIZE[aspectRatio]

      const parts: Part[] = []

      const referencePaths = params.inputs?.files?.map((file) => file.path) ?? []

      for (const filePath of referencePaths) {
        const { file, buffer } = await loadReferenceImage(context, workspaceId, filePath)
        const mime = file.type || 'image/png'
        parts.push({ inlineData: { mimeType: mime, data: buffer.toString('base64') } })
        logger.info('Loaded reference image', {
          filePath,
          name: file.name,
          size: buffer.length,
          mimeType: mime,
        })
      }

      if (promptImageUrl) {
        try {
          const referenceImage = await fetchReferenceImageUrl(promptImageUrl)
          parts.push({
            inlineData: {
              mimeType: referenceImage.mimeType,
              data: referenceImage.data,
            },
          })
          logger.info('Loaded prompt reference image', {
            size: referenceImage.data.length,
            mimeType: referenceImage.mimeType,
          })
        } catch (err) {
          logger.warn('Failed to load prompt reference image, continuing without it', {
            error: toError(err).message,
          })
        }
      }

      const sizeInstruction = sizeHint
        ? ` Generate the image at ${sizeHint} resolution with a ${aspectRatio} aspect ratio.`
        : ''

      logger.info('Generating image with Nano Banana 2', {
        model: NANO_BANANA_MODEL,
        aspectRatio,
        promptLength: prompt.length,
        referenceImageCount: referencePaths.length,
        promptReferenceImage: Boolean(promptImageUrl),
        imageCount,
      })

      const generatedFiles: NonNullable<GenerateImageResult['files']> = []
      const count = Math.min(MAX_IMAGES_TO_GENERATE, Math.max(1, imageCount))
      // Reference images were asserted opaque-egress-safe above, so the prompt
      // is the only secret-bearing input these files can inherit. Recording its
      // provenance is what keeps the written file readable by the model later:
      // a write without a sidecar stamps the file "unknown" and every
      // content-view read of it is refused.
      const promptProvenance = await createWorkspaceFileSecretProvenanceFromRegistry(
        context.resolvedSecretTraceRegistry,
        prompt,
        { userId: context.userId, workspaceId }
      )
      const secretProvenance = promptProvenance.safe
        ? promptProvenance.provenance
        : { status: 'unknown' as const }

      for (let index = 0; index < count; index++) {
        const promptForImage = singleImagePrompts?.[index] || singleImagePrompt || prompt
        const response = await ai.models.generateContent({
          model: NANO_BANANA_MODEL,
          contents: [
            { role: 'user', parts: [...parts, { text: promptForImage + sizeInstruction }] },
          ],
          config: {
            responseModalities: ['IMAGE', 'TEXT'],
          },
        })

        let imageBase64: string | undefined
        let mimeType = 'image/png'

        if (response.candidates?.[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            if (part.inlineData?.data) {
              imageBase64 = part.inlineData.data
              if (part.inlineData.mimeType) {
                mimeType = part.inlineData.mimeType
              }
              break
            }
          }
        }

        if (!imageBase64) {
          const textParts = response.candidates?.[0]?.content?.parts
            ?.filter((p) => p.text)
            .map((p) => p.text)
            .join(' ')
          return {
            success: false,
            message: `Image generation returned no image data. ${textParts ? `Model response: ${textParts.slice(0, 500)}` : 'No response from model.'}`,
          }
        }

        const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? '.jpg' : '.png'
        const outputFile = params.outputs?.files?.[index] ?? params.outputs?.files?.[0]
        const baseOutputPath = outputFile?.path || `files/generated-image${ext}`
        const outputPath = buildOutputPath(baseOutputPath, index, count, ext)
        const imageBuffer = Buffer.from(imageBase64, 'base64')
        const mode = outputFile?.mode ?? 'create'

        assertServerToolNotAborted(context)
        const written = await writeCopilotWorkspaceFileByPath(context, {
          workspaceId,
          target: {
            path: outputPath,
            mode,
            mimeType: outputFile?.mimeType,
          },
          buffer: imageBuffer,
          inferredMimeType: mimeType,
          secretProvenance,
        })

        logger.info('Generated image saved', {
          fileId: written.id,
          fileName: written.name,
          vfsPath: written.vfsPath,
          size: imageBuffer.length,
          mimeType,
          index,
          count,
        })

        generatedFiles.push({
          fileId: written.id,
          fileName: written.name,
          vfsPath: written.vfsPath,
          downloadUrl: written.downloadUrl,
        })
      }

      const firstFile = generatedFiles[0]
      return {
        success: true,
        message:
          generatedFiles.length === 1
            ? `Image ${referencePaths.length || promptImageUrl ? 'edited' : 'generated'} and saved at "${firstFile?.vfsPath}"`
            : `Generated ${generatedFiles.length} images: ${generatedFiles.map((file) => `"${file.vfsPath}"`).join(', ')}`,
        fileId: firstFile?.fileId,
        fileName: firstFile?.fileName,
        vfsPath: firstFile?.vfsPath,
        downloadUrl: firstFile?.downloadUrl,
        files: generatedFiles,
        _serviceCost: {
          service: 'nano_banana_2',
          cost: NANO_BANANA_IMAGE_COST_USD * generatedFiles.length,
        },
      }
    } catch (error) {
      const msg = getErrorMessage(error, 'Unknown error')
      logger.error('Image generation failed', { error: msg })
      return { success: false, message: `Failed to generate image: ${msg}` }
    }
  },
}
