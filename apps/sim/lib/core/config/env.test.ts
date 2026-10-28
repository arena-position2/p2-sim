import { describe, expect, it, vi } from 'vitest'
import { envNumber, syncBrowserUseConfiguredPublicFlag } from '@/lib/core/config/env'

vi.unmock('@/lib/core/config/env')

describe('syncBrowserUseConfiguredPublicFlag', () => {
  it('sets the public flag from BROWSER_USE_API_KEY without copying the secret', () => {
    const envVars: NodeJS.ProcessEnv = { BROWSER_USE_API_KEY: 'bu_secret' }

    syncBrowserUseConfiguredPublicFlag(envVars)

    expect(envVars.NEXT_PUBLIC_BROWSER_USE_CONFIGURED).toBe('true')
    expect(envVars.BROWSER_USE_API_KEY).toBe('bu_secret')
  })

  it('does not override an explicit public flag', () => {
    const envVars: NodeJS.ProcessEnv = {
      BROWSER_USE_API_KEY: 'bu_secret',
      NEXT_PUBLIC_BROWSER_USE_CONFIGURED: 'false',
    }

    syncBrowserUseConfiguredPublicFlag(envVars)

    expect(envVars.NEXT_PUBLIC_BROWSER_USE_CONFIGURED).toBe('false')
  })

  it('leaves the public flag unset when no server key is present', () => {
    const envVars: NodeJS.ProcessEnv = {}

    syncBrowserUseConfiguredPublicFlag(envVars)

    expect(envVars.NEXT_PUBLIC_BROWSER_USE_CONFIGURED).toBeUndefined()
  })
})

describe('envNumber', () => {
  it('can require integer env values for count-like settings', () => {
    expect(envNumber('5', 1, { min: 1, integer: true })).toBe(5)
    expect(envNumber('5.5', 1, { min: 1, integer: true })).toBe(1)
    expect(envNumber(5.5, 1, { min: 1, integer: true })).toBe(1)
  })

  it('treats whitespace-only values as unset instead of coercing them to 0', () => {
    expect(envNumber('   ', 1)).toBe(1)
    expect(envNumber('', 1)).toBe(1)
    expect(envNumber(' 1.1 ', 1)).toBe(1.1)
    expect(envNumber('0', 1)).toBe(0)
  })
})
