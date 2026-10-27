/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { parseArenaTokenPair } from '@/lib/arena/tokens'

describe('parseArenaTokenPair', () => {
  it('accepts redeem-style token + refreshToken', () => {
    expect(
      parseArenaTokenPair({
        email: 'a@b.com',
        token: 'access-jwt',
        refreshToken: 'refresh-opaque',
        sysId: 'sys-1',
      })
    ).toEqual({ accessToken: 'access-jwt', refreshToken: 'refresh-opaque' })
  })

  it('accepts refresh-style accessToken + refreshToken', () => {
    expect(
      parseArenaTokenPair({
        accessToken: 'access-jwt',
        refreshToken: 'refresh-opaque',
      })
    ).toEqual({ accessToken: 'access-jwt', refreshToken: 'refresh-opaque' })
  })

  it('rejects incomplete payloads', () => {
    expect(parseArenaTokenPair({ token: 'only-access' })).toBeNull()
    expect(parseArenaTokenPair({ refreshToken: 'only-refresh' })).toBeNull()
    expect(parseArenaTokenPair(null)).toBeNull()
    expect(parseArenaTokenPair({})).toBeNull()
  })
})
