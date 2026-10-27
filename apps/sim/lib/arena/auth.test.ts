/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  getHumanArenaHeaders,
  isAutomationTrigger,
  resolveArenaAuthMode,
  withArenaAutomationQuery,
} from '@/lib/arena/auth'

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

describe('withArenaAutomationQuery', () => {
  const arenaUrl = 'http://localhost:3000/api/tools/arena/get-my-overdue-tasks?workflowId=wf-1'

  it('adds triggerType and executionId for schedule and webhook', () => {
    expect(withArenaAutomationQuery(arenaUrl, 'schedule', 'exec-1')).toBe(
      'http://localhost:3000/api/tools/arena/get-my-overdue-tasks?workflowId=wf-1&triggerType=schedule&executionId=exec-1'
    )
    expect(withArenaAutomationQuery(arenaUrl, 'Webhook', 'exec-2')).toContain('triggerType=webhook')
  })

  it('leaves manual, API, and non-Arena URLs unchanged', () => {
    expect(withArenaAutomationQuery(arenaUrl, 'manual', 'exec-1')).toBe(arenaUrl)
    expect(withArenaAutomationQuery(arenaUrl, 'api', 'exec-1')).toBe(arenaUrl)
    expect(withArenaAutomationQuery(arenaUrl, undefined, 'exec-1')).toBe(arenaUrl)
    const slackUrl = 'http://localhost:3000/api/tools/slack/send?workflowId=wf-1'
    expect(withArenaAutomationQuery(slackUrl, 'schedule', 'exec-1')).toBe(slackUrl)
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
