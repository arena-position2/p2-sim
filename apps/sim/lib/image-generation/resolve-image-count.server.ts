import type { Candidate } from '@google/genai'
import { createLogger } from '@sim/logger'
import { z } from 'zod'
import { getRotatingApiKey } from '@/lib/core/config/api-keys'
import { MAX_IMAGES_TO_GENERATE } from '@/lib/image-generation/constants'
import { extractTextContent } from '@/providers/google/utils'

const logger = createLogger('ImageGenerationCount')

const SLM_MODEL = 'gemini-3.1-flash-lite'

/** Hard timeout for the SLM call so a hung Gemini request never blocks generation. */
const SLM_TIMEOUT_MS = 8000

/** JSON count extraction needs only a small response; large values slow the SLM call. */
const SLM_MAX_OUTPUT_TOKENS = 256

const PROMPT_IMAGE_URL_REGEX = /https?:\/\/[^\s"'<>`]+/i

const SlmResponseSchema = z.object({
  imageCount: z.number().int().min(1).max(MAX_IMAGES_TO_GENERATE),
  imageUrl: z.string().nullish(),
})

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
} as const

const REQUESTED_OUTPUT_COUNT_REGEX =
  /\b(?:(?:generate|create|make|give|provide|show|produce|render)\s+(?:me\s+)?)?(?<count>[1-5]|one|two|three|four|five)\s+(?:(?:different|separate|distinct)\s+)*(?:variations?|versions?|options?|alternatives?|separate\s+images?|images?|pictures?|renders?|outputs?)\b/i

/** Fallback when the primary pattern misses count tokens before "variations". */
const VARIATION_COUNT_FALLBACK_REGEX =
  /\b(?<count>[1-5]|one|two|three|four|five)\s+(?:(?:different|separate|distinct)\s+)*variations?\b/i

/**
 * Prompt asks for multiple concepts merged into one output file (collage/grid/side-by-side),
 * not merely referencing a single source image.
 */
const COMBINED_OUTPUT_COMPOSITION_REGEX =
  /\b(?:collage|grid|sheet)\b|\bside[\s-]by[\s-]side\b|\b(?:in|into|as|within)\s+(?:a\s+)?(?:single|one)\s+image\b|\bcombined?\s+into\s+(?:a\s+)?(?:single|one)\s+image\b/i

/** Ambiguous multi-image intent that still needs the SLM when no explicit count is present. */
const AMBIGUOUS_MULTI_IMAGE_INTENT_REGEX =
  /\b(?:variations?|versions?|options?|alternatives?|multiple|several|a few|couple of|both)\b|\b(?:two|three|four|five|[2-5])\s+(?:different\s+|separate\s+)?(?:images?|pictures?|renders?|outputs?|variations?|versions?|options?)\b/i

function clampCount(n: number): number {
  return Math.min(MAX_IMAGES_TO_GENERATE, Math.max(1, Math.round(n)))
}

function parseCountToken(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.toLowerCase()
  const wordCount = NUMBER_WORDS[normalized as keyof typeof NUMBER_WORDS]
  if (wordCount) {
    return wordCount
  }

  const numericCount = Number(normalized)
  return Number.isFinite(numericCount) ? clampCount(numericCount) : undefined
}

function extractExplicitVariationCount(prompt: string): number | undefined {
  const match =
    prompt.match(REQUESTED_OUTPUT_COUNT_REGEX) ?? prompt.match(VARIATION_COUNT_FALLBACK_REGEX)
  return parseCountToken(match?.groups?.count)
}

function impliesSingleCombinedOutput(prompt: string, explicitCount: number): boolean {
  if (!COMBINED_OUTPUT_COMPOSITION_REGEX.test(prompt)) {
    return false
  }

  const repeatMultiplierMatch = prompt.match(
    /\b(?<multiplier>[1-5]|one|two|three|four|five)\s+times?\b/i
  )
  const repeatMultiplier = parseCountToken(repeatMultiplierMatch?.groups?.multiplier)
  if (repeatMultiplier !== undefined && repeatMultiplier === explicitCount) {
    return false
  }

  return true
}

function extractExplicitOutputCount(prompt: string): number | undefined {
  const explicitCount = extractExplicitVariationCount(prompt)
  if (explicitCount === undefined) {
    return undefined
  }

  if (impliesSingleCombinedOutput(prompt, explicitCount)) {
    return 1
  }

  return explicitCount
}

function promptNeedsSlmCountResolution(prompt: string): boolean {
  return AMBIGUOUS_MULTI_IMAGE_INTENT_REGEX.test(prompt)
}

function buildResolveResult(
  prompt: string,
  imageCount: number,
  slmSuggested: number,
  promptImageUrl?: string
): ResolveImageGenerationCountResult {
  const count = clampCount(imageCount)
  return {
    imageCount: count,
    slmSuggested,
    promptImageUrl,
    singleImagePrompt: prompt,
    singleImagePrompts: buildPromptsForCount(prompt, count),
  }
}

/**
 * Normalize an image URL extracted from prompt text or SLM output.
 */
function normalizePromptImageUrl(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim().replace(/[),.;!?]+$/, '')
  if (!trimmed) {
    return undefined
  }

  return trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : undefined
}

/**
 * Extract the first image URL present in the prompt text.
 */
function extractPromptImageUrl(prompt: string): string | undefined {
  const match = prompt.match(PROMPT_IMAGE_URL_REGEX)
  return normalizePromptImageUrl(match?.[0])
}

interface ParsedSlmFields {
  imageCount: number
  imageUrl?: string
}

function buildPromptsForCount(basePrompt: string, imageCount: number): string[] {
  const count = clampCount(imageCount)
  return Array.from({ length: count }, () => basePrompt)
}

/**
 * Parses SLM output for a suggested image count and optional image URL.
 * Tries strict JSON first (we request `responseMimeType: application/json`),
 * then falls back to extracting an embedded JSON object, and finally to a digit heuristic.
 */
function parseSuggestedFieldsFromSlmText(text: string): ParsedSlmFields {
  const trimmed = text.trim()

  const candidates: string[] = []
  if (trimmed.startsWith('{')) {
    candidates.push(trimmed)
  }
  const embedded = trimmed.match(/\{[\s\S]*?"imageCount"[\s\S]*?\}/)
  if (embedded && embedded[0] !== trimmed) {
    candidates.push(embedded[0])
  }

  for (const candidate of candidates) {
    try {
      const parsed = SlmResponseSchema.safeParse(JSON.parse(candidate))
      if (parsed.success) {
        const { imageCount, imageUrl } = parsed.data
        return {
          imageCount: clampCount(imageCount),
          imageUrl: imageUrl ? normalizePromptImageUrl(imageUrl) : undefined,
        }
      }
    } catch {
      // try next candidate
    }
  }

  const digit = trimmed.match(/\b([1-5])\b/)
  return {
    imageCount: digit ? Number(digit[1]) : 1,
    imageUrl: extractPromptImageUrl(trimmed),
  }
}

export interface ResolveImageGenerationCountInput {
  prompt: string
}

export interface ResolveImageGenerationCountResult {
  /** Final count suggested by the SLM and capped at the maximum allowed images. */
  imageCount: number
  /** Raw SLM suggestion before clamping. */
  slmSuggested: number
  /** Image URL extracted from the prompt, if any. */
  promptImageUrl?: string
  /** Original user prompt, preserved for provider calls. */
  singleImagePrompt: string
  /** Same original prompt repeated once per requested output image. */
  singleImagePrompts?: string[]
}

/**
 * Uses a small Gemini model to estimate how many distinct images the prompt implies.
 * The original prompt is always preserved for provider calls.
 */
export async function resolveImageGenerationCount(
  input: ResolveImageGenerationCountInput
): Promise<ResolveImageGenerationCountResult> {
  const prompt = input.prompt.trim()
  const promptImageUrl = extractPromptImageUrl(prompt)
  const explicitOutputCount = extractExplicitOutputCount(prompt)
  if (!prompt) {
    return { imageCount: 1, slmSuggested: 1, singleImagePrompt: '', singleImagePrompts: [''] }
  }

  if (explicitOutputCount !== undefined) {
    logger.info('SLM image-count skipped (explicit count)', {
      imageCount: explicitOutputCount,
      hasPromptImageUrl: Boolean(promptImageUrl),
    })
    return buildResolveResult(prompt, explicitOutputCount, explicitOutputCount, promptImageUrl)
  }

  if (!promptNeedsSlmCountResolution(prompt)) {
    logger.info('SLM image-count skipped (single-image prompt)', {
      promptLength: prompt.length,
      hasPromptImageUrl: Boolean(promptImageUrl),
    })
    return buildResolveResult(prompt, 1, 1, promptImageUrl)
  }

  const systemInstruction = `You estimate how many distinct image files the user wants generated.
Count output files, not concepts inside one file.
Reply with only a JSON object: {"imageCount":N,"imageUrl":"..."}.
"imageCount" must be an integer from 1 to ${MAX_IMAGES_TO_GENERATE}.
"imageUrl" must be the first explicit http/https image URL present in the prompt, or null if none is present.
If the prompt explicitly asks for a numbered count of variations, versions, options, alternatives, images, pictures, renders, or outputs, imageCount must be that exact number unless the prompt says to combine them into one image.
If the prompt asks for N variations, versions, options, angles, or alternatives, assume that means N separate output images by default.
Only count 1 when the prompt explicitly says those variations should be combined into one image, one collage, one grid, one sheet, or shown side by side in a single image.
If the prompt asks for a single-image comparison/composition and then asks for that whole image multiple times, count the repeats.
Examples:
- "Give me three variations of this image" => {"imageCount":3,"imageUrl":null}
- "Give me three variations side by side in a single image" => {"imageCount":1,"imageUrl":null}
- "Give me three variations side by side in a single image three times" => {"imageCount":3,"imageUrl":null}
- "Generate 4 separate images of this product" => {"imageCount":4,"imageUrl":null}`

  const userText = `Prompt:\n${prompt.slice(0, 8000)}`

  logger.info('SLM image-count input', {
    model: SLM_MODEL,
    promptLength: prompt.length,
    hasPromptImageUrl: Boolean(promptImageUrl),
    explicitOutputCount,
  })

  let slmSuggested = 1
  let resolvedPromptImageUrl = promptImageUrl

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), SLM_TIMEOUT_MS)

  try {
    const apiKey = getRotatingApiKey('google')

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${SLM_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: userText }] }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          generationConfig: {
            temperature: 0,
            maxOutputTokens: SLM_MAX_OUTPUT_TOKENS,
            responseMimeType: 'application/json',
          },
        }),
        signal: controller.signal,
      }
    )

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}))
      logger.warn('SLM image-count HTTP error', {
        status: response.status,
        message: (errBody as { error?: { message?: string } }).error?.message,
      })
      const fallbackCount = explicitOutputCount ?? 1
      return buildResolveResult(prompt, fallbackCount, fallbackCount, promptImageUrl)
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: unknown; finishReason?: string }>
    }
    const candidate = data.candidates?.[0] as Candidate | undefined
    const text = extractTextContent(candidate)

    if (!text) {
      logger.info('SLM image-count output', {
        parsedSlmSuggested: 1,
        hasPromptImageUrl: Boolean(promptImageUrl),
      })
      const fallbackCount = explicitOutputCount ?? 1
      return buildResolveResult(prompt, fallbackCount, fallbackCount, promptImageUrl)
    }

    const parsed = parseSuggestedFieldsFromSlmText(text)
    slmSuggested = parsed.imageCount
    resolvedPromptImageUrl = parsed.imageUrl ?? promptImageUrl
    logger.info('SLM image-count output', {
      parsedSlmSuggested: slmSuggested,
      hasPromptImageUrl: Boolean(resolvedPromptImageUrl),
      explicitOutputCount,
    })
  } catch (error) {
    const isAbort =
      (error instanceof DOMException && error.name === 'AbortError') ||
      (error instanceof Error && error.name === 'AbortError')
    logger.warn('SLM image-count threw', {
      timedOut: isAbort,
      message: error instanceof Error ? error.message : String(error),
    })
    const fallbackCount = explicitOutputCount ?? 1
    return buildResolveResult(prompt, fallbackCount, fallbackCount, promptImageUrl)
  } finally {
    clearTimeout(timeoutHandle)
  }

  const imageCount = explicitOutputCount ?? clampCount(slmSuggested)
  logger.info('SLM image-count resolved', {
    imageCount,
    slmSuggested,
    explicitOutputCount,
    hasPromptImageUrl: Boolean(resolvedPromptImageUrl),
  })
  return buildResolveResult(prompt, imageCount, slmSuggested, resolvedPromptImageUrl)
}
