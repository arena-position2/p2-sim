/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  applyImageGeneratorDefaultPairing,
  assertGeminiImageModel,
  getDefaultImageModelForProvider,
  getMaxReferenceImages,
  IMAGE_GENERATOR_DEFAULT_MODEL,
  IMAGE_GENERATOR_DEFAULT_PROVIDER,
  normalizeImageModelId,
  reconcileImageProviderAndModel,
  resolveImageProviderForModel,
  supportsMultipleReferenceImages,
} from '@/lib/image-generation/block-model-config'

describe('resolveImageProviderForModel', () => {
  it('maps catalog OpenAI models to openai', () => {
    expect(resolveImageProviderForModel('gpt-image-2')).toBe('openai')
    expect(resolveImageProviderForModel('gpt-image-1.5')).toBe('openai')
  })

  it('maps catalog Gemini models to gemini', () => {
    expect(resolveImageProviderForModel('gemini-3.1-flash-image-preview')).toBe('gemini')
    expect(resolveImageProviderForModel('gemini-2.5-flash-image')).toBe('gemini')
  })

  it('maps Fal.ai model aliases to falai', () => {
    expect(resolveImageProviderForModel('nano-banana-2')).toBe('falai')
    expect(resolveImageProviderForModel('flux-2-pro')).toBe('falai')
  })

  it('maps OpenAI aliases to openai', () => {
    expect(normalizeImageModelId('chatgpt-image-latest')).toBe('gpt-image-2')
    expect(resolveImageProviderForModel('chatgpt-image-latest')).toBe('openai')
    expect(resolveImageProviderForModel('dall-e-3')).toBe('openai')
  })

  it('normalizes common model typos', () => {
    expect(normalizeImageModelId('gpt-images-2')).toBe('gpt-image-2')
    expect(normalizeImageModelId(' GPT-IMAGE-1-5 ')).toBe('gpt-image-1.5')
  })

  it('allows multiple reference images for gpt-image-2 and alias gpt-images-2', () => {
    expect(getMaxReferenceImages('gpt-image-2')).toBe(16)
    expect(getMaxReferenceImages('gpt-images-2')).toBe(16)
    expect(supportsMultipleReferenceImages('gpt-image-2')).toBe(true)
    expect(supportsMultipleReferenceImages('gpt-image-1.5')).toBe(false)
  })
})

describe('reconcileImageProviderAndModel', () => {
  it('coerces provider from gpt-image-2 when provider is missing', () => {
    expect(reconcileImageProviderAndModel({ model: 'gpt-image-2' })).toEqual({
      provider: 'openai',
      model: 'gpt-image-2',
      coerced: false,
    })
  })

  it('coerces provider from gpt-image-2 when provider is gemini', () => {
    expect(reconcileImageProviderAndModel({ provider: 'gemini', model: 'gpt-image-2' })).toEqual({
      provider: 'openai',
      model: 'gpt-image-2',
      coerced: true,
    })
  })

  it('keeps gemini provider for gemini models', () => {
    expect(
      reconcileImageProviderAndModel({
        provider: 'gemini',
        model: 'gemini-3-pro-image-preview',
      })
    ).toEqual({
      provider: 'gemini',
      model: 'gemini-3-pro-image-preview',
      coerced: false,
    })
  })

  it('defaults to openai and gpt-image-1.5 when both are omitted', () => {
    expect(reconcileImageProviderAndModel({})).toEqual({
      provider: 'openai',
      model: 'gpt-image-1.5',
      coerced: false,
    })
  })

  it('uses provider default model when only provider is set', () => {
    expect(reconcileImageProviderAndModel({ provider: 'gemini' })).toEqual({
      provider: 'gemini',
      model: getDefaultImageModelForProvider('gemini'),
      coerced: false,
    })
  })
})

describe('assertGeminiImageModel', () => {
  it('accepts supported Gemini models', () => {
    expect(() => assertGeminiImageModel('gemini-3.1-flash-image-preview')).not.toThrow()
  })

  it('rejects OpenAI models with a provider hint', () => {
    expect(() => assertGeminiImageModel('gpt-image-2')).toThrow(
      'Model "gpt-image-2" requires provider "openai"'
    )
  })

  it('rejects unknown models', () => {
    expect(() => assertGeminiImageModel('not-a-model')).toThrow('Invalid Gemini model')
  })
})

describe('applyImageGeneratorDefaultPairing', () => {
  it('keeps the Gemini + Nano Banana 2 default pair intact', () => {
    const subBlocks = {
      provider: { value: IMAGE_GENERATOR_DEFAULT_PROVIDER as unknown },
      model: { value: IMAGE_GENERATOR_DEFAULT_MODEL as unknown },
    }

    applyImageGeneratorDefaultPairing(subBlocks)

    expect(subBlocks.provider.value).toBe(IMAGE_GENERATOR_DEFAULT_PROVIDER)
    expect(subBlocks.model.value).toBe(IMAGE_GENERATOR_DEFAULT_MODEL)
  })

  it('clears orphan default provider when model is empty', () => {
    const subBlocks = {
      provider: { value: IMAGE_GENERATOR_DEFAULT_PROVIDER as unknown },
      model: { value: null as unknown },
    }

    applyImageGeneratorDefaultPairing(subBlocks)

    expect(subBlocks.provider.value).toBeNull()
    expect(subBlocks.model.value).toBeNull()
  })

  it('clears orphan default model when provider is empty', () => {
    const subBlocks = {
      provider: { value: null as unknown },
      model: { value: IMAGE_GENERATOR_DEFAULT_MODEL as unknown },
    }

    applyImageGeneratorDefaultPairing(subBlocks)

    expect(subBlocks.provider.value).toBeNull()
    expect(subBlocks.model.value).toBeNull()
  })

  it('does not clear a non-default provider with an empty model', () => {
    const subBlocks = {
      provider: { value: 'openai' as unknown },
      model: { value: null as unknown },
    }

    applyImageGeneratorDefaultPairing(subBlocks)

    expect(subBlocks.provider.value).toBe('openai')
    expect(subBlocks.model.value).toBeNull()
  })
})
