import { describe, expect, it } from 'vitest'
import { googleAdsSearchTool } from '@/tools/google_ads/search'

function mockResponse(body: unknown, status = 200): Response {
  // double-cast-allowed: lightweight Response stub for transformResponse unit test
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('googleAdsSearchTool.transformResponse', () => {
  it('exposes results as an array when the API returns rows', async () => {
    const rows = [{ campaign: { id: '1' } }, { campaign: { id: '2' } }]
    const result = await googleAdsSearchTool.transformResponse!(
      mockResponse({ results: rows, totalResultsCount: '2' })
    )

    expect(result.success).toBe(true)
    expect(Array.isArray(result.output.results)).toBe(true)
    expect(result.output.results).toEqual(rows)
    expect(result.output.totalResultsCount).toBe(2)
  })

  it('defaults results to an empty array when the API omits results', async () => {
    const result = await googleAdsSearchTool.transformResponse!(
      mockResponse({ totalResultsCount: '0' })
    )

    expect(result.success).toBe(true)
    expect(result.output.results).toEqual([])
    expect(Array.isArray(result.output.results)).toBe(true)
  })

  it('keeps results an empty array on API errors so downstream blocks do not see undefined', async () => {
    const result = await googleAdsSearchTool.transformResponse!(
      mockResponse({ error: { message: 'PERMISSION_DENIED' } }, 403)
    )

    expect(result.success).toBe(false)
    expect(result.output.results).toEqual([])
    expect(Array.isArray(result.output.results)).toBe(true)
    expect(result.error).toBe('PERMISSION_DENIED')
  })
})
