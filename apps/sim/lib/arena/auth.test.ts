/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { getHumanArenaHeaders, isAutomationTrigger, resolveArenaAuthMode } from '@/lib/arena/auth'

describe('isAutomationTrigger', () => {
  it('treats schedule and webhook as automation', () => {
    expect(isAutomationTrigger('schedule')).toBe(true)
    expect(isAutomationTrigger('webhook')).toBe(true)
    expect(isAutomationTrigger('Schedule')).toBe(true)
  })

  it('treats interactive triggers as human', () => {
    expect(isAutomationTrigger('manual')).toBe(false)
    expect(isAutomationTrigger('chat')).toBe(false)
    expect(isAutomationTrigger('api')).toBe(false)
    expect(isAutomationTrigger(undefined)).toBe(false)
  })
})

describe('resolveArenaAuthMode', () => {
  it('maps triggers to modes', () => {
    expect(resolveArenaAuthMode('schedule')).toBe('automation')
    expect(resolveArenaAuthMode('webhook')).toBe('automation')
    expect(resolveArenaAuthMode('manual')).toBe('human')
  })
})

describe('getHumanArenaHeaders', () => {
  it('sets authorisation only (no service key / acting user)', () => {
    const headers = getHumanArenaHeaders('access-jwt')
    expect(headers).toEqual({
      authorisation: 'access-jwt',
      Accept: 'application/json',
    })
    expect(headers).not.toHaveProperty('X-Arena-Service-Key')
    expect(headers).not.toHaveProperty('X-Acting-User-Id')
  })
})
