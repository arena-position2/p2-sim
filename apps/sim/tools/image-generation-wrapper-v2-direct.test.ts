/**
 * @vitest-environment node
 */
import { inputValidationMock } from '@sim/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRunImageGenerationWrapper, mockProcessToolOutputs, wrapperTools } = vi.hoisted(() => {
  const fileOutputs = {
    image: { type: 'file', description: 'Generated image' },
    images: {
      type: 'array',
      description: 'Generated images',
      items: { type: 'file', description: 'Generated image' },
    },
  } as const

  function wrapperTool(id: string) {
    return {
      id,
      name: 'Image Generator',
      description: 'Generate images',
      version: '2.0.0',
      params: {
        prompt: { type: 'string', required: true },
      },
      request: {
        url: '/api/tools/image-generation',
        method: 'POST',
        headers: () => ({ 'Content-Type': 'application/json' }),
      },
      outputs: fileOutputs,
    }
  }

  return {
    mockRunImageGenerationWrapper: vi.fn(),
    mockProcessToolOutputs: vi.fn(),
    wrapperTools: {
      openai_image_v2: wrapperTool('openai_image_v2'),
      google_imagen_v2: wrapperTool('google_imagen_v2'),
      google_nano_banana_v2: wrapperTool('google_nano_banana_v2'),
    },
  }
})

vi.mock('@/lib/core/config/env-flags', () => ({
  isHosted: false,
  isProd: false,
  isDev: true,
  isTest: true,
  isSlackExtendedScopesEnabled: false,
}))

vi.mock('@/lib/core/config/env', () => ({
  env: {},
  getEnv: vi.fn(),
  isTruthy: vi.fn(),
  isFalsy: vi.fn(),
  envBoolean: vi.fn(),
}))

vi.mock('@/lib/api-key/byok', () => ({
  getBYOKKey: vi.fn(),
}))

vi.mock('@/lib/auth/internal', () => ({
  generateInternalToken: vi.fn(),
}))

vi.mock('@/ee/access-control/utils/permission-check', () => ({
  assertPermissionsAllowed: vi.fn().mockResolvedValue(undefined),
  validateBlockType: vi.fn().mockResolvedValue(undefined),
  validateMcpToolsAllowed: vi.fn().mockResolvedValue(undefined),
  validateCustomToolsAllowed: vi.fn().mockResolvedValue(undefined),
  validateSkillsAllowed: vi.fn().mockResolvedValue(undefined),
  validateModelProvider: vi.fn().mockResolvedValue(undefined),
  validateInvitationsAllowed: vi.fn().mockResolvedValue(undefined),
  validatePublicApiAllowed: vi.fn().mockResolvedValue(undefined),
  getUserPermissionConfig: vi.fn().mockResolvedValue(null),
  ProviderNotAllowedError: class ProviderNotAllowedError extends Error {},
  IntegrationNotAllowedError: class IntegrationNotAllowedError extends Error {},
  McpToolsNotAllowedError: class McpToolsNotAllowedError extends Error {},
  CustomToolsNotAllowedError: class CustomToolsNotAllowedError extends Error {},
  SkillsNotAllowedError: class SkillsNotAllowedError extends Error {},
  InvitationsNotAllowedError: class InvitationsNotAllowedError extends Error {},
  PublicApiNotAllowedError: class PublicApiNotAllowedError extends Error {},
}))

vi.mock('@/lib/billing/core/usage-log', () => ({}))

vi.mock('@/lib/core/security/input-validation.server', () => inputValidationMock)

vi.mock('@/lib/core/rate-limiter/hosted-key', () => ({
  getHostedKeyRateLimiter: () => ({
    acquireKey: vi.fn(),
    preConsumeCapacity: vi.fn(),
    consumeCapacity: vi.fn(),
  }),
}))

vi.mock('@/lib/uploads/contexts/workspace/file-manager', () => ({
  resolveWorkspaceFileReference: vi.fn(),
}))

vi.mock('@/lib/workspaces/permissions/utils', () => ({
  getWorkspaceWithOwner: vi.fn(),
  hasWorkspaceAdminAccess: vi.fn(),
}))

vi.mock('@/lib/credentials/access', () => ({
  getCredentialActorContext: vi.fn(),
}))

vi.mock('@/lib/credentials/environment', () => ({
  getAccessibleOAuthCredentials: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/image-generation/run-wrapper.server', () => ({
  runImageGenerationWrapper: mockRunImageGenerationWrapper,
}))

vi.mock('@/executor/utils/file-tool-processor', () => ({
  FileToolProcessor: {
    hasFileOutputs: () => true,
    processToolOutputs: mockProcessToolOutputs,
  },
}))

vi.mock('@/tools/registry', () => ({
  tools: wrapperTools,
}))

import { executeTool } from '@/tools'

const WRAPPER_TOOL_IDS = ['openai_image_v2', 'google_imagen_v2', 'google_nano_banana_v2'] as const

describe('image generation wrapper v2 direct execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunImageGenerationWrapper.mockResolvedValue({
      success: true,
      output: { image: 'https://example.com/generated.png' },
    })
    mockProcessToolOutputs.mockImplementation(async (output: Record<string, unknown>) => output)
  })

  it.each(WRAPPER_TOOL_IDS)(
    'returns generated images for %s without a trusted execution context',
    async (toolId) => {
      const result = await executeTool(toolId, {
        prompt: 'A red sports car',
        model: 'gpt-image-1',
      })

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.output).toMatchObject({
        image: 'https://example.com/generated.png',
      })
      expect(mockRunImageGenerationWrapper).toHaveBeenCalledTimes(1)
    }
  )

  it.each(WRAPPER_TOOL_IDS)(
    'forwards trusted execution context to the %s wrapper',
    async (toolId) => {
      const executionContext = {
        workflowId: 'wf-1',
        workspaceId: 'ws-1',
        executionId: 'ex-1',
        userId: 'user-1',
        metadata: {},
      }

      await executeTool(
        toolId,
        { prompt: 'A red sports car', model: 'gpt-image-1' },
        { executionContext: executionContext as never }
      )

      expect(mockRunImageGenerationWrapper).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ prompt: 'A red sports car' }),
        }),
        expect.objectContaining({
          executionContext,
        })
      )
    }
  )
})
