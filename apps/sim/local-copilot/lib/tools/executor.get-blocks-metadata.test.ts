/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeGetBlocksMetadata } = vi.hoisted(() => ({
  executeGetBlocksMetadata: vi.fn(),
}))

vi.mock('@/lib/mothership/tools/server/blocks/get-blocks-metadata-tool', () => ({
  getBlocksMetadataServerTool: {
    name: 'get_blocks_metadata',
    execute: executeGetBlocksMetadata,
  },
}))

import {
  executeLocalCopilotTool,
  type ToolExecutionContext,
} from '@/local-copilot/lib/tools/executor'
import type { LocalCopilotStructuredContext } from '@/local-copilot/lib/types'

const agentMetadata = { type: 'agent', inputs: { messages: { type: 'string' } } }

function metadataContext(): ToolExecutionContext {
  const structuredContext: LocalCopilotStructuredContext = {
    workspace: { id: 'workspace-1', name: 'Workspace', environment: 'self_hosted' },
    connectedIntegrations: [],
    envVariables: [],
    hostedKeysAvailable: false,
    execution: {
      lastRunStatus: 'unknown',
      logs: [],
      failedBlockId: null,
      error: null,
    },
    availableIntegrations: [],
    availableBlocks: [],
  }
  return {
    userId: 'user-1',
    workspaceId: 'workspace-1',
    structuredContext,
  }
}

describe('get_blocks_metadata', () => {
  beforeEach(() => {
    executeGetBlocksMetadata.mockReset()
    executeGetBlocksMetadata.mockResolvedValue({ metadata: { agent: agentMetadata } })
  })

  it('returns field metadata for a new block type and remembers it for edit_workflow', async () => {
    const ctx = metadataContext()

    const result = await executeLocalCopilotTool(
      'get_blocks_metadata',
      { blockIds: ['agent'] },
      ctx
    )

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.result).toMatchObject({ metadata: { agent: agentMetadata } })
    expect(ctx.blocksMetadataByType?.get('agent')).toEqual(agentMetadata)
  })
})
