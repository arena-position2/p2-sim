/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSaveGeneratedImage } = vi.hoisted(() => ({
  mockSaveGeneratedImage: vi.fn(),
}))

vi.mock('@/lib/uploads/utils/image-storage.server', () => ({
  saveGeneratedImage: mockSaveGeneratedImage,
}))

vi.mock('@/lib/image-generation/openai-reference.server', () => ({
  generateOpenAIImageEdit: vi.fn(),
}))

vi.mock('@/lib/uploads/utils/file.server', () => ({
  resolveInternalFileUrl: vi.fn(),
}))

import {
  buildImageToolBodyFromExecutionParams,
  runImageToolGeneration,
} from '@/lib/image-generation/run-image-tool.server'

describe('buildImageToolBodyFromExecutionParams', () => {
  it('maps execution context and reference image fields onto the image tool body', () => {
    const body = buildImageToolBodyFromExecutionParams({
      provider: 'openai',
      model: 'gpt-image-2',
      prompt: 'Edit this image',
      inputImage: { key: 'file-key', url: '/api/files/serve/file-key' },
      __usingHostedKey: true,
      _context: {
        userId: 'user-123',
        workspaceId: 'workspace-123',
        workflowId: 'workflow-123',
        executionId: 'execution-123',
      },
    })

    expect(body).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-2',
      prompt: 'Edit this image',
      inputImage: { key: 'file-key', url: '/api/files/serve/file-key' },
      workspaceId: 'workspace-123',
      workflowId: 'workflow-123',
      executionId: 'execution-123',
      userId: 'user-123',
      useHostedCostTracking: true,
    })
  })
})

describe('runImageToolGeneration validation', () => {
  it('rejects an invalid OpenAI model before calling the provider API', async () => {
    await expect(
      runImageToolGeneration(
        buildImageToolBodyFromExecutionParams({
          provider: 'openai',
          model: 'not-a-real-model',
          prompt: 'A scenic mountain landscape',
        }),
        { userId: 'user-123', requestId: 'req-invalid-model' }
      )
    ).rejects.toThrow('Invalid model')
  })

  it('rejects an invalid Gemini aspect ratio before calling the provider API', async () => {
    await expect(
      runImageToolGeneration(
        buildImageToolBodyFromExecutionParams({
          provider: 'gemini',
          model: 'gemini-3.1-flash-image-preview',
          aspectRatio: '99:99',
          prompt: 'A scenic mountain landscape',
        }),
        { userId: 'user-123', requestId: 'req-invalid-aspect' }
      )
    ).rejects.toThrow('Invalid aspect ratio')
  })

  it('rejects an invalid Gemini resolution before calling the provider API', async () => {
    await expect(
      runImageToolGeneration(
        buildImageToolBodyFromExecutionParams({
          provider: 'gemini',
          model: 'gemini-3.1-flash-image-preview',
          resolution: '8K',
          prompt: 'A scenic mountain landscape',
        }),
        { userId: 'user-123', requestId: 'req-invalid-resolution' }
      )
    ).rejects.toThrow('Invalid resolution')
  })

  it('coerces gemini provider to openai for gpt-image-2 before calling the provider API', async () => {
    mockSaveGeneratedImage.mockResolvedValue({
      url: 'https://agent.thearena.ai/api/files/serve/agent-generated-images/workflow-123/user-123/image.png',
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('fake-image').toString('base64') }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )

    await runImageToolGeneration(
      buildImageToolBodyFromExecutionParams({
        provider: 'gemini',
        model: 'gpt-image-2',
        prompt: 'A scenic mountain landscape',
        _context: {
          userId: 'user-123',
          workflowId: 'workflow-123',
        },
      }),
      { userId: 'user-123', requestId: 'req-coerce-provider' }
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
      })
    )

    fetchMock.mockRestore()
  })
})

describe('runImageToolGeneration storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSaveGeneratedImage.mockResolvedValue({
      url: 'https://agent.thearena.ai/api/files/serve/agent-generated-images/workflow-123/user-123/image.png',
    })
  })

  it('stores workflow images via agent-generated-images serve URLs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('generated-image').toString('base64') }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )

    const result = await runImageToolGeneration(
      buildImageToolBodyFromExecutionParams({
        provider: 'openai',
        model: 'gpt-image-2',
        prompt: 'A kangaroo on the beach',
        _context: {
          userId: 'user-123',
          workspaceId: 'workspace-123',
          workflowId: 'workflow-123',
          executionId: 'execution-123',
        },
      }),
      { userId: 'user-123', requestId: 'req-test' }
    )

    expect(mockSaveGeneratedImage).toHaveBeenCalledWith(
      expect.any(String),
      'workflow-123',
      'user-123',
      expect.stringMatching(/^image\//)
    )
    expect(result.imageUrl).toBe(
      'https://agent.thearena.ai/api/files/serve/agent-generated-images/workflow-123/user-123/image.png'
    )
    expect(result.imageUrl).toContain('/api/files/serve/agent-generated-images/')
    expect(result.imageUrl).not.toContain('X-Amz-Signature')
    expect(result.image).toMatchObject({
      name: expect.stringMatching(/^openai-/),
      url: result.imageUrl,
      type: expect.stringMatching(/^image\//),
      key: 'agent-generated-images/workflow-123/user-123/image.png',
    })
    expect(result.images).toEqual([result.image])

    fetchMock.mockRestore()
  })

  it('stores via agent-generated-images when workflowId comes from operation context', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: Buffer.from('generated-image').toString('base64') }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    )

    await runImageToolGeneration(
      buildImageToolBodyFromExecutionParams({
        provider: 'openai',
        model: 'gpt-image-2',
        prompt: 'A kangaroo on the beach',
      }),
      {
        userId: 'user-123',
        requestId: 'req-context-workflow',
        workflowId: 'workflow-123',
      }
    )

    expect(mockSaveGeneratedImage).toHaveBeenCalledWith(
      expect.any(String),
      'workflow-123',
      'user-123',
      expect.stringMatching(/^image\//)
    )

    fetchMock.mockRestore()
  })
})
