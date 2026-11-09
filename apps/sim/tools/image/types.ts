import type { ToolResponse } from '@/tools/types'

export interface ImageGenerationParams {
  provider?: 'openai' | 'gemini' | 'falai' | 'higgsfield'
  apiKey?: string
  model?: string
  prompt: string
  size?: string
  aspectRatio?: string
  resolution?: string
  quality?: string
  background?: string
  outputFormat?: string
  moderation?: string
  safetyTolerance?: string
  seed?: number
  enableSafetyChecker?: boolean
  enableWebSearch?: boolean
  thinkingLevel?: string
  inputImage?: unknown
  inputImages?: unknown[]
  inputImageUrl?: string
  inputImageUrls?: string
  inputImageMimeType?: string
  inputImageWarning?: string
  numImages?: number
}

export interface ImageGenerationResponse extends ToolResponse {
  output: {
    content: string
    image: unknown
    images: unknown[]
    imageUrl: string
    provider: string
    model: string
    metadata: {
      provider: string
      model: string
      description?: string
      revisedPrompt?: string
      seed?: number
      jobId?: string
      contentType?: string
      count?: number
      requested?: number
      failed?: number
      warnings?: string[]
      s3UploadFailed?: boolean
    }
    s3UploadFailed?: boolean
    __imageBilling?: {
      provider: string
      model: string
      size?: string
      quality?: string
      resolution?: string
      aspectRatio?: string
      numImages?: number
      hasEdit?: boolean
      providerCostPerImage: number
      imageCount: number
      costMultiplier: number
    }
    __falaiCostDollars?: number
    __falaiBilling?: {
      endpointId: string
      requestId: string
      source: 'billing_events' | 'historical_estimate' | 'fallback_floor'
      outputUnits?: number | null
      unitPrice?: number | null
      percentDiscount?: number | null
      currency?: string
      error?: string
    }
  }
}
