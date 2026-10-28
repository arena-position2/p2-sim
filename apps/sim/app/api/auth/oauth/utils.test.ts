/**
 * Tests for OAuth utility functions
 */

import { redisConfigMockFns } from '@sim/testing'
import { encryptionMock, encryptionMockFns } from '@sim/testing/mocks/encryption.mock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/oauth/oauth', () => ({
  refreshOAuthToken: vi.fn(),
  OAUTH_PROVIDERS: {},
  TOKEN_REFRESH_TIMEOUT_MS: 15_000,
}))

vi.mock('@/lib/core/security/encryption', () => encryptionMock)

const { mockMinter } = vi.hoisted(() => ({ mockMinter: vi.fn() }))
vi.mock('@/lib/credentials/client-credential-accounts/server', () => ({
  getClientCredentialAccountMinter: vi.fn(() => mockMinter),
  parseClientCredentialAccountSecretBlob: vi.fn((decrypted: string) => JSON.parse(decrypted)),
}))

import { db } from '@sim/db'
import { __resetCoalesceLocallyForTests } from '@/lib/concurrency/singleflight'
import { ZOOM_SERVICE_ACCOUNT_PROVIDER_ID } from '@/lib/credentials/client-credential-accounts/descriptors'
import { refreshOAuthToken } from '@/lib/oauth'
import {
  getCredential,
  refreshAccessTokenIfNeeded,
  refreshTokenIfNeeded,
  resolveServiceAccountToken,
} from '@/lib/oauth/credential-service'
import { getOAuthRefreshCoordinationIdentity } from '@/lib/oauth/refresh-coordination'
import { GOOGLE_SERVICE_ACCOUNT_PROVIDER_ID } from '@/lib/oauth/types'

const mockDecryptSecret = encryptionMockFns.mockDecryptSecret
encryptionMockFns.mockEncryptSecret.mockImplementation(async (value: string) => ({
  encrypted: value,
  iv: 'iv',
}))

const mockDb = db as any
const mockRefreshOAuthToken = refreshOAuthToken as any

/**
 * Creates a chainable mock for db.select() calls.
 * Returns a nested chain: select() -> from() -> leftJoin()? -> where() -> limit() / orderBy()
 */
function mockSelectChain(limitResult: unknown[]) {
  const mockLimit = vi.fn().mockReturnValue(limitResult)
  const mockOrderBy = vi.fn().mockReturnValue(limitResult)
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit, orderBy: mockOrderBy })
  const afterFrom: Record<string, unknown> = { where: mockWhere }
  afterFrom.leftJoin = vi.fn().mockReturnValue(afterFrom)
  const mockFrom = vi.fn().mockReturnValue(afterFrom)
  mockDb.select.mockReturnValueOnce({ from: mockFrom })
  return { mockFrom, mockWhere, mockLimit }
}

/** Args `performCoalescedRefresh` appends for org-scoped custom OAuth apps. */
const CUSTOM_APP_REFRESH_ARGS = [undefined, undefined, expect.any(Function)] as const

/**
 * Creates a chainable mock for db.update() calls.
 * Returns a nested chain: update() -> set() -> where()
 */
function mockUpdateChain() {
  /** The rotated write returns the row it matched; an empty result means the chain moved first. */
  const mockReturning = vi.fn().mockResolvedValue([{ id: 'account-1' }])
  const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning })
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere })
  mockDb.update.mockReturnValueOnce({ set: mockSet })
  return { mockSet, mockWhere }
}

describe('OAuth Utils', () => {
  beforeEach(() => {
    __resetCoalesceLocallyForTests()
    redisConfigMockFns.mockGetRedisClient.mockReturnValue(null)
    redisConfigMockFns.mockAcquireLock.mockResolvedValue(true)
    redisConfigMockFns.mockReleaseLock.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('getCredential', () => {
    it('should resolve a workspace credential to its underlying account row', async () => {
      const mockCredentialRow = { type: 'oauth', accountId: 'resolved-account-id' }
      const mockAccountRow = { id: 'resolved-account-id', userId: 'test-user-id' }

      mockSelectChain([]) // direct account lookup by id
      mockSelectChain([]) // HubSpot shared-tenant alias lookup
      mockSelectChain([mockCredentialRow])
      mockSelectChain([mockAccountRow])

      const credential = await getCredential('request-id', 'credential-id', 'test-user-id')

      expect(mockDb.select).toHaveBeenCalledTimes(4)

      expect(credential).toMatchObject(mockAccountRow)
      expect(credential).toMatchObject({ resolvedCredentialId: 'resolved-account-id' })
    })

    it('should return the account row directly when the id is a raw account id', async () => {
      const mockAccountRow = { id: 'account-id', userId: 'test-user-id' }
      mockSelectChain([mockAccountRow])

      const credential = await getCredential('request-id', 'account-id', 'test-user-id')

      expect(mockDb.select).toHaveBeenCalledTimes(1)
      expect(credential).toMatchObject(mockAccountRow)
    })

    it('should resolve a shared HubSpot tenant by alias', async () => {
      const mockTokenRow = { id: 'token-row', providerId: 'hubspot', alias: 'northstar' }
      mockSelectChain([])
      mockSelectChain([mockTokenRow])

      const credential = await getCredential('request-id', 'northstar', 'test-user-id')

      expect(credential).toMatchObject(mockTokenRow)
    })

    it('should return undefined when credential is not found', async () => {
      mockSelectChain([])
      mockSelectChain([])
      mockSelectChain([])
      mockSelectChain([])

      const credential = await getCredential('request-id', 'nonexistent-id', 'test-user-id')

      expect(credential).toBeUndefined()
    })
  })

  describe('refreshTokenIfNeeded', () => {
    it('should return valid token without refresh if not expired', async () => {
      const mockCredential = {
        id: 'credential-id',
        accessToken: 'valid-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        providerId: 'google',
      }

      const result = await refreshTokenIfNeeded('request-id', mockCredential, 'credential-id')

      expect(mockRefreshOAuthToken).not.toHaveBeenCalled()
      expect(result).toEqual({ accessToken: 'valid-token', refreshed: false })
    })

    it('should refresh token when expired', async () => {
      const mockCredential = {
        id: 'credential-id',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: new Date(Date.now() - 3600 * 1000),
        providerId: 'google',
      }

      mockRefreshOAuthToken.mockResolvedValueOnce({
        ok: true,
        accessToken: 'new-token',
        expiresIn: 3600,
        refreshToken: 'new-refresh-token',
      })

      const { mockSet } = mockUpdateChain()

      const result = await refreshTokenIfNeeded('request-id', mockCredential, 'credential-id')

      expect(mockRefreshOAuthToken).toHaveBeenCalledWith('google', 'refresh-token')
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: 'new-token',
          refreshToken: 'new-refresh-token',
          accessTokenExpiresAt: expect.any(Date),
        })
      )
      expect(result).toEqual({ accessToken: 'new-token', refreshed: true })
    })

    it('should handle refresh token error', async () => {
      const mockCredential = {
        id: 'credential-id',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: new Date(Date.now() - 3600 * 1000),
        providerId: 'google',
      }

      mockRefreshOAuthToken.mockResolvedValueOnce({
        ok: false,
        errorCode: 'invalid_grant',
        message: 'Failed',
      })

      await expect(
        refreshTokenIfNeeded('request-id', mockCredential, 'credential-id')
      ).rejects.toThrow('Failed to refresh token')
    })

    it('requires reconnection for an expired token without attempting an unavailable refresh', async () => {
      const mockCredential = {
        id: 'credential-id',
        accessToken: 'token',
        refreshToken: null,
        accessTokenExpiresAt: new Date(Date.now() - 3600 * 1000),
        providerId: 'google',
      }

      await expect(
        refreshTokenIfNeeded('request-id', mockCredential, 'credential-id')
      ).rejects.toThrow('OAuth access token expired and cannot be refreshed; reconnect the account')

      expect(mockRefreshOAuthToken).not.toHaveBeenCalled()
    })

    it('keeps a legacy non-expiring Monday credential usable without refreshing it', async () => {
      const legacyCredential = {
        id: 'legacy-monday-credential-id',
        accessToken: 'legacy-monday-access-token',
        refreshToken: null,
        accessTokenExpiresAt: null,
        providerId: 'monday',
      }

      const result = await refreshTokenIfNeeded('request-id', legacyCredential, legacyCredential.id)

      expect(mockRefreshOAuthToken).not.toHaveBeenCalled()
      expect(result).toEqual({ accessToken: 'legacy-monday-access-token', refreshed: false })
    })
  })

  describe('refreshAccessTokenIfNeeded', () => {
    it('should return valid access token without refresh if not expired', async () => {
      const mockResolvedCredential = {
        id: 'credential-id',
        type: 'oauth',
        accountId: 'account-id',
        workspaceId: 'workspace-id',
      }
      const mockAccountRow = {
        id: 'account-id',
        accessToken: 'valid-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        providerId: 'google',
        userId: 'test-user-id',
      }
      mockSelectChain([mockResolvedCredential])
      mockSelectChain([mockAccountRow])

      const token = await refreshAccessTokenIfNeeded('credential-id', 'test-user-id', 'request-id')

      expect(mockRefreshOAuthToken).not.toHaveBeenCalled()
      expect(token).toBe('valid-token')
    })

    it('should refresh token when expired', async () => {
      const mockResolvedCredential = {
        id: 'credential-id',
        type: 'oauth',
        accountId: 'account-id',
        workspaceId: 'workspace-id',
      }
      const mockAccountRow = {
        id: 'account-id',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: new Date(Date.now() - 3600 * 1000),
        providerId: 'google',
        userId: 'test-user-id',
      }
      mockSelectChain([mockResolvedCredential])
      mockSelectChain([mockAccountRow])
      mockUpdateChain()

      mockRefreshOAuthToken.mockResolvedValueOnce({
        ok: true,
        accessToken: 'new-token',
        expiresIn: 3600,
        refreshToken: 'new-refresh-token',
      })

      const token = await refreshAccessTokenIfNeeded('credential-id', 'test-user-id', 'request-id')

      expect(mockRefreshOAuthToken).toHaveBeenCalledWith(
        'google',
        'refresh-token',
        ...CUSTOM_APP_REFRESH_ARGS
      )
      expect(mockDb.update).toHaveBeenCalled()
      expect(token).toBe('new-token')
    })

    it('should return null if credential not found', async () => {
      mockSelectChain([])
      mockSelectChain([])

      const token = await refreshAccessTokenIfNeeded('nonexistent-id', 'test-user-id', 'request-id')

      expect(token).toBeNull()
    })

    it('should return null if refresh fails', async () => {
      const mockResolvedCredential = {
        id: 'credential-id',
        type: 'oauth',
        accountId: 'account-id',
        workspaceId: 'workspace-id',
      }
      const mockAccountRow = {
        id: 'account-id',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: new Date(Date.now() - 3600 * 1000),
        providerId: 'google',
        userId: 'test-user-id',
      }
      mockSelectChain([mockResolvedCredential])
      mockSelectChain([mockAccountRow])

      mockRefreshOAuthToken.mockResolvedValueOnce({
        ok: false,
        errorCode: 'invalid_grant',
        message: 'Failed',
      })

      const token = await refreshAccessTokenIfNeeded('credential-id', 'test-user-id', 'request-id')

      expect(token).toBeNull()
    })
  })

  describe('Slack installation-scoped refresh', () => {
    const SLACK_ACCOUNT_ID = 'T08CM6ZNYBE-usr_U08USBQ9B1T-cbf46a7e-ca75-4a2e-bef5-fd467299eaae'
    const past = new Date(Date.now() - 3600 * 1000)
    const future = new Date(Date.now() + 3600 * 1000)

    /** Select chain for getFreshestSlackChain: where() -> orderBy() -> limit(). */
    function mockSelectOrderedChain(limitResult: unknown[]) {
      const mockLimit = vi.fn().mockReturnValue(limitResult)
      const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy, limit: mockLimit })
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
      mockDb.select.mockReturnValueOnce({ from: mockFrom })
      return { mockWhere, mockOrderBy, mockLimit }
    }

    function slackCredential(overrides: Record<string, unknown> = {}) {
      return {
        id: 'row-1',
        resolvedCredentialId: 'row-1',
        accountId: SLACK_ACCOUNT_ID,
        accessToken: 'stale-at',
        refreshToken: 'stale-rt',
        accessTokenExpiresAt: past,
        providerId: 'slack',
        ...overrides,
      }
    }

    it('locks per installation and refreshes with the freshest sibling refresh token', async () => {
      // The leader rereads the row under the lock.
      mockSelectChain([])
      mockSelectOrderedChain([
        { accessToken: 'stale-at', refreshToken: 'live-rt', accessTokenExpiresAt: past },
      ])
      mockRefreshOAuthToken.mockResolvedValueOnce({
        ok: true,
        accessToken: 'new-at',
        expiresIn: 43200,
        refreshToken: 'new-rt',
      })
      const { mockSet } = mockUpdateChain()

      const result = await refreshTokenIfNeeded('request-id', slackCredential(), 'row-1')

      expect(result).toEqual({ accessToken: 'new-at', refreshed: true })
      const installationIdentity = getOAuthRefreshCoordinationIdentity('slack:T08CM6ZNYBE')
      expect(redisConfigMockFns.mockAcquireLock.mock.calls[0][0]).toBe(
        `oauth:refresh:${installationIdentity}`
      )
      expect(installationIdentity).not.toContain('T08CM6ZNYBE')
      expect(redisConfigMockFns.mockAcquireLock.mock.calls[0][2]).toBe(30)
      expect(mockRefreshOAuthToken).toHaveBeenCalledWith(
        'slack',
        'live-rt',
        ...CUSTOM_APP_REFRESH_ARGS
      )
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'new-at', refreshToken: 'new-rt' })
      )
    })

    it('returns the freshest sibling token without refreshing when it is still valid', async () => {
      // The leader rereads the row under the lock.
      mockSelectChain([])
      mockSelectOrderedChain([
        { accessToken: 'sibling-at', refreshToken: 'live-rt', accessTokenExpiresAt: future },
      ])
      const { mockSet } = mockUpdateChain()

      const result = await refreshTokenIfNeeded('request-id', slackCredential(), 'row-1')

      expect(result).toEqual({ accessToken: 'sibling-at', refreshed: true })
      expect(mockRefreshOAuthToken).not.toHaveBeenCalled()
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: 'sibling-at', refreshToken: 'live-rt' })
      )
    })

    it('dead-flags the installation, not the row, on terminal refresh errors', async () => {
      const fakeRedis = {
        set: vi.fn().mockResolvedValue('OK'),
        get: vi.fn().mockResolvedValue(null),
        del: vi.fn().mockResolvedValue(1),
      }
      redisConfigMockFns.mockGetRedisClient.mockReturnValue(fakeRedis)
      // The leader rereads the row under the lock.
      mockSelectChain([])
      mockSelectOrderedChain([
        { accessToken: 'stale-at', refreshToken: 'live-rt', accessTokenExpiresAt: past },
      ])
      mockRefreshOAuthToken.mockResolvedValueOnce({
        ok: false,
        errorCode: 'invalid_client',
      })
      mockSelectChain([])

      await expect(refreshTokenIfNeeded('request-id', slackCredential(), 'row-1')).rejects.toThrow(
        'Failed to refresh token'
      )

      const installationIdentity = getOAuthRefreshCoordinationIdentity('slack:T08CM6ZNYBE')
      expect(fakeRedis.set).toHaveBeenCalledWith(
        `oauth:dead:${installationIdentity}`,
        'invalid_client',
        'EX',
        3600
      )
    })

    it('skips the dead flag when the chain moved during the failed refresh', async () => {
      const fakeRedis = {
        set: vi.fn().mockResolvedValue('OK'),
        get: vi.fn().mockResolvedValue(null),
        del: vi.fn().mockResolvedValue(1),
      }
      redisConfigMockFns.mockGetRedisClient.mockReturnValue(fakeRedis)
      // The leader rereads the row under the lock.
      mockSelectChain([])
      mockSelectOrderedChain([
        { accessToken: 'stale-at', refreshToken: 'live-rt', accessTokenExpiresAt: past },
      ])
      mockRefreshOAuthToken.mockResolvedValueOnce({
        ok: false,
        errorCode: 'invalid_client',
      })
      mockSelectChain([{ moved: new Date() }])

      await expect(refreshTokenIfNeeded('request-id', slackCredential(), 'row-1')).rejects.toThrow(
        'Failed to refresh token'
      )

      expect(fakeRedis.set).not.toHaveBeenCalled()
    })
  })

  describe('resolveServiceAccountToken', () => {
    it('throws loudly for an unknown provider (never silently attempts Google)', async () => {
      await expect(resolveServiceAccountToken('cred-1', 'mystery-provider')).rejects.toThrow(
        /Unsupported service-account provider/
      )
    })

    it('requires scopes for a Google service account', async () => {
      await expect(
        resolveServiceAccountToken('cred-1', GOOGLE_SERVICE_ACCOUNT_PROVIDER_ID, [])
      ).rejects.toThrow(/Scopes are required/)
    })
  })

  describe('resolveServiceAccountToken — client-credential mint cache', () => {
    const ENCRYPTED_KEY_A = `${'a'.repeat(32)}rest-of-ciphertext`
    const ENCRYPTED_KEY_B = `${'b'.repeat(32)}rest-of-ciphertext`
    const BLOB_FIELDS = { clientId: 'cid', clientSecret: 'cs', orgId: 'org' }

    let now: number
    let dateNowSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      now = 1_750_000_000_000
      dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
      mockDecryptSecret.mockResolvedValue({ decrypted: JSON.stringify(BLOB_FIELDS) })
    })

    afterEach(() => {
      dateNowSpy.mockRestore()
    })

    function mockCredentialRow(encryptedServiceAccountKey: string) {
      mockSelectChain([{ encryptedServiceAccountKey }])
    }

    it('mints once with skipIdentity, then serves cache hits preserving instanceUrl', async () => {
      const credId = 'ccsa-cache-hit'
      mockCredentialRow(ENCRYPTED_KEY_A)
      mockMinter.mockResolvedValueOnce({
        accessToken: 'tok-1',
        expiresInSeconds: 3600,
        instanceUrl: 'https://org.my.salesforce.com',
      })

      const first = await resolveServiceAccountToken(credId, ZOOM_SERVICE_ACCOUNT_PROVIDER_ID)

      expect(first).toEqual({
        accessToken: 'tok-1',
        instanceUrl: 'https://org.my.salesforce.com',
      })
      expect(mockMinter).toHaveBeenCalledWith(BLOB_FIELDS, { skipIdentity: true })

      mockCredentialRow(ENCRYPTED_KEY_A)
      const second = await resolveServiceAccountToken(credId, ZOOM_SERVICE_ACCOUNT_PROVIDER_ID)

      expect(second).toEqual({
        accessToken: 'tok-1',
        instanceUrl: 'https://org.my.salesforce.com',
      })
      expect(mockMinter).toHaveBeenCalledTimes(1)
    })

    it('re-mints when remaining validity is below the 5-minute serve floor', async () => {
      const credId = 'ccsa-ttl-floor'
      mockCredentialRow(ENCRYPTED_KEY_A)
      mockMinter.mockResolvedValueOnce({ accessToken: 'tok-1', expiresInSeconds: 240 })

      await resolveServiceAccountToken(credId, ZOOM_SERVICE_ACCOUNT_PROVIDER_ID)

      mockCredentialRow(ENCRYPTED_KEY_A)
      mockMinter.mockResolvedValueOnce({ accessToken: 'tok-2', expiresInSeconds: 3600 })
      const second = await resolveServiceAccountToken(credId, ZOOM_SERVICE_ACCOUNT_PROVIDER_ID)

      expect(second.accessToken).toBe('tok-2')
      expect(mockMinter).toHaveBeenCalledTimes(2)
    })

    it('re-mints when the stored secret fingerprint changes (credential rotation)', async () => {
      const credId = 'ccsa-rotation'
      mockCredentialRow(ENCRYPTED_KEY_A)
      mockMinter.mockResolvedValueOnce({ accessToken: 'old-app-token', expiresInSeconds: 3600 })

      await resolveServiceAccountToken(credId, ZOOM_SERVICE_ACCOUNT_PROVIDER_ID)

      mockCredentialRow(ENCRYPTED_KEY_B)
      mockMinter.mockResolvedValueOnce({ accessToken: 'new-app-token', expiresInSeconds: 3600 })
      const second = await resolveServiceAccountToken(credId, ZOOM_SERVICE_ACCOUNT_PROVIDER_ID)

      expect(second.accessToken).toBe('new-app-token')
      expect(mockMinter).toHaveBeenCalledTimes(2)
    })

    it('never caches a failed mint as a token but memoizes the failure for ~30s', async () => {
      const credId = 'ccsa-negative-memo'
      const mintError = new Error('invalid_credentials')
      mockCredentialRow(ENCRYPTED_KEY_A)
      mockMinter.mockRejectedValueOnce(mintError)

      await expect(
        resolveServiceAccountToken(credId, ZOOM_SERVICE_ACCOUNT_PROVIDER_ID)
      ).rejects.toBe(mintError)

      mockCredentialRow(ENCRYPTED_KEY_A)
      await expect(
        resolveServiceAccountToken(credId, ZOOM_SERVICE_ACCOUNT_PROVIDER_ID)
      ).rejects.toBe(mintError)
      expect(mockMinter).toHaveBeenCalledTimes(1)

      now += 31_000
      mockCredentialRow(ENCRYPTED_KEY_A)
      mockMinter.mockResolvedValueOnce({ accessToken: 'tok-after', expiresInSeconds: 3600 })
      const result = await resolveServiceAccountToken(credId, ZOOM_SERVICE_ACCOUNT_PROVIDER_ID)

      expect(result.accessToken).toBe('tok-after')
      expect(mockMinter).toHaveBeenCalledTimes(2)
    })
  })
})
