import { describe, expect, it } from 'vitest'
import { getRedisBudgetKeys, getRedisBudgetLimits } from '@/lib/core/redis/byte-budget.server'

describe('getRedisBudgetKeys', () => {
  it('charges the owner only when no user is in scope', () => {
    expect(getRedisBudgetKeys({ kind: 'execution', id: 'exec-1' })).toEqual([
      'execution:redis-budget:execution:exec-1',
    ])
  })

  it('charges the owner and the user when a user is in scope', () => {
    expect(getRedisBudgetKeys({ kind: 'execution', id: 'exec-1', userId: 'user-1' })).toEqual([
      'execution:redis-budget:execution:exec-1',
      'execution:redis-budget:user:user-1',
    ])
  })

  /**
   * These keys are shared with counters written before this module existed, so the
   * execution layout is a wire contract: a change here strands every counter in flight.
   */
  it('gives a stream its own owner and user counters', () => {
    expect(
      getRedisBudgetKeys({ kind: 'copilot_stream', id: 'stream-1', userId: 'user-1' })
    ).toEqual([
      'execution:redis-budget:copilot_stream:stream-1',
      'execution:redis-budget:copilot_stream_user:user-1',
    ])
  })
})

describe('getRedisBudgetLimits', () => {
  it('uses the raised execution SSE Redis ceilings', () => {
    expect(getRedisBudgetLimits('execution')).toEqual({
      maxSingleWriteBytes: 32 * 1024 * 1024,
      maxOwnerBytes: 256 * 1024 * 1024,
      maxUserBytes: 1024 * 1024 * 1024,
      ttlSeconds: 60 * 60,
    })
  })
})
