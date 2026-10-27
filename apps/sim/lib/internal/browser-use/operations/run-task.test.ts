import { jsonResponse } from '@sim/testing/helpers/http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  BROWSER_USE_API_KEY: undefined as string | undefined,
}))

vi.mock('@/lib/core/config/env', () => ({
  env: mockEnv,
  getEnv: (key: string) => (mockEnv as Record<string, string | undefined>)[key],
  isTruthy: (value: unknown) => Boolean(value),
  isFalsy: () => false,
  envBoolean: () => false,
}))

import { executeRunTaskOperation } from '@/lib/internal/browser-use/operations/run-task'

const mockFetch = vi.fn<typeof fetch>()

function mockSuccessfulTask() {
  mockFetch
    .mockResolvedValueOnce(jsonResponse({ id: 'task-1', sessionId: 'session-1' }))
    .mockResolvedValueOnce(
      jsonResponse({
        status: 'finished',
        sessionId: 'session-1',
        output: { result: 'complete' },
        steps: [],
      })
    )
    .mockResolvedValueOnce(
      jsonResponse({
        liveUrl: 'https://live.browser-use.com/session-1',
        publicShareUrl: 'https://browser-use.com/share/session-1',
      })
    )
}

describe('executeRunTaskOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.BROWSER_USE_API_KEY = undefined
    vi.stubGlobal('fetch', mockFetch)
  })

  it('uses the created profile session to fetch the live URL when task status omits it', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'profile-session' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'finished', output: 'done' }))
      .mockResolvedValueOnce(
        jsonResponse({
          liveUrl: 'https://live.browser-use.com/profile-session',
          publicShareUrl: 'https://browser-use.com/share/profile-session',
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const result = await executeRunTaskOperation({
      task: 'Open the page',
      apiKey: 'api-key',
      profile_id: 'profile-1',
    })

    expect(result.output).toMatchObject({
      sessionId: 'profile-session',
      liveUrl: 'https://live.browser-use.com/profile-session',
      shareUrl: 'https://browser-use.com/share/profile-session',
    })
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      'https://api.browser-use.com/api/v2/sessions/profile-session',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('propagates cancellation while still stopping a created profile session', async () => {
    const controller = new AbortController()
    const abortError = new DOMException('cancelled', 'AbortError')
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'profile-session' }))
      .mockImplementationOnce(async (_input, request) => {
        expect(request?.signal).toBe(controller.signal)
        controller.abort(abortError)
        throw abortError
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(
      executeRunTaskOperation(
        { task: 'Open the page', apiKey: 'api-key', profile_id: 'profile-1' },
        controller.signal
      )
    ).rejects.toBe(abortError)

    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      'https://api.browser-use.com/api/v2/sessions/profile-session',
      expect.objectContaining({
        method: 'PATCH',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    )
    expect(mockFetch.mock.calls[2]?.[1]?.signal).not.toBe(controller.signal)
  })

  it('stops an automatically created task session when polling is cancelled', async () => {
    const controller = new AbortController()
    const abortError = new DOMException('cancelled', 'AbortError')
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1', sessionId: 'task-session' }))
      .mockImplementationOnce(async () => {
        controller.abort(abortError)
        throw abortError
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(
      executeRunTaskOperation({ task: 'Open the page', apiKey: 'api-key' }, controller.signal)
    ).rejects.toBe(abortError)

    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      'https://api.browser-use.com/api/v2/sessions/task-session',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ action: 'stop' }),
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('stops an automatically created task session when polling times out', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1_000_000_000_000_000)
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1', sessionId: 'task-session' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'running', sessionId: 'task-session' }))
      .mockResolvedValueOnce(
        jsonResponse({ shareUrl: 'https://browser-use.com/share/task-session' })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const result = await executeRunTaskOperation({ task: 'Open the page', apiKey: 'api-key' })
    now.mockRestore()

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Task did not complete within the maximum polling time'),
    })
    expect(mockFetch).toHaveBeenNthCalledWith(
      4,
      'https://api.browser-use.com/api/v2/sessions/task-session',
      expect.objectContaining({ method: 'PATCH', signal: expect.any(AbortSignal) })
    )
  })

  it('uses BROWSER_USE_API_KEY from the server env when the block key is empty', async () => {
    mockEnv.BROWSER_USE_API_KEY = 'env-browser-use-key'
    mockSuccessfulTask()

    const result = await executeRunTaskOperation({ task: 'Open the page' })

    expect(result.success).toBe(true)
    expect(mockFetch.mock.calls[0]?.[0]).toBe('https://api.browser-use.com/api/v2/tasks')
    expect(mockFetch.mock.calls[1]?.[0]).toBe('https://api.browser-use.com/api/v2/tasks/task-1')
    for (const [, request] of mockFetch.mock.calls) {
      expect(request).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Browser-Use-API-Key': 'env-browser-use-key' }),
        })
      )
    }
  })

  it('prefers a block apiKey over BROWSER_USE_API_KEY', async () => {
    mockEnv.BROWSER_USE_API_KEY = 'env-browser-use-key'
    mockSuccessfulTask()

    await executeRunTaskOperation({ task: 'Open the page', apiKey: 'block-key' })

    expect(mockFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Browser-Use-API-Key': 'block-key' }),
      })
    )
  })

  it('returns an error when neither the block nor env provides an API key', async () => {
    await expect(executeRunTaskOperation({ task: 'Open the page' })).resolves.toEqual({
      success: false,
      output: {
        id: '',
        success: false,
        output: null,
        steps: [],
        liveUrl: null,
        shareUrl: null,
        sessionId: null,
      },
      error:
        'Browser Use API key is required. Enter it in the block or set BROWSER_USE_API_KEY in the server environment.',
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('accepts Browser Use v2 string cost on task status', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1', sessionId: 'session-1' }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'finished',
          sessionId: 'session-1',
          output: 'done',
          steps: [],
          cost: '0.42',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          liveUrl: null,
          publicShareUrl: 'https://browser-use.com/share/session-1',
        })
      )

    const result = await executeRunTaskOperation({ task: 'Open the page', apiKey: 'api-key' })

    expect(result.success).toBe(true)
    expect(result.output.__totalCostUsd).toBe(0.42)
  })
})
