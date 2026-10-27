export type ImageBlockProvider = 'openai' | 'gemini'

export type ImageProvider = ImageBlockProvider | 'falai'

export interface ImageBlockModelOption {
  label: string
  id: string
}

export interface ImageBlockModelDefinition {
  id: string
  label: string
  provider: ImageBlockProvider
  supportsReferenceImages: boolean
  maxReferenceImages: number
}

/** OpenAI GPT Image 2 supports up to 16 reference images on the edits endpoint. */
export const GPT_IMAGE_2_MAX_REFERENCE_IMAGES = 16

const OPENAI_MODEL_DEFINITIONS: ImageBlockModelDefinition[] = [
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    provider: 'openai',
    supportsReferenceImages: true,
    maxReferenceImages: GPT_IMAGE_2_MAX_REFERENCE_IMAGES,
  },
  {
    id: 'gpt-image-1.5',
    label: 'GPT Image 1.5',
    provider: 'openai',
    supportsReferenceImages: true,
    maxReferenceImages: 1,
  },
  {
    id: 'gpt-image-1',
    label: 'GPT Image 1',
    provider: 'openai',
    supportsReferenceImages: true,
    maxReferenceImages: 1,
  },
  {
    id: 'gpt-image-1-mini',
    label: 'GPT Image 1 Mini',
    provider: 'openai',
    supportsReferenceImages: true,
    maxReferenceImages: 1,
  },
]

const GEMINI_MODEL_DEFINITIONS: ImageBlockModelDefinition[] = [
  {
    id: 'gemini-3.1-flash-image-preview',
    label: 'Nano Banana 2',
    provider: 'gemini',
    supportsReferenceImages: true,
    maxReferenceImages: 14,
  },
  {
    id: 'gemini-3-pro-image-preview',
    label: 'Nano Banana Pro',
    provider: 'gemini',
    supportsReferenceImages: true,
    maxReferenceImages: 11,
  },
  {
    id: 'gemini-2.5-flash-image',
    label: 'Nano Banana',
    provider: 'gemini',
    supportsReferenceImages: true,
    maxReferenceImages: 3,
  },
]

export const FALAI_IMAGE_MODEL_IDS = [
  'nano-banana-2',
  'nano-banana-pro',
  'nano-banana',
  'gpt-image-1.5',
  'seedream-v4.5',
  'flux-2-pro',
  'grok-imagine-image',
] as const

export const OPENAI_IMAGE_MODEL_IDS = [
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
] as const

export const GEMINI_IMAGE_MODEL_IDS = [
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image',
] as const

export const IMAGE_BLOCK_MODEL_DEFINITIONS: ImageBlockModelDefinition[] = [
  ...OPENAI_MODEL_DEFINITIONS,
  ...GEMINI_MODEL_DEFINITIONS,
]

export const IMAGE_BLOCK_PROVIDER_OPTIONS: Array<{ label: string; id: ImageBlockProvider }> = [
  { label: 'OpenAI', id: 'openai' },
  { label: 'Google Gemini', id: 'gemini' },
]

export interface ReconcileImageProviderAndModelInput {
  provider?: string
  model?: string
}

export interface ReconcileImageProviderAndModelResult {
  provider: ImageProvider
  model: string | undefined
  coerced: boolean
}

const IMAGE_MODEL_ALIASES: Record<string, string> = {
  'gpt-images-2': 'gpt-image-2',
  'gpt-image2': 'gpt-image-2',
  'chatgpt-image-2': 'gpt-image-2',
  'chatgpt-image-latest': 'gpt-image-2',
  'gpt-image-1-5': 'gpt-image-1.5',
  'gpt-image15': 'gpt-image-1.5',
  'gpt-images-1.5': 'gpt-image-1.5',
}

function normalizeModelId(model: string | undefined): string | undefined {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Normalizes common image model typos and aliases to canonical block model IDs.
 */
export function normalizeImageModelId(modelId: string | undefined): string | undefined {
  const trimmed = normalizeModelId(modelId)
  if (!trimmed) {
    return undefined
  }

  return IMAGE_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed
}

function normalizeProviderId(provider: string | undefined): ImageProvider | undefined {
  const trimmed = typeof provider === 'string' ? provider.trim() : ''
  if (trimmed === 'openai' || trimmed === 'gemini' || trimmed === 'falai') {
    return trimmed
  }
  return undefined
}

/**
 * Resolves the image provider for a model ID using the block catalog and known aliases.
 */
export function resolveImageProviderForModel(modelId: string): ImageProvider | undefined {
  const normalized = normalizeImageModelId(modelId)
  if (!normalized) {
    return undefined
  }

  const definition = getImageBlockModelDefinition(normalized)
  if (definition) {
    return definition.provider
  }

  if ((FALAI_IMAGE_MODEL_IDS as readonly string[]).includes(normalized)) {
    return 'falai'
  }

  if ((OPENAI_IMAGE_MODEL_IDS as readonly string[]).includes(normalized)) {
    return 'openai'
  }

  if (normalized.startsWith('gemini-') || normalized.startsWith('imagen-')) {
    return 'gemini'
  }

  if (normalized.startsWith('gpt-image') || normalized.startsWith('dall-e')) {
    return 'openai'
  }

  return undefined
}

/**
 * Returns a default model for a provider when the caller did not specify one.
 */
export function getDefaultImageModelForProvider(provider: ImageProvider): string {
  if (provider === 'gemini') {
    return 'gemini-3.1-flash-image-preview'
  }
  if (provider === 'falai') {
    return 'nano-banana-2'
  }
  return 'gpt-image-1.5'
}

/** Editor / Copilot default when dropping or creating an Image Generator v2 block. */
export const IMAGE_GENERATOR_DEFAULT_PROVIDER: ImageBlockProvider = 'gemini'

/** Nano Banana 2 — matches {@link getDefaultImageModelForProvider}(`gemini`). */
export const IMAGE_GENERATOR_DEFAULT_MODEL = getDefaultImageModelForProvider(
  IMAGE_GENERATOR_DEFAULT_PROVIDER
)

/**
 * Image Generator v2 seeds Provider+Model as a pair. If only one half of the
 * declared defaults landed (e.g. model permission-denied), clear both so the
 * editor does not show an orphan provider or model.
 */
export function applyImageGeneratorDefaultPairing(
  subBlocks: Record<string, { value: unknown }>
): void {
  const provider = subBlocks.provider?.value
  const model = subBlocks.model?.value
  const providerEmpty = provider == null || provider === ''
  const modelEmpty = model == null || model === ''
  const providerIsDefault = provider === IMAGE_GENERATOR_DEFAULT_PROVIDER
  const modelIsDefault = model === IMAGE_GENERATOR_DEFAULT_MODEL

  if ((providerIsDefault && modelEmpty) || (modelIsDefault && providerEmpty)) {
    if (subBlocks.provider) subBlocks.provider.value = null
    if (subBlocks.model) subBlocks.model.value = null
  }
}

/**
 * Reconciles provider and model so OpenAI models route to OpenAI and Gemini models route to Google.
 * When the model implies a provider, the model wins over a conflicting or missing provider.
 */
export function reconcileImageProviderAndModel(
  input: ReconcileImageProviderAndModelInput
): ReconcileImageProviderAndModelResult {
  const model = normalizeImageModelId(input.model)
  const requestedProvider = normalizeProviderId(input.provider)
  const modelProvider = model ? resolveImageProviderForModel(model) : undefined

  if (modelProvider) {
    const coerced = requestedProvider !== undefined && requestedProvider !== modelProvider
    return {
      provider: modelProvider,
      model,
      coerced,
    }
  }

  const provider = requestedProvider ?? 'openai'
  return {
    provider,
    model: model ?? getDefaultImageModelForProvider(provider),
    coerced: false,
  }
}

/**
 * Validates that a model is allowed for the Gemini generateContent API.
 */
export function assertGeminiImageModel(modelId: string): void {
  const normalized = normalizeModelId(modelId)
  if (!normalized) {
    throw new Error('Gemini model is required')
  }

  if ((GEMINI_IMAGE_MODEL_IDS as readonly string[]).includes(normalized)) {
    return
  }

  const modelProvider = resolveImageProviderForModel(normalized)
  if (modelProvider && modelProvider !== 'gemini') {
    throw new Error(
      `Model "${normalized}" requires provider "${modelProvider}". Received a Gemini request. Set provider to "${modelProvider}" or choose a Gemini model such as "gemini-3.1-flash-image-preview".`
    )
  }

  throw new Error(
    `Invalid Gemini model: "${normalized}". Must be one of: ${GEMINI_IMAGE_MODEL_IDS.join(', ')}`
  )
}

export function toModelDropdownOptions(
  models: ImageBlockModelDefinition[]
): ImageBlockModelOption[] {
  return models.map((model) => ({ label: model.label, id: model.id }))
}

export function getImageBlockModelsForProvider(provider: string): ImageBlockModelDefinition[] {
  return IMAGE_BLOCK_MODEL_DEFINITIONS.filter((model) => model.provider === provider)
}

export function getImageBlockModelDefinition(
  modelId: string
): ImageBlockModelDefinition | undefined {
  const normalized = normalizeImageModelId(modelId) ?? modelId
  return IMAGE_BLOCK_MODEL_DEFINITIONS.find((model) => model.id === normalized)
}

export function getReferenceImageModelIds(): string[] {
  return IMAGE_BLOCK_MODEL_DEFINITIONS.filter((model) => model.supportsReferenceImages).map(
    (model) => model.id
  )
}

export function getMaxReferenceImages(modelId: string): number {
  return getImageBlockModelDefinition(modelId)?.maxReferenceImages ?? 1
}

export function supportsMultipleReferenceImages(modelId: string): boolean {
  return getMaxReferenceImages(modelId) > 1
}

export const OPENAI_GPT_IMAGE_MODELS = toModelDropdownOptions(OPENAI_MODEL_DEFINITIONS)
export const GEMINI_IMAGE_MODELS = toModelDropdownOptions(GEMINI_MODEL_DEFINITIONS)
export const IMAGE_BLOCK_ALL_MODEL_OPTIONS = toModelDropdownOptions(IMAGE_BLOCK_MODEL_DEFINITIONS)
export const IMAGE_BLOCK_MODEL_IDS = IMAGE_BLOCK_MODEL_DEFINITIONS.map((model) => model.id)
