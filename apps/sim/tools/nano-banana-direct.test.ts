/**
 * @vitest-environment node
 */
import { inputValidationMock } from '@sim/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGenerateNanoBananaImage } = vi.hoisted(() => ({
  mockGenerateNanoBananaImage: vi.fn(),
}))

vi.mock('@/lib/core/config/env-flags', () => ({
  isHosted: false,
  isProd: false,
  isDev: true,
  isTest: true,
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

vi.mock('@/app/api/google/api-service', () => ({
  generateNanoBananaImage: (...args: unknown[]) => mockGenerateNanoBananaImage(...args),
}))

import { executeTool } from '@/tools'

describe('google_nano_banana direct execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGenerateNanoBananaImage.mockResolvedValue({
      toolResponse: {
        success: true,
        output: { image: 'generated-image-url' },
      },
      httpStatus: 200,
    })
  })

  it('forwards injected apiKey to generateNanoBananaImage', async () => {
    await executeTool('google_nano_banana', {
      model: 'gemini-3.1-flash-image-preview',
      prompt: 'A red apple',
      apiKey: 'hosted-or-byok-key',
      imageSize: '1K',
    })

    expect(mockGenerateNanoBananaImage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3.1-flash-image-preview',
        prompt: 'A red apple',
        apiKey: 'hosted-or-byok-key',
        imageSize: '1K',
      })
    )
  })
})
