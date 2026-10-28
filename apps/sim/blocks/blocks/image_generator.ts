import { ImageIcon } from '@/components/icons'
import {
  getReferenceImageModelIds,
  IMAGE_BLOCK_ALL_MODEL_OPTIONS,
  IMAGE_BLOCK_PROVIDER_OPTIONS,
  IMAGE_GENERATOR_DEFAULT_MODEL,
  IMAGE_GENERATOR_DEFAULT_PROVIDER,
  normalizeImageModelId,
  OPENAI_IMAGE_MODEL_IDS,
  reconcileImageProviderAndModel,
} from '@/lib/image-generation/block-model-config'
import {
  NANO_BANANA_MODELS,
  NANO_BANANA_PRO_MODEL,
  resolveNanoBananaReferences,
} from '@/lib/image-generation/nano-banana-inputs'
import { normalizeReferenceFileParams } from '@/lib/image-generation/reference-files'
import { AuthMode, type BlockConfig, IntegrationType } from '@/blocks/types'
import { createVersionedToolSelector, parseOptionalBooleanInput } from '@/blocks/utils'
import { START_FILES_REF } from '@/executor/constants'

const OPENAI_STANDARD_SIZE_MODELS = OPENAI_IMAGE_MODEL_IDS.filter(
  (modelId) => modelId !== 'gpt-image-2'
)

function normalizeReferenceFiles(input: unknown): unknown[] {
  return normalizeReferenceFileParams(input) ?? []
}

function requireOpenAIImageSize(size: unknown): string {
  const trimmed = typeof size === 'string' ? size.trim() : ''
  if (!trimmed) {
    throw new Error('Size is required')
  }
  return trimmed
}

const REFERENCE_IMAGE_MODELS = getReferenceImageModelIds()

const BASE_ASPECT_RATIO_OPTIONS = [
  { label: '1:1', id: '1:1' },
  { label: '16:9', id: '16:9' },
  { label: '9:16', id: '9:16' },
  { label: '3:2', id: '3:2' },
  { label: '2:3', id: '2:3' },
  { label: '4:3', id: '4:3' },
  { label: '3:4', id: '3:4' },
  { label: '5:4', id: '5:4' },
  { label: '4:5', id: '4:5' },
  { label: '21:9', id: '21:9' },
]

const EXTREME_ASPECT_RATIO_OPTIONS = [
  { label: '4:1', id: '4:1' },
  { label: '1:4', id: '1:4' },
  { label: '8:1', id: '8:1' },
  { label: '1:8', id: '1:8' },
]

const OUTPUT_FORMAT_OPTIONS = [
  { label: 'PNG', id: 'png' },
  { label: 'JPEG', id: 'jpeg' },
  { label: 'WebP', id: 'webp' },
]

export const ImageGeneratorBlock: BlockConfig = {
  type: 'image_generator',
  name: 'Image Generator',
  description: 'Generate, edit, or fuse images',
  hideFromToolbar: true,
  sunset: { status: 'legacy', replacedBy: 'image_generator_v2' },
  authMode: AuthMode.ApiKey,
  longDescription:
    'Integrate Image Generator into the workflow. Can generate images using DALL-E 3 and GPT Image models.',
  docsLink: 'https://docs.sim.ai/integrations/image_generator',
  category: 'blocks',
  integrationType: IntegrationType.AI,
  bgColor: '#4D5FFF',
  icon: ImageIcon,
  canvasPresentation: {
    defaultTitle: 'Image Generator',
    sentences: {
      default: [
        { text: 'Generate an image from', field: 'prompt', core: true },
        { text: 'with', field: 'model' },
      ],
    },
  },
  subBlocks: [
    {
      id: 'model',
      title: 'Model',
      type: 'dropdown',
      options: [
        { label: 'Nano Banana', id: 'gemini-2.5-flash-image' },
        // { label: 'GPT Image', id: 'gpt-image-1' },
        { label: 'Nano Banana Pro', id: NANO_BANANA_PRO_MODEL },
        { label: 'DALL-E 3', id: 'dall-e-3' },
        { label: 'GPT Image 1', id: 'gpt-image-1' },
        { label: 'GPT Image 2', id: 'gpt-image-2' },
      ],
      value: () => NANO_BANANA_PRO_MODEL,
    },
    {
      id: 'prompt',
      title: 'Prompt',
      type: 'long-input',
      required: true,
      placeholder: 'Describe the image you want to generate, edit, or fuse...',
    },
    {
      id: 'size',
      title: 'Size',
      type: 'dropdown',
      options: [
        { label: '1024x1024', id: '1024x1024' },
        { label: '1024x1792', id: '1024x1792' },
        { label: '1792x1024', id: '1792x1024' },
      ],
      required: true,
      value: () => '',
      condition: { field: 'model', value: 'dall-e-3' },
      dependsOn: ['model'],
    },
    {
      id: 'size',
      title: 'Size',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: '1024x1024', id: '1024x1024' },
        { label: '1536x1024', id: '1536x1024' },
        { label: '1024x1536', id: '1024x1536' },
      ],
      required: true,
      value: () => '',
      condition: { field: 'model', value: 'gpt-image-1' },
      dependsOn: ['model'],
    },
    {
      id: 'size',
      title: 'Size',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Square (1024x1024)', id: '1024x1024' },
        { label: 'Portrait (1024x1536)', id: '1024x1536' },
        { label: 'Landscape (1536x1024)', id: '1536x1024' },
        { label: '2K (2560x1440)', id: '2560x1440' },
        { label: '4K (3840x2160)', id: '3840x2160' },
      ],
      required: true,
      value: () => '',
      condition: { field: 'model', value: 'gpt-image-2' },
      dependsOn: ['model'],
    },
    {
      id: 'quality',
      title: 'Quality',
      type: 'dropdown',
      options: [
        { label: 'Standard', id: 'standard' },
        { label: 'HD', id: 'hd' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: 'dall-e-3' },
      dependsOn: ['model'],
    },
    {
      id: 'quality',
      title: 'Quality',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Low', id: 'low' },
        { label: 'Medium', id: 'medium' },
        { label: 'High', id: 'high' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: ['gpt-image-1', 'gpt-image-2'] },
      dependsOn: ['model'],
    },
    {
      id: 'style',
      title: 'Style',
      type: 'dropdown',
      options: [
        { label: 'Vivid', id: 'vivid' },
        { label: 'Natural', id: 'natural' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: 'dall-e-3' },
      dependsOn: ['model'],
    },
    {
      id: 'background',
      title: 'Background',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Transparent', id: 'transparent' },
        { label: 'Opaque', id: 'opaque' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: 'gpt-image-1' },
      dependsOn: ['model'],
    },
    {
      id: 'background',
      title: 'Background',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Opaque', id: 'opaque' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: 'gpt-image-2' },
      dependsOn: ['model'],
    },
    {
      id: 'outputFormat',
      title: 'Output Format',
      type: 'dropdown',
      options: [
        { label: 'PNG', id: 'png' },
        { label: 'JPEG', id: 'jpeg' },
        { label: 'WebP', id: 'webp' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: ['gpt-image-1', 'gpt-image-2'] },
      dependsOn: ['model'],
    },
    {
      id: 'moderation',
      title: 'Moderation',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Low', id: 'low' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: ['gpt-image-1', 'gpt-image-2'] },
      dependsOn: ['model'],
    },
    {
      id: 'imageSize',
      title: 'Size',
      type: 'dropdown',
      options: [
        { label: '1K', id: '1K' },
        { label: '2K', id: '2K' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: 'imagen-4.0-generate-001' },
    },
    {
      id: 'aspectRatio',
      title: 'Aspect Ratio',
      type: 'dropdown',
      options: [
        { label: '1:1', id: '1:1' },
        { label: '3:4', id: '3:4' },
        { label: '4:3', id: '4:3' },
        { label: '9:16', id: '9:16' },
        { label: '16:9', id: '16:9' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: 'imagen-4.0-generate-001' },
    },
    {
      id: 'personGeneration',
      title: 'Person Generation',
      type: 'dropdown',
      options: [
        { label: "Don't Allow", id: 'dont_allow' },
        { label: 'Allow Adult', id: 'allow_adult' },
        { label: 'Allow All', id: 'allow_all' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: 'imagen-4.0-generate-001' },
    },
    {
      id: 'aspectRatio',
      title: 'Aspect Ratio',
      type: 'dropdown',
      options: [
        { label: '1:1', id: '1:1' },
        { label: '2:3', id: '2:3' },
        { label: '3:2', id: '3:2' },
        { label: '3:4', id: '3:4' },
        { label: '4:3', id: '4:3' },
        { label: '4:5', id: '4:5' },
        { label: '5:4', id: '5:4' },
        { label: '9:16', id: '9:16' },
        { label: '16:9', id: '16:9' },
        { label: '21:9', id: '21:9' },
      ],
      clearable: true,
      value: () => '',
      condition: {
        field: 'model',
        value: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'],
      },
    },
    {
      id: 'imageSize',
      title: 'Resolution',
      type: 'dropdown',
      options: [
        { label: '1K', id: '1K' },
        { label: '2K', id: '2K' },
        { label: '4K', id: '4K' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'model', value: NANO_BANANA_PRO_MODEL },
    },
    {
      id: 'inputImage',
      title: 'Reference Images',
      type: 'file-upload',
      acceptedTypes: 'image/*',
      multiple: true,
      uploadContext: 'image-fusion',
      allowStartFilesReference: true,
      defaultValue: START_FILES_REF,
      condition: {
        field: 'model',
        value: NANO_BANANA_MODELS,
      },
    },
    {
      id: 'inputImageUrl',
      title: 'Reference Image URLs',
      type: 'long-input',
      placeholder:
        'Optional: add one or more image URLs or references. Limits vary by model (up to 14 for Nano Banana 2, 11 for Pro, 3 for Nano Banana).',
      mode: 'advanced',
      condition: {
        field: 'model',
        value: NANO_BANANA_MODELS,
      },
    },
    {
      id: 'inputImages',
      title: 'Legacy Fusion Images',
      type: 'file-upload',
      acceptedTypes: 'image/*',
      multiple: true,
      uploadContext: 'image-fusion',
      allowStartFilesReference: true,
      hidden: true,
      condition: { field: 'model', value: NANO_BANANA_PRO_MODEL },
    },
    {
      id: 'inputImageUrls',
      title: 'Legacy Fusion Image URLs',
      type: 'long-input',
      placeholder:
        'Optional: enter fusion image URLs (one per line or comma-separated), or use a reference like <agent1.urls>.',
      hidden: true,
      condition: { field: 'model', value: NANO_BANANA_PRO_MODEL },
    },
  ],
  tools: {
    access: ['openai_image_v2', 'google_imagen_v2', 'google_nano_banana_v2'],
    config: {
      tool: createVersionedToolSelector({
        baseToolSelector: (params) => {
          if (params.model?.startsWith('imagen-')) {
            return 'google_imagen'
          }
          if (params.model?.startsWith('gemini-')) {
            return 'google_nano_banana'
          }
          return 'openai_image'
        },
        suffix: '_v2',
        fallbackToolId: 'openai_image_v2',
      }),
      params: (params) => {
        if (!params.prompt) {
          throw new Error('Prompt is required')
        }

        if (params.model?.startsWith('imagen-')) {
          return {
            model: params.model,
            prompt: params.prompt,
            imageSize: params.imageSize || '1K',
            aspectRatio: params.aspectRatio || '1:1',
            personGeneration: params.personGeneration || 'allow_adult',
          }
        }

        if (params.model?.startsWith('gemini-')) {
          const nanoBananaReferences = resolveNanoBananaReferences({
            model: params.model,
            uploadedReferences: [
              ...normalizeReferenceFiles(params.inputImage),
              ...normalizeReferenceFiles(params.inputImages),
            ],
            inputImageUrl: params.inputImageUrl,
            inputImageUrls: params.inputImageUrls,
          })

          const geminiParams: Record<string, unknown> = {
            model: params.model,
            prompt: params.prompt,
            aspectRatio: params.aspectRatio || '1:1',
            inputImage: undefined,
            inputImages: undefined,
            inputImageUrl: undefined,
            inputImageUrls: undefined,
            ...(params.inputImageMimeType ? { inputImageMimeType: params.inputImageMimeType } : {}),
            ...(nanoBananaReferences.inputImageWarning
              ? { inputImageWarning: nanoBananaReferences.inputImageWarning }
              : {}),
          }

          if (nanoBananaReferences.inputImages) {
            geminiParams.inputImages = nanoBananaReferences.inputImages
          } else if (nanoBananaReferences.inputImage) {
            geminiParams.inputImage = nanoBananaReferences.inputImage
          }

          if (params.model === NANO_BANANA_PRO_MODEL) {
            geminiParams.imageSize = params.imageSize || '1K'
          }

          return geminiParams
        }

        const model = params.model || 'dall-e-3'
        const size = requireOpenAIImageSize(params.size)

        const ALLOWED_QUALITIES: Record<string, string[]> = {
          'dall-e-3': ['standard', 'hd'],
          'gpt-image-1': ['auto', 'low', 'medium', 'high'],
          'gpt-image-2': ['auto', 'low', 'medium', 'high'],
        }
        const ALLOWED_BACKGROUNDS: Record<string, string[]> = {
          'gpt-image-1': ['auto', 'transparent', 'opaque'],
          'gpt-image-2': ['auto', 'opaque'],
        }

        const baseParams = {
          prompt: params.prompt,
          model,
          size,
          apiKey: params.apiKey,
        }

        if (model === 'dall-e-3') {
          const quality = ALLOWED_QUALITIES['dall-e-3'].includes(params.quality)
            ? params.quality
            : 'standard'
          const style = ['vivid', 'natural'].includes(params.style) ? params.style : 'vivid'
          return { ...baseParams, quality, style }
        }
        if (model === 'gpt-image-1' || model === 'gpt-image-2') {
          const quality = ALLOWED_QUALITIES[model].includes(params.quality)
            ? params.quality
            : undefined
          const background = ALLOWED_BACKGROUNDS[model].includes(params.background)
            ? params.background
            : undefined
          return {
            ...baseParams,
            ...(quality && { quality }),
            ...(background && { background }),
            ...(params.outputFormat && { outputFormat: params.outputFormat }),
            ...(params.moderation && { moderation: params.moderation }),
          }
        }

        return baseParams
      },
    },
  },
  inputs: {
    prompt: { type: 'string', description: 'Image description prompt' },
    model: { type: 'string', description: 'Image generation model' },
    size: { type: 'string', description: 'Image dimensions' },
    quality: { type: 'string', description: 'Image quality level' },
    style: { type: 'string', description: 'Image style' },
    background: { type: 'string', description: 'Background type' },
    aspectRatio: { type: 'string', description: 'Image aspect ratio' },
    imageSize: { type: 'string', description: 'Output resolution (1K/2K/4K) for Nano Banana Pro' },
    personGeneration: { type: 'string', description: 'Person generation setting' },
    inputImage: {
      type: 'json',
      description:
        'Reference images for Nano Banana as uploaded UserFiles, Start block files, or file references. Multi-image fusion limits vary by model (up to 3 for Nano Banana, 11 for Pro).',
    },
    inputImageUrl: {
      type: 'string',
      description:
        'Reference image URLs or refs for Nano Banana. Multi-image fusion limits vary by model (up to 3 for Nano Banana, 11 for Pro).',
    },
    inputImages: {
      type: 'json',
      description:
        'Multiple input images for Nano Banana Pro fusion as uploaded UserFiles, Start block files, URLs, or storage references',
    },
    inputImageUrls: {
      type: 'string',
      description:
        'Multiple image URLs or references for Nano Banana Pro fusion (newline or comma-separated)',
    },
    inputImageMimeType: { type: 'string', description: 'MIME type of input image' },
    inputImageWarning: {
      type: 'string',
      description:
        'Warning emitted when multiple input images were provided and the latest one was used',
    },
    outputFormat: { type: 'string', description: 'Output image format (png, jpeg, webp)' },
    moderation: { type: 'string', description: 'Moderation level (auto or low)' },
    // apiKey: { type: 'string', description: 'OpenAI API key' },
  },
  outputs: {
    content: { type: 'string', description: 'Generation response' },
    image: { type: 'file', description: 'Generated image file (UserFile)' },
    images: {
      type: 'array',
      description: 'All generated image files when the Images count is greater than 1',
    },
    metadata: { type: 'json', description: 'Generation metadata' },
  },
}

export const ImageGeneratorV2Block: BlockConfig = {
  type: 'image_generator_v2',
  name: 'Image Generator',
  description: 'Generate images',
  authMode: AuthMode.ApiKey,
  longDescription: 'Generate images using OpenAI GPT Image or Google Nano Banana image models.',
  docsLink: 'https://docs.sim.ai/integrations/image_generator',
  category: 'blocks',
  integrationType: IntegrationType.AI,
  bgColor: '#4D5FFF',
  icon: ImageIcon,
  canvasPresentation: {
    defaultTitle: 'Image Generator',
    sentences: {
      default: [
        { text: 'Generate an image from', field: 'prompt', core: true },
        { text: 'with', field: 'model' },
      ],
    },
  },
  subBlocks: [
    {
      id: 'provider',
      title: 'Provider',
      type: 'combobox',
      options: IMAGE_BLOCK_PROVIDER_OPTIONS,
      placeholder: 'Type, select, or reference a provider...',
      searchable: true,
      commandSearchable: true,
      clearable: true,
      defaultValue: IMAGE_GENERATOR_DEFAULT_PROVIDER,
    },
    {
      id: 'model',
      title: 'Model',
      type: 'combobox',
      options: IMAGE_BLOCK_ALL_MODEL_OPTIONS,
      placeholder: 'Type, select, or reference a model...',
      searchable: true,
      commandSearchable: true,
      clearable: true,
      defaultValue: IMAGE_GENERATOR_DEFAULT_MODEL,
    },
    {
      id: 'prompt',
      title: 'Prompt',
      type: 'long-input',
      required: true,
      placeholder: 'Describe the image you want to generate...',
    },
    {
      id: 'size',
      title: 'Size',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Square (1024x1024)', id: '1024x1024' },
        { label: 'Landscape (1536x1024)', id: '1536x1024' },
        { label: 'Portrait (1024x1536)', id: '1024x1536' },
      ],
      required: true,
      value: () => '',
      condition: {
        field: 'provider',
        value: 'openai',
        and: { field: 'model', value: OPENAI_STANDARD_SIZE_MODELS },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'size',
      title: 'Size',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Square (1024x1024)', id: '1024x1024' },
        { label: 'Landscape (1536x1024)', id: '1536x1024' },
        { label: 'Portrait (1024x1536)', id: '1024x1536' },
        { label: '2K (2560x1440)', id: '2560x1440' },
        { label: '4K (3840x2160)', id: '3840x2160' },
      ],
      required: true,
      value: () => '',
      condition: {
        field: 'provider',
        value: 'openai',
        and: { field: 'model', value: 'gpt-image-2' },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'aspectRatio',
      title: 'Aspect Ratio',
      type: 'combobox',
      options: [...BASE_ASPECT_RATIO_OPTIONS, ...EXTREME_ASPECT_RATIO_OPTIONS],
      placeholder: 'Type, select, or reference an aspect ratio...',
      searchable: true,
      clearable: true,
      value: () => '',
      condition: {
        field: 'provider',
        value: 'gemini',
        and: { field: 'model', value: 'gemini-3.1-flash-image-preview' },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'aspectRatio',
      title: 'Aspect Ratio',
      type: 'combobox',
      options: BASE_ASPECT_RATIO_OPTIONS,
      placeholder: 'Type, select, or reference an aspect ratio...',
      searchable: true,
      clearable: true,
      value: () => '',
      condition: {
        field: 'provider',
        value: 'gemini',
        and: {
          field: 'model',
          value: ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image'],
        },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'resolution',
      title: 'Resolution',
      type: 'combobox',
      options: [
        { label: '512', id: '512' },
        { label: '1K', id: '1K' },
        { label: '2K', id: '2K' },
        { label: '4K', id: '4K' },
      ],
      placeholder: 'Type, select, or reference a resolution...',
      searchable: true,
      clearable: true,
      value: () => '',
      condition: {
        field: 'provider',
        value: 'gemini',
        and: { field: 'model', value: 'gemini-3.1-flash-image-preview' },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'resolution',
      title: 'Resolution',
      type: 'combobox',
      options: [
        { label: '1K', id: '1K' },
        { label: '2K', id: '2K' },
        { label: '4K', id: '4K' },
      ],
      placeholder: 'Type, select, or reference a resolution...',
      searchable: true,
      clearable: true,
      value: () => '',
      condition: {
        field: 'provider',
        value: 'gemini',
        and: { field: 'model', value: 'gemini-3-pro-image-preview' },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'quality',
      title: 'Quality',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Low', id: 'low' },
        { label: 'Medium', id: 'medium' },
        { label: 'High', id: 'high' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'provider', value: 'openai' },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'background',
      title: 'Background',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Transparent', id: 'transparent' },
        { label: 'Opaque', id: 'opaque' },
      ],
      clearable: true,
      value: () => '',
      condition: {
        field: 'provider',
        value: 'openai',
        and: { field: 'model', value: ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'] },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'background',
      title: 'Background',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Opaque', id: 'opaque' },
      ],
      clearable: true,
      value: () => '',
      condition: {
        field: 'provider',
        value: 'openai',
        and: { field: 'model', value: 'gpt-image-2' },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'outputFormat',
      title: 'Output Format',
      type: 'dropdown',
      options: OUTPUT_FORMAT_OPTIONS,
      clearable: true,
      value: () => '',
      condition: {
        field: 'provider',
        value: 'openai',
        and: {
          field: 'model',
          value: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'],
        },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'moderation',
      title: 'Moderation',
      type: 'dropdown',
      options: [
        { label: 'Auto', id: 'auto' },
        { label: 'Low', id: 'low' },
      ],
      clearable: true,
      value: () => '',
      condition: { field: 'provider', value: 'openai' },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'inputImage',
      title: 'Reference Images',
      type: 'file-upload',
      acceptedTypes: 'image/*',
      multiple: true,
      uploadContext: 'image-fusion',
      allowStartFilesReference: true,
      defaultValue: START_FILES_REF,
      condition: {
        field: 'provider',
        value: ['openai', 'gemini'],
        and: { field: 'model', value: REFERENCE_IMAGE_MODELS },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'inputImageUrl',
      title: 'Reference Image URLs',
      type: 'long-input',
      placeholder:
        'Optional: add one or more image URLs or references. Limits vary by model (up to 14 for Nano Banana 2, 11 for Pro, 3 for Nano Banana).',
      mode: 'advanced',
      condition: {
        field: 'provider',
        value: ['openai', 'gemini'],
        and: { field: 'model', value: REFERENCE_IMAGE_MODELS },
      },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'inputImages',
      title: 'Legacy Fusion Images',
      type: 'file-upload',
      acceptedTypes: 'image/*',
      multiple: true,
      uploadContext: 'image-fusion',
      allowStartFilesReference: true,
      hidden: true,
      condition: { field: 'provider', value: 'gemini' },
      dependsOn: ['provider', 'model'],
    },
    {
      id: 'inputImageUrls',
      title: 'Legacy Fusion Image URLs',
      type: 'long-input',
      placeholder:
        'Optional: enter fusion image URLs (one per line or comma-separated), or use a reference like <agent1.urls>.',
      hidden: true,
      condition: { field: 'provider', value: 'gemini' },
      dependsOn: ['provider', 'model'],
    },
  ],
  tools: {
    access: ['image_generate'],
    config: {
      tool: () => 'image_generate',
      params: (params) => {
        if (!params.prompt) {
          throw new Error('Prompt is required')
        }

        const { provider, model } = reconcileImageProviderAndModel({
          provider: typeof params.provider === 'string' ? params.provider : undefined,
          model: typeof params.model === 'string' ? normalizeImageModelId(params.model) : undefined,
        })
        const referenceInputs =
          provider === 'openai' || provider === 'gemini'
            ? resolveNanoBananaReferences({
                model: params.model,
                uploadedReferences: [
                  ...normalizeReferenceFiles(params.inputImage),
                  ...normalizeReferenceFiles(params.inputImages),
                ],
                inputImageUrl: params.inputImageUrl,
                inputImageUrls: params.inputImageUrls,
              })
            : {}

        return {
          provider,
          model,
          prompt: params.prompt,
          apiKey: params.apiKey,
          ...(provider === 'openai'
            ? { size: requireOpenAIImageSize(params.size) }
            : params.size
              ? { size: params.size }
              : {}),
          ...(params.aspectRatio && { aspectRatio: params.aspectRatio }),
          ...(params.resolution && { resolution: params.resolution }),
          ...(params.quality && { quality: params.quality }),
          ...(params.background && { background: params.background }),
          ...(params.outputFormat && { outputFormat: params.outputFormat }),
          ...(params.moderation && { moderation: params.moderation }),
          ...(params.safetyTolerance && { safetyTolerance: params.safetyTolerance }),
          ...(params.thinkingLevel && { thinkingLevel: params.thinkingLevel }),
          ...(params.inputImageMimeType && { inputImageMimeType: params.inputImageMimeType }),
          ...(referenceInputs.inputImageWarning && {
            inputImageWarning: referenceInputs.inputImageWarning,
          }),
          ...(referenceInputs.inputImages
            ? { inputImages: referenceInputs.inputImages }
            : referenceInputs.inputImage
              ? { inputImage: referenceInputs.inputImage }
              : {}),
          ...(params.enableWebSearch !== undefined && {
            enableWebSearch: parseOptionalBooleanInput(params.enableWebSearch),
          }),
          ...(params.enableSafetyChecker !== undefined && {
            enableSafetyChecker: parseOptionalBooleanInput(params.enableSafetyChecker),
          }),
        }
      },
    },
  },
  inputs: {
    provider: { type: 'string', description: 'Image generation provider' },
    prompt: { type: 'string', description: 'Image description prompt' },
    model: { type: 'string', description: 'Image generation model' },
    size: { type: 'string', description: 'Image size' },
    aspectRatio: { type: 'string', description: 'Image aspect ratio' },
    resolution: { type: 'string', description: 'Image resolution' },
    quality: { type: 'string', description: 'Image quality level' },
    background: { type: 'string', description: 'Background type' },
    outputFormat: { type: 'string', description: 'Output image format' },
    moderation: { type: 'string', description: 'Moderation level' },
    inputImage: {
      type: 'json',
      description:
        'Reference images as uploaded files, Start block files, or file references. GPT Image 2 accepts up to 16 references; other OpenAI models accept one. Gemini models support multi-image fusion (up to 14 on Nano Banana 2, 11 on Pro, 3 on Nano Banana).',
    },
    inputImageUrl: {
      type: 'string',
      description:
        'Reference image URLs or refs. GPT Image 2 accepts up to 16 references; other OpenAI models accept one. Gemini models support multi-image fusion (up to 14 on Nano Banana 2, 11 on Pro, 3 on Nano Banana).',
    },
    inputImages: {
      type: 'json',
      description: 'Multiple input images for Gemini Nano Banana Pro fusion.',
    },
    inputImageUrls: {
      type: 'string',
      description: 'Multiple image URLs or references for Gemini Nano Banana Pro fusion.',
    },
    inputImageMimeType: { type: 'string', description: 'MIME type of input image' },
    inputImageWarning: {
      type: 'string',
      description:
        'Warning emitted when multiple input images were provided and the latest one was used.',
    },
    apiKey: { type: 'string', description: 'Provider API key' },
  },
  outputs: {
    content: { type: 'string', description: 'Generated image URL or identifier' },
    image: { type: 'file', description: 'Generated image file' },
    images: {
      type: 'array',
      description: 'All generated image files',
    },
    imageUrl: { type: 'string', description: 'Generated image URL' },
    provider: { type: 'string', description: 'Provider used' },
    model: { type: 'string', description: 'Model used' },
    metadata: { type: 'json', description: 'Generation metadata' },
  },
}
