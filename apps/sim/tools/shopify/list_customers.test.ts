import { describe, expect, it } from 'vitest'
import { ShopifyBlock } from '@/blocks/blocks/shopify'
import { shopifyListCustomersTool } from '@/tools/shopify/list_customers'

function mockResponse(body: unknown, status = 200): Response {
  // double-cast-allowed: lightweight Response stub for transformResponse unit test
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('shopify_list_customers output contract', () => {
  it('keeps success on the Shopify block outputs so downstream chips still resolve', () => {
    // Arena restored this after upstream dropped it from block outputs (sync-2026-10-07).
    expect(ShopifyBlock.outputs.success).toEqual({
      type: 'boolean',
      description: 'Operation success status',
    })
  })

  it('returns success true with customers when the Admin API succeeds', async () => {
    const result = await shopifyListCustomersTool.transformResponse!(
      mockResponse({
        data: {
          customers: {
            edges: [{ node: { id: 'gid://shopify/Customer/1', displayName: 'Ada' } }],
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              startCursor: null,
              endCursor: null,
            },
          },
        },
      })
    )

    expect(result.success).toBe(true)
    expect(result.output.customers).toEqual([
      { id: 'gid://shopify/Customer/1', displayName: 'Ada' },
    ])
    expect(result.output.pageInfo).toMatchObject({ hasNextPage: false })
  })

  it('returns success false without inventing customers when the Admin API errors', async () => {
    const result = await shopifyListCustomersTool.transformResponse!(
      mockResponse({ errors: [{ message: 'Throttled' }] }, 429)
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('Throttled')
    expect(result.output).toEqual({})
  })
})
