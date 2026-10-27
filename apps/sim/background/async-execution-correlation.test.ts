import { describe, expect, it } from 'vitest'
import {
  describeRetryableInfrastructureError,
  isRetryableInfrastructureError,
  withInfrastructureRetry,
} from '@/lib/core/errors/retryable-infrastructure'
import { buildWorkflowCorrelation } from '@/background/workflow-execution'

describe('async execution correlation fallbacks', () => {
  it('falls back for legacy workflow payloads missing correlation fields', () => {
    const correlation = buildWorkflowCorrelation({
      workflowId: 'workflow-1',
      userId: 'user-1',
      triggerType: 'api',
      executionId: 'execution-legacy',
    })

    expect(correlation).toEqual({
      executionId: 'execution-legacy',
      requestId: 'executio',
      source: 'workflow',
      workflowId: 'workflow-1',
      triggerType: 'api',
    })
  })

  it('preserves a trusted Copilot workflow tool binding', () => {
    const correlation = buildWorkflowCorrelation({
      workflowId: 'workflow-1',
      userId: 'user-1',
      triggerType: 'copilot',
      executionId: 'execution-copilot',
      correlation: {
        executionId: 'execution-copilot',
        requestId: 'request-copilot',
        source: 'workflow',
        workflowId: 'workflow-1',
        triggerType: 'copilot',
        copilotToolCallId: 'tool-call-1',
      },
    })

    expect(correlation).toEqual({
      executionId: 'execution-copilot',
      requestId: 'request-copilot',
      source: 'workflow',
      workflowId: 'workflow-1',
      triggerType: 'copilot',
      copilotToolCallId: 'tool-call-1',
    })
  })

  it('classifies retryable driver causes without treating every failed query as retryable', () => {
    const driverError = Object.assign(new Error('remaining connection slots are reserved'), {
      code: '53300',
    })
    const drizzleError = new Error('Failed query: select * from "environment"', {
      cause: driverError,
    })

    expect(isRetryableInfrastructureError(drizzleError)).toBe(true)
    expect(describeRetryableInfrastructureError(drizzleError)).toEqual(
      expect.objectContaining({
        code: '53300',
        message: 'remaining connection slots are reserved',
      })
    )
    expect(
      isRetryableInfrastructureError(new Error('remaining connection slots are reserved'))
    ).toBe(false)
    expect(
      isRetryableInfrastructureError(
        Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' })
      )
    ).toBe(true)
    expect(isRetryableInfrastructureError(new Error('Failed query: syntax error'))).toBe(false)

    const closedDriver = Object.assign(
      new Error('write CONNECTION_CLOSED p2-agents-dev-v2.example:5432'),
      { code: 'CONNECTION_CLOSED', errno: 'CONNECTION_CLOSED' }
    )
    const closedDrizzle = new Error('Failed query: select 1', { cause: closedDriver })
    expect(isRetryableInfrastructureError(closedDrizzle)).toBe(true)
    expect(describeRetryableInfrastructureError(closedDrizzle)).toEqual(
      expect.objectContaining({
        code: 'CONNECTION_CLOSED',
        errno: 'CONNECTION_CLOSED',
      })
    )
  })
})

describe('withInfrastructureRetry', () => {
  it('retries CONNECTION_CLOSED then succeeds', async () => {
    let attempts = 0
    const result = await withInfrastructureRetry(
      async () => {
        attempts += 1
        if (attempts < 3) {
          throw Object.assign(new Error('write CONNECTION_CLOSED host:5432'), {
            code: 'CONNECTION_CLOSED',
            errno: 'CONNECTION_CLOSED',
          })
        }
        return 'ok'
      },
      { maxAttempts: 5, baseMs: 1, maxMs: 2 }
    )

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('does not retry non-infrastructure failures', async () => {
    let attempts = 0
    await expect(
      withInfrastructureRetry(
        async () => {
          attempts += 1
          throw new Error('Failed query: syntax error')
        },
        { maxAttempts: 5, baseMs: 1, maxMs: 2 }
      )
    ).rejects.toThrow('syntax error')
    expect(attempts).toBe(1)
  })
})
