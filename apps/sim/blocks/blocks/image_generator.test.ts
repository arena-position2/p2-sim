/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  IMAGE_BLOCK_PROVIDER_OPTIONS,
  IMAGE_GENERATOR_DEFAULT_MODEL,
  IMAGE_GENERATOR_DEFAULT_PROVIDER,
} from '@/lib/image-generation/block-model-config'
import { ImageGeneratorV2Block } from '@/blocks/blocks/image_generator'
import { AGENT_TOOL_BLOCK_TYPES } from '@/blocks/utils'
import { imageGenerateTool } from '@/tools/image/generate'
import { createLLMToolSchema } from '@/tools/params'

describe('ImageGeneratorV2Block', () => {
  it('is eligible as an agent tool', () => {
    expect(AGENT_TOOL_BLOCK_TYPES.has('image_generator_v2')).toBe(true)
  })

  it('resolves to image_generate for agent execution', () => {
    expect(ImageGeneratorV2Block.tools?.access).toEqual(['image_generate'])
    expect(ImageGeneratorV2Block.tools?.config.tool?.({})).toBe('image_generate')
  })

  it('exposes unset image_generate params to the agent except apiKey', async () => {
    const { schema } = await createLLMToolSchema(imageGenerateTool, {})

    expect(schema.properties).toHaveProperty('provider')
    expect(schema.properties).toHaveProperty('model')
    expect(schema.properties).toHaveProperty('prompt')
    expect(schema.properties).toHaveProperty('aspectRatio')
    expect(schema.properties).not.toHaveProperty('apiKey')
    expect(schema.properties).not.toHaveProperty('numImages')
    expect(schema.properties).not.toHaveProperty('inputImage')
    expect(schema.required).toEqual(expect.arrayContaining(['prompt']))
    expect(schema.required).not.toEqual(expect.arrayContaining(['provider', 'model']))
  })

  it('uses combobox for provider, model, aspect ratio, and resolution fields', () => {
    const comboboxIds = new Set(['provider', 'model', 'aspectRatio', 'resolution'])
    const comboboxSubBlocks = ImageGeneratorV2Block.subBlocks.filter(
      (subBlock) => comboboxIds.has(subBlock.id) && subBlock.type === 'combobox'
    )

    expect(comboboxSubBlocks.length).toBeGreaterThan(0)
    expect(
      comboboxSubBlocks.every(
        (subBlock) => typeof subBlock.placeholder === 'string' && subBlock.placeholder.length > 0
      )
    ).toBe(true)
  })

  it('hides preconfigured image_generate params from the agent schema', async () => {
    const { schema } = await createLLMToolSchema(imageGenerateTool, {
      provider: 'openai',
      model: 'gpt-image-2',
      quality: 'high',
    })

    expect(schema.properties).not.toHaveProperty('provider')
    expect(schema.properties).not.toHaveProperty('model')
    expect(schema.properties).not.toHaveProperty('quality')
    expect(schema.properties).toHaveProperty('prompt')
  })

  it('infers openai provider when agent passes gpt-image-2 without provider', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      model: 'gpt-image-2',
      prompt: 'A pricing card with readable text',
      size: 'auto',
    })

    expect(params).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-2',
      prompt: 'A pricing card with readable text',
    })
  })

  it('coerces provider from gpt-images-2 typo when provider is gemini', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      provider: 'gemini',
      model: 'gpt-images-2',
      prompt: 'A poster with headline copy',
      size: 'auto',
    })

    expect(params).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-2',
    })
  })

  it('uses a single always-visible model combobox with all block models', () => {
    const modelSubBlocks = ImageGeneratorV2Block.subBlocks.filter(
      (subBlock) => subBlock.id === 'model'
    )

    expect(modelSubBlocks).toHaveLength(1)
    expect(modelSubBlocks[0]?.condition).toBeUndefined()
    expect(modelSubBlocks[0]?.options?.map((option) => option.id)).toEqual(
      expect.arrayContaining(['gpt-image-2', 'gpt-image-1.5', 'gemini-3.1-flash-image-preview'])
    )
  })

  it('defaults provider to Google Gemini and model to Nano Banana 2', () => {
    const providerSubBlock = ImageGeneratorV2Block.subBlocks.find(
      (subBlock) => subBlock.id === 'provider'
    )
    const modelSubBlock = ImageGeneratorV2Block.subBlocks.find(
      (subBlock) => subBlock.id === 'model'
    )

    expect(IMAGE_GENERATOR_DEFAULT_PROVIDER).toBe('gemini')
    expect(IMAGE_GENERATOR_DEFAULT_MODEL).toBe('gemini-3.1-flash-image-preview')
    expect(providerSubBlock?.defaultValue).toBe(IMAGE_GENERATOR_DEFAULT_PROVIDER)
    expect(modelSubBlock?.defaultValue).toBe(IMAGE_GENERATOR_DEFAULT_MODEL)
  })

  it('allows clearing provider without hiding the model field', () => {
    const providerSubBlock = ImageGeneratorV2Block.subBlocks.find(
      (subBlock) => subBlock.id === 'provider'
    )
    const modelSubBlock = ImageGeneratorV2Block.subBlocks.find(
      (subBlock) => subBlock.id === 'model'
    )

    expect(providerSubBlock?.clearable).toBe(true)
    expect(modelSubBlock?.clearable).toBe(true)
    expect(modelSubBlock?.condition).toBeUndefined()
  })

  it('keeps Nano Banana 2 aspect ratio and resolution optional without editor defaults', () => {
    const nanoBanana2AspectRatio = ImageGeneratorV2Block.subBlocks.find(
      (subBlock) =>
        subBlock.id === 'aspectRatio' &&
        subBlock.condition?.and?.field === 'model' &&
        subBlock.condition?.and?.value === 'gemini-3.1-flash-image-preview'
    )
    const nanoBanana2Resolution = ImageGeneratorV2Block.subBlocks.find(
      (subBlock) =>
        subBlock.id === 'resolution' &&
        subBlock.condition?.and?.field === 'model' &&
        subBlock.condition?.and?.value === 'gemini-3.1-flash-image-preview'
    )

    expect(nanoBanana2AspectRatio?.clearable).toBe(true)
    expect(nanoBanana2AspectRatio?.value?.({})).toBe('')
    expect(nanoBanana2Resolution?.clearable).toBe(true)
    expect(nanoBanana2Resolution?.value?.({})).toBe('')
  })

  it('keeps optional image_generator_v2 combobox and dropdown fields clearable without editor defaults', () => {
    const optionalFieldTypes = new Set(['combobox', 'dropdown'])
    const requiredFieldIds = new Set(['prompt', 'size'])
    // Provider/Model intentionally carry editor defaults (Gemini + Nano Banana 2).
    const defaultedFieldIds = new Set(['provider', 'model'])

    const optionalConfiguredFields = ImageGeneratorV2Block.subBlocks.filter(
      (subBlock) =>
        optionalFieldTypes.has(subBlock.type) &&
        !requiredFieldIds.has(subBlock.id) &&
        !defaultedFieldIds.has(subBlock.id) &&
        subBlock.required !== true
    )

    expect(optionalConfiguredFields.length).toBeGreaterThan(0)
    expect(
      optionalConfiguredFields.every(
        (subBlock) => subBlock.clearable === true && subBlock.value?.({}) === ''
      )
    ).toBe(true)
  })

  it('omits cleared optional image_generator_v2 params from tool params', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image-preview',
      prompt: 'A mountain landscape',
      aspectRatio: '',
      resolution: '',
      size: '',
      quality: '',
      background: '',
      outputFormat: '',
      moderation: '',
      safetyTolerance: '',
      thinkingLevel: '',
    })

    expect(params).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image-preview',
      prompt: 'A mountain landscape',
    })
    expect(params).not.toHaveProperty('aspectRatio')
    expect(params).not.toHaveProperty('resolution')
    expect(params).not.toHaveProperty('size')
    expect(params).not.toHaveProperty('quality')
    expect(params).not.toHaveProperty('background')
    expect(params).not.toHaveProperty('outputFormat')
    expect(params).not.toHaveProperty('moderation')
    expect(params).not.toHaveProperty('safetyTolerance')
    expect(params).not.toHaveProperty('thinkingLevel')
  })

  it('coerces provider to openai when block defaults conflict with gpt-image-2', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      provider: 'gemini',
      model: 'gpt-image-2',
      prompt: 'A poster with headline copy',
      size: 'auto',
    })

    expect(params).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-2',
    })
  })

  const referenceFileA = {
    id: 'file-a',
    name: 'a.png',
    url: 'https://example.com/a.png',
    type: 'image/png',
  }

  const referenceFileB = {
    id: 'file-b',
    name: 'b.png',
    url: 'https://example.com/b.png',
    type: 'image/png',
  }

  it('maps multiple Gemini reference uploads to inputImages for Nano Banana 2', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      provider: 'gemini',
      model: 'gemini-3.1-flash-image-preview',
      prompt: 'Fuse these images',
      inputImage: [referenceFileA, referenceFileB],
    })

    expect(params?.inputImages).toHaveLength(2)
    expect(params?.inputImage).toBeUndefined()
  })

  it('maps multiple Gemini reference uploads to inputImages for Nano Banana Pro', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      provider: 'gemini',
      model: 'gemini-3-pro-image-preview',
      prompt: 'Fuse these images',
      inputImage: [referenceFileA, referenceFileB],
    })

    expect(params?.inputImages).toHaveLength(2)
    expect(params?.inputImage).toBeUndefined()
  })

  it('maps multiple Gemini reference uploads to inputImages for Nano Banana', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      prompt: 'Fuse these images',
      inputImage: [referenceFileA, referenceFileB],
    })

    expect(params?.inputImages).toHaveLength(2)
    expect(params?.inputImage).toBeUndefined()
  })

  it('maps multiple GPT Image 2 reference uploads to inputImages', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      provider: 'openai',
      model: 'gpt-image-2',
      prompt: 'Edit this image',
      size: 'auto',
      inputImage: [referenceFileA, referenceFileB],
    })

    expect(params?.inputImages).toHaveLength(2)
    expect(params?.inputImage).toBeUndefined()
    expect(params?.inputImageWarning).toBeUndefined()
  })

  it('maps multiple OpenAI reference uploads to a single inputImage for GPT Image 1.5', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      provider: 'openai',
      model: 'gpt-image-1.5',
      prompt: 'Edit this image',
      size: 'auto',
      inputImage: [referenceFileA, referenceFileB],
    })

    expect(params?.inputImage).toEqual(referenceFileB)
    expect(params?.inputImages).toBeUndefined()
    expect(params?.inputImageWarning).toBeDefined()
  })

  it('normalizes gpt-images-2 alias for multi-reference limits', () => {
    const params = ImageGeneratorV2Block.tools.config.params?.({
      provider: 'openai',
      model: 'gpt-images-2',
      prompt: 'Composite these references',
      size: 'auto',
      inputImage: [referenceFileA, referenceFileB],
    })

    expect(params?.model).toBe('gpt-image-2')
    expect(params?.inputImages).toHaveLength(2)
  })

  it('does not expose Fal.ai as a selectable provider or falai-gated fields', () => {
    expect(IMAGE_BLOCK_PROVIDER_OPTIONS.every((option) => option.id !== 'falai')).toBe(true)

    const falaiGated = ImageGeneratorV2Block.subBlocks.filter((subBlock) => {
      const condition = subBlock.condition
      if (!condition) return false
      const value = condition.value
      if (value === 'falai') return true
      return Array.isArray(value) && value.includes('falai')
    })

    expect(falaiGated).toHaveLength(0)
  })
})
