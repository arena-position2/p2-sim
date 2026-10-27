import type { ToolResponse } from '@/tools/types'

export interface BaseImageRequestBody {
  model: string
  prompt: string
  size: string
  n: number
  [key: string]: unknown
}

export interface DalleResponse extends ToolResponse {
  output: {
    content: string
    image: string
    images?: string[]
    metadata: {
      model: string
    }
  }
}
