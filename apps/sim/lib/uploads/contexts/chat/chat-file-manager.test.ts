/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockProcessExecutionFiles, mockDownloadFile, mockUploadExecutionFile } = vi.hoisted(() => ({
  mockProcessExecutionFiles: vi.fn(),
  mockDownloadFile: vi.fn(),
  mockUploadExecutionFile: vi.fn(),
}))

vi.mock('@/lib/execution/files', () => ({
  processExecutionFiles: mockProcessExecutionFiles,
}))

vi.mock('@/lib/uploads/core/storage-service', () => ({
  downloadFile: mockDownloadFile,
}))

vi.mock('@/lib/uploads/contexts/execution/execution-file-manager', () => ({
  uploadExecutionFile: mockUploadExecutionFile,
}))

import { processChatFiles } from '@/lib/uploads/contexts/chat/chat-file-manager'

describe('processChatFiles', () => {
  const executionContext = {
    workspaceId: 'workspace-1',
    workflowId: 'workflow-1',
    executionId: 'execution-1',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockProcessExecutionFiles.mockResolvedValue([])
    mockDownloadFile.mockResolvedValue(Buffer.from('png'))
    mockUploadExecutionFile.mockResolvedValue({
      id: 'copied-1',
      name: 'image.png',
      size: 3,
      type: 'image/png',
      url: 'https://example.com/execution-file',
      key: 'execution/workspace-1/workflow-1/execution-1/copy/image.png',
      context: 'execution',
    })
  })

  it('copies a generated image from this workflow into the current execution', async () => {
    const files = await processChatFiles(
      [
        {
          url: 'http://localhost:3000/api/files/serve/agent-generated-images%2Fworkflow-1%2Fuser-1%2Fimage.png',
          name: 'image.png',
          type: 'image/png',
        },
      ],
      executionContext,
      'request-1',
      'user-1'
    )

    expect(mockProcessExecutionFiles).not.toHaveBeenCalled()
    expect(mockDownloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'agent-generated-images/workflow-1/user-1/image.png',
        context: 'agent-generated-images',
      })
    )
    expect(mockUploadExecutionFile).toHaveBeenCalledWith(
      executionContext,
      expect.any(Buffer),
      'image.png',
      'image/png',
      'user-1'
    )
    expect(files).toHaveLength(1)
    expect(files[0]?.key).toContain('execution/')
    expect(files[0]?.context).toBe('execution')
  })

  it('copies an image this workflow stored on a previous execution', async () => {
    const previousKey =
      'execution/workspace-1/workflow-1/previous-execution/file-1/generated-image.png'
    const files = await processChatFiles(
      [
        {
          url: `https://dev-agent.thearena.ai/api/files/serve/${encodeURIComponent(previousKey)}`,
          name: 'Generated image',
          type: 'image/png',
        },
      ],
      executionContext,
      'request-1',
      'user-1'
    )

    expect(mockProcessExecutionFiles).not.toHaveBeenCalled()
    expect(mockDownloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: previousKey,
        context: 'execution',
      })
    )
    expect(mockUploadExecutionFile).toHaveBeenCalledWith(
      executionContext,
      expect.any(Buffer),
      'Generated image',
      'image/png',
      'user-1'
    )
    expect(files).toHaveLength(1)
  })

  it('does not copy an execution image from another workflow', async () => {
    await processChatFiles(
      [
        {
          url: 'https://dev-agent.thearena.ai/api/files/serve/execution%2Fworkspace-1%2Fother-workflow%2Fold-execution%2Ffile%2Fgenerated-image.png',
          name: 'Generated image',
          type: 'image/png',
        },
      ],
      executionContext,
      'request-1'
    )

    expect(mockDownloadFile).not.toHaveBeenCalled()
    expect(mockUploadExecutionFile).not.toHaveBeenCalled()
    expect(mockProcessExecutionFiles).toHaveBeenCalledOnce()
  })

  it('does not copy a non-image file from a previous execution', async () => {
    await processChatFiles(
      [
        {
          url: 'https://dev-agent.thearena.ai/api/files/serve/execution%2Fworkspace-1%2Fworkflow-1%2Fold-execution%2Ffile%2Fnotes.json',
          name: 'notes.json',
          type: 'application/json',
        },
      ],
      executionContext,
      'request-1'
    )

    expect(mockDownloadFile).not.toHaveBeenCalled()
    expect(mockProcessExecutionFiles).toHaveBeenCalledOnce()
  })

  it('copies a previous execution image from this workflow into the current execution', async () => {
    const files = await processChatFiles(
      [
        {
          url: 'https://dev-agent.thearena.ai/api/files/serve/execution%2Fworkspace-1%2Fworkflow-1%2Fprevious-execution%2Ffile-1%2Fgenerated-image.png',
          name: 'Generated image',
          type: 'image/png',
        },
      ],
      executionContext,
      'request-1',
      'user-1'
    )

    expect(mockProcessExecutionFiles).not.toHaveBeenCalled()
    expect(mockDownloadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'execution/workspace-1/workflow-1/previous-execution/file-1/generated-image.png',
        context: 'execution',
      })
    )
    expect(mockUploadExecutionFile).toHaveBeenCalledWith(
      executionContext,
      expect.any(Buffer),
      'Generated image',
      'image/png',
      'user-1'
    )
    expect(files[0]?.context).toBe('execution')
  })

  it('does not copy an execution file from another workflow', async () => {
    await processChatFiles(
      [
        {
          url: 'http://localhost:3000/api/files/serve/execution%2Fworkspace-1%2Fother-workflow%2Fprevious-execution%2Ffile-1%2Fgenerated-image.png',
          name: 'Generated image',
          type: 'image/png',
        },
      ],
      executionContext,
      'request-1'
    )

    expect(mockDownloadFile).not.toHaveBeenCalled()
    expect(mockUploadExecutionFile).not.toHaveBeenCalled()
    expect(mockProcessExecutionFiles).toHaveBeenCalledOnce()
  })

  it('does not copy a generated image from another workflow', async () => {
    await processChatFiles(
      [
        {
          url: 'http://localhost:3000/api/files/serve/agent-generated-images%2Fother-workflow%2Fuser-1%2Fimage.png',
          name: 'image.png',
          type: 'image/png',
        },
      ],
      executionContext,
      'request-1'
    )

    expect(mockDownloadFile).not.toHaveBeenCalled()
    expect(mockUploadExecutionFile).not.toHaveBeenCalled()
    expect(mockProcessExecutionFiles).toHaveBeenCalledOnce()
  })

  it('uploads fresh base64 attachments to execution storage', async () => {
    mockProcessExecutionFiles.mockResolvedValue([
      {
        id: 'uploaded-1',
        name: 'upload.png',
        size: 128,
        type: 'image/png',
        url: 'https://example.com/file',
        key: 'execution/workspace-1/workflow-1/execution-1/upload.png',
        context: 'execution',
      },
    ])

    const files = await processChatFiles(
      [
        {
          dataUrl: 'data:image/png;base64,abc',
          name: 'upload.png',
          type: 'image/png',
        },
      ],
      executionContext,
      'request-1'
    )

    expect(mockProcessExecutionFiles).toHaveBeenCalledOnce()
    expect(files[0]?.key).toContain('execution/')
  })
})
