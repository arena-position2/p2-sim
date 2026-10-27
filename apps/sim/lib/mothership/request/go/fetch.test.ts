import { trace } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  COPILOT_API_KEY: undefined as string | undefined,
  COPILOT_API_KEY_2: undefined as string | undefined,
}))

vi.mock('@/lib/core/config/env', () => ({
  env: mockEnv,
}))

import { fetchGo } from '@/lib/mothership/request/go/fetch'

describe('fetchGo', () => {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })

  beforeEach(() => {
    exporter.reset()
    trace.setGlobalTracerProvider(provider)
    vi.restoreAllMocks()
    mockEnv.COPILOT_API_KEY = undefined
    mockEnv.COPILOT_API_KEY_2 = undefined
  })

  it('emits a client span with http.* attrs and injects traceparent', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[0-9a-f]$/)
      return new Response('ok', {
        status: 200,
        headers: { 'content-length': '2' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchGo('https://backend.example.com/api/copilot', {
      method: 'POST',
      body: 'payload',
      operation: 'stream',
      attributes: { 'copilot.leg': 'sim_to_go' },
    })
    expect(res.status).toBe(200)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    const attrs = spans[0].attributes
    expect(spans[0].name).toBe('sim → go /api/copilot')
    expect(attrs['http.method']).toBe('POST')
    expect(attrs['http.url']).toBe('https://backend.example.com/api/copilot')
    expect(attrs['http.target']).toBe('/api/copilot')
    expect(attrs['http.status_code']).toBe(200)
    expect(attrs['copilot.operation']).toBe('stream')
    expect(attrs['copilot.leg']).toBe('sim_to_go')
    expect(typeof attrs['http.response.headers_ms']).toBe('number')
  })

  it('marks span as error on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))

    const res = await fetchGo('https://backend.example.com/api/tools/resume', {
      method: 'POST',
    })
    expect(res.status).toBe(500)

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].status.code).toBe(2)
  })

  it('records exceptions when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network boom')))

    await expect(
      fetchGo('https://backend.example.com/api/traces', { method: 'POST' })
    ).rejects.toThrow('network boom')

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].status.code).toBe(2)
    expect(spans[0].events.some((e) => e.name === 'exception')).toBe(true)
  })

  it('retries with the backup copilot key when primary auth fails', async () => {
    mockEnv.COPILOT_API_KEY = 'primary-key'
    mockEnv.COPILOT_API_KEY_2 = 'backup-key'

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchGo('https://backend.example.com/api/copilot', {
      method: 'POST',
      headers: { 'x-api-key': 'primary-key' },
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ 'x-api-key': 'backup-key' })
    expect(exporter.getFinishedSpans()).toHaveLength(1)
  })

  it('returns the last 401 when both copilot keys are rejected', async () => {
    mockEnv.COPILOT_API_KEY = 'primary-key'
    mockEnv.COPILOT_API_KEY_2 = 'backup-key'

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('still unauthorized', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchGo('https://backend.example.com/api/copilot', {
      method: 'POST',
      headers: { 'x-api-key': 'primary-key' },
    })

    expect(response.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ 'x-api-key': 'backup-key' })
  })
})
