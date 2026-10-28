/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  COPILOT_API_KEY: undefined as string | undefined,
  COPILOT_API_KEY_2: undefined as string | undefined,
}))

vi.mock('@/lib/core/config/env', () => ({
  env: mockEnv,
}))

import {
  hasCopilotApiKey,
  isCopilotApiKeyFailoverNetworkError,
  isCopilotApiKeyFailoverStatus,
  listCopilotApiKeys,
  requestUsesCopilotApiKey,
  stripCopilotApiKeyHeader,
} from '@/lib/mothership/server/copilot-api-keys'

describe('copilot-api-keys', () => {
  beforeEach(() => {
    mockEnv.COPILOT_API_KEY = undefined
    mockEnv.COPILOT_API_KEY_2 = undefined
  })

  it('returns primary then secondary keys in order', () => {
    mockEnv.COPILOT_API_KEY = 'primary-key'
    mockEnv.COPILOT_API_KEY_2 = 'backup-key'
    expect(listCopilotApiKeys()).toEqual(['primary-key', 'backup-key'])
  })

  it('deduplicates identical primary and secondary keys', () => {
    mockEnv.COPILOT_API_KEY = 'same-key'
    mockEnv.COPILOT_API_KEY_2 = 'same-key'
    expect(listCopilotApiKeys()).toEqual(['same-key'])
  })

  it('reports hasCopilotApiKey when only backup is configured', () => {
    mockEnv.COPILOT_API_KEY_2 = 'backup-only'
    expect(hasCopilotApiKey()).toBe(true)
    expect(listCopilotApiKeys()).toEqual(['backup-only'])
  })

  it('identifies failover HTTP statuses', () => {
    expect(isCopilotApiKeyFailoverStatus(401)).toBe(true)
    expect(isCopilotApiKeyFailoverStatus(429)).toBe(true)
    expect(isCopilotApiKeyFailoverStatus(503)).toBe(true)
    expect(isCopilotApiKeyFailoverStatus(400)).toBe(true)
    expect(isCopilotApiKeyFailoverStatus(500)).toBe(true)
    expect(isCopilotApiKeyFailoverStatus(200)).toBe(false)
  })

  it('retries on fetch errors except AbortError', () => {
    expect(isCopilotApiKeyFailoverNetworkError(new TypeError('fetch failed'))).toBe(true)
    expect(isCopilotApiKeyFailoverNetworkError(new Error('connection reset'))).toBe(true)
    expect(isCopilotApiKeyFailoverNetworkError(new DOMException('Aborted', 'AbortError'))).toBe(
      false
    )
  })

  it('detects copilot auth from x-api-key header', () => {
    expect(requestUsesCopilotApiKey({ 'x-api-key': 'secret' })).toBe(true)
    expect(requestUsesCopilotApiKey({ 'x-api-key': '' })).toBe(false)
    expect(requestUsesCopilotApiKey({})).toBe(false)
  })

  it('strips caller-provided x-api-key headers', () => {
    expect(
      stripCopilotApiKeyHeader({ 'x-api-key': 'old', 'Content-Type': 'application/json' })
    ).toEqual({ 'Content-Type': 'application/json' })
  })
})
