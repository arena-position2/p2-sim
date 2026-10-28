import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runImageToolGeneration: vi.fn(),
}))

vi.mock('@/lib/image-generation/run-image-tool.server', () => ({
  runImageToolGeneration: mocks.runImageToolGeneration,
}))

import { executeImageGeneration } from '@/lib/internal/image/operations'

const falInput = {
  provider: 'falai' as const,
  apiKey: 'fal-key',
  model: 'nano-banana-2',
  prompt: 'draw a safe bounded image',
}

describe('image operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates generation to the Arena image tool runner', async () => {
    mocks.runImageToolGeneration.mockResolvedValue({
      content: 'generated',
      imageUrl: 'https://sim.test/generated.png',
      fileName: 'generated.png',
      contentType: 'image/png',
      provider: 'falai',
      model: 'nano-banana-2',
      metadata: {
        provider: 'falai',
        model: 'nano-banana-2',
        contentType: 'image/png',
      },
    })

    const response = await executeImageGeneration(falInput, {
      userId: 'user-1',
      requestId: 'request-1',
    })

    expect(response.status).toBe(200)
    expect((await response.json()).imageUrl).toBe('https://sim.test/generated.png')
    expect(mocks.runImageToolGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        ...falInput,
        userId: 'user-1',
      }),
      expect.objectContaining({ userId: 'user-1', requestId: 'request-1' })
    )
  })

  it('does not generate when the caller has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      executeImageGeneration(falInput, {
        userId: 'user-1',
        requestId: 'request-2',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(mocks.runImageToolGeneration).not.toHaveBeenCalled()
  })

  it('forwards trusted workflow scope so generated images store as file objects', async () => {
    mocks.runImageToolGeneration.mockResolvedValue({
      content: 'generated',
      imageUrl: 'https://sim.test/generated.png',
      image: {
        id: 'file-1',
        name: 'generated.png',
        url: 'https://sim.test/generated.png',
        size: 12,
        type: 'image/png',
        key: 'agent-generated-images/workflow-1/user-1/generated.png',
      },
      fileName: 'generated.png',
      contentType: 'image/png',
      provider: 'falai',
      model: 'nano-banana-2',
      metadata: {
        provider: 'falai',
        model: 'nano-banana-2',
        contentType: 'image/png',
      },
    })

    await executeImageGeneration(falInput, {
      userId: 'user-1',
      workspaceId: 'workspace-1',
      workflowId: 'workflow-1',
      executionId: 'execution-1',
      requestId: 'request-3',
    })

    expect(mocks.runImageToolGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        ...falInput,
        userId: 'user-1',
        workspaceId: 'workspace-1',
        workflowId: 'workflow-1',
        executionId: 'execution-1',
      }),
      expect.objectContaining({
        userId: 'user-1',
        workspaceId: 'workspace-1',
        workflowId: 'workflow-1',
        executionId: 'execution-1',
        requestId: 'request-3',
      })
    )
  })
})
