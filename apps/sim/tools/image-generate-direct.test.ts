/**
 * @vitest-environment node
 */
import { inputValidationMock } from '@sim/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRunImageGenerationWrapper, mockRunImageToolGeneration, mockBuildImageToolBody } =
  vi.hoisted(() => ({
    mockRunImageGenerationWrapper: vi.fn(),
    mockRunImageToolGeneration: vi.fn(),
    mockBuildImageToolBody: vi.fn(),
  }))

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

vi.mock('@/lib/image-generation/run-image-tool.server', () => ({
  runImageToolGeneration: mockRunImageToolGeneration,
  buildImageToolBodyFromExecutionParams: mockBuildImageToolBody,
}))

vi.mock('@/tools/registry', () => ({
  tools: {
    image_generate: {
      id: 'image_generate',
      name: 'Image Generate',
      description: 'Generate images',
      version: '1.0.0',
      params: {
        provider: { type: 'string', required: true },
        prompt: { type: 'string', required: true },
      },
      request: {
        url: '/api/tools/image-generation',
        method: 'POST',
        headers: () => ({ 'Content-Type': 'application/json' }),
      },
      outputs: {
        image: { type: 'file', description: 'Generated image' },
      },
    },
  },
}))

import { executeTool } from '@/tools'

describe('image_generate direct execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunImageGenerationWrapper.mockResolvedValue({
      success: true,
      output: { image: 'https://example.com/wrapper.png' },
    })
    mockBuildImageToolBody.mockImplementation((params: Record<string, unknown>) => params)
    mockRunImageToolGeneration.mockResolvedValue({
      content: 'https://example.com/direct.png',
      imageUrl: 'https://example.com/direct.png',
      fileName: 'openai-gpt-image-2.png',
      contentType: 'image/png',
      provider: 'openai',
      model: 'gpt-image-2',
      metadata: {
        provider: 'openai',
        model: 'gpt-image-2',
        contentType: 'image/png',
      },
    })
  })

  it('bypasses the smart wrapper when __skipSmartWrapper is true', async () => {
    const params = {
      provider: 'openai',
      model: 'gpt-image-2',
      prompt: 'Edit this image',
      inputImage: { key: 'file-key', url: '/api/files/serve/file-key' },
      __skipSmartWrapper: true,
      __skipHostedKeyHandling: true,
      _context: {
        userId: 'user-123',
        workflowId: 'workflow-123',
        workspaceId: 'workspace-123',
        executionId: 'execution-123',
      },
    }

    const result = await executeTool('image_generate', params)

    expect(result.success).toBe(true)
    expect(mockRunImageToolGeneration).toHaveBeenCalledTimes(1)
    expect(mockRunImageToolGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-image-2',
        prompt: 'Edit this image',
      }),
      {
        userId: 'user-123',
        workspaceId: 'workspace-123',
        workflowId: 'workflow-123',
        executionId: 'execution-123',
      }
    )
    expect(mockRunImageGenerationWrapper).not.toHaveBeenCalled()
    expect(result.output).toMatchObject({
      imageUrl: 'https://example.com/direct.png',
      provider: 'openai',
      model: 'gpt-image-2',
    })
  })

  it('uses the smart wrapper for normal image_generate calls', async () => {
    const params = {
      provider: 'openai',
      model: 'gpt-image-2',
      prompt: 'A red sports car',
      _context: {
        userId: 'user-123',
        workflowId: 'workflow-123',
        workspaceId: 'workspace-123',
      },
    }

    const result = await executeTool('image_generate', params)

    expect(result.success).toBe(true)
    expect(mockRunImageGenerationWrapper).toHaveBeenCalledTimes(1)
    expect(mockRunImageGenerationWrapper).toHaveBeenCalledWith(
      {
        baseToolId: 'image_generate',
        params: expect.objectContaining({
          provider: 'openai',
          model: 'gpt-image-2',
          prompt: 'A red sports car',
        }),
      },
      expect.any(Object)
    )
    expect(mockRunImageToolGeneration).not.toHaveBeenCalled()
    expect(result.error).toBeUndefined()
    expect(result.output).toMatchObject({
      image: 'https://example.com/wrapper.png',
    })
  })

  it('returns generated images when no trusted execution context is present', async () => {
    const result = await executeTool('image_generate', {
      provider: 'openai',
      model: 'gpt-image-2',
      prompt: 'A red sports car',
    })

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.output).toMatchObject({
      image: 'https://example.com/wrapper.png',
    })
  })
})
