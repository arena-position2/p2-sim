import type { ToolConfig } from '@/tools/types'
import type { ShopifyBaseParams } from './types'

interface RevenueByLocationParams extends ShopifyBaseParams {
  startDate?: string
  endDate?: string
  limit?: number
}

interface LocationRevenue {
  locationId: string
  locationName: string
  locationAddress: string
  totalRevenue: number
  orderCount: number
}

interface RevenueByLocationResponse {
  success: boolean
  error?: string
  output: {
    locations: LocationRevenue[]
    summary: {
      totalLocations: number
      totalRevenue: number
      topLocation: string
      topLocationRevenue: number
    }
  }
}

export const shopifyRevenueByLocationTool: ToolConfig<
  RevenueByLocationParams,
  RevenueByLocationResponse
> = {
  id: 'shopify_revenue_by_location',
  name: 'Shopify Revenue by Location',
  description: 'Get revenue breakdown by shipping location within a date range',
  version: '1.0.0',
  oauth: { required: true, provider: 'shopify' },
  params: {
    shopDomain: {
      type: 'string',
      required: true,
      visibility: 'user-only',
      description: 'Your Shopify store domain (e.g., mystore.myshopify.com)',
    },
    startDate: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Start date (YYYY-MM-DD)',
    },
    endDate: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'End date (YYYY-MM-DD)',
    },
    limit: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Number of top locations to return (default: 50)',
    },
  },
  request: {
    url: (params) =>
      `https://${params.shopDomain || params.idToken}/admin/api/2024-10/graphql.json`,
    method: 'POST',
    headers: (params) => {
      if (!params.accessToken) {
        throw new Error('Missing access token for Shopify API request')
      }
      return {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': params.accessToken,
      }
    },
    body: (params) => {
      let dateQuery = ''
      if (params.startDate || params.endDate) {
        const dateParts: string[] = []
        if (params.startDate) dateParts.push(`created_at:>=${params.startDate}`)
        if (params.endDate) dateParts.push(`created_at:<=${params.endDate}`)
        dateQuery = dateParts.join(' ')
      }

      return {
        query: `
          query getOrders($first: Int!, $query: String) {
            orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  totalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  shippingAddress {
                    city
                    province
                    country
                  }
                }
              }
            }
          }
        `,
        variables: {
          first: 250,
          query: dateQuery || null,
        },
      }
    },
  },

  transformResponse: async (_response, params) => {
    let allOrders: any[] = []

    function buildDateQuery(p: any) {
      let dateQuery = ''
      if (p.startDate || p.endDate) {
        const dateParts: string[] = []
        if (p.startDate) dateParts.push(`created_at:>=${p.startDate}`)
        if (p.endDate) dateParts.push(`created_at:<=${p.endDate}`)
        dateQuery = dateParts.join(' ')
      }
      return dateQuery || null
    }

    const fetchAllOrders = async (currentCursor: string | null) => {
      if (!params) throw new Error('Missing parameters for Shopify API request')
      const res = await fetch(
        `https://${params.shopDomain || params.idToken}/admin/api/2024-10/graphql.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': params.accessToken,
          },
          body: JSON.stringify({
            query: `
              query getOrders($first: Int!, $query: String, $after: String) {
                orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
                  edges {
                    node {
                      id
                      totalPriceSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                      shippingAddress {
                        city
                        province
                        country
                      }
                    }
                    cursor
                  }
                  pageInfo {
                    hasNextPage
                  }
                }
              }
            `,
            variables: {
              first: 250,
              query: buildDateQuery(params),
              after: currentCursor,
            },
          }),
        }
      )

      const data = await res.json()
      if (data.errors) throw new Error(data.errors[0]?.message || 'Failed to fetch orders')

      const ordersData = data.data?.orders
      if (!ordersData) return

      allOrders = [...allOrders, ...ordersData.edges.map((edge: any) => edge.node)]

      if (ordersData.pageInfo.hasNextPage) {
        const lastCursor = ordersData.edges[ordersData.edges.length - 1].cursor
        await fetchAllOrders(lastCursor)
      }
    }

    try {
      await fetchAllOrders(null)
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch orders',
        output: {
          locations: [],
          summary: {
            totalLocations: 0,
            totalRevenue: 0,
            topLocation: 'N/A',
            topLocationRevenue: 0,
          },
        },
      }
    }

    const locationRevenueMap = new Map<string, LocationRevenue>()

    for (const order of allOrders) {
      const shippingAddress = order.shippingAddress
      if (!shippingAddress) continue

      const city = shippingAddress.city || 'Unknown'
      const province = shippingAddress.province || ''
      const country = shippingAddress.country || ''
      const locationKey = `${city}, ${province}, ${country}`.trim()
      const locationId = locationKey.replace(/\s+/g, '_').toLowerCase()
      const revenue = Number.parseFloat(order.totalPriceSet?.shopMoney?.amount || '0')

      const existing = locationRevenueMap.get(locationId)
      if (existing) {
        existing.totalRevenue += revenue
        existing.orderCount += 1
      } else {
        locationRevenueMap.set(locationId, {
          locationId,
          locationName: locationKey,
          locationAddress: locationKey,
          totalRevenue: revenue,
          orderCount: 1,
        })
      }
    }

    const locations = Array.from(locationRevenueMap.values())
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, params?.limit || 50)

    const totalRevenue = locations.reduce((sum, l) => sum + l.totalRevenue, 0)
    const topLocation = locations[0]

    return {
      success: true,
      output: {
        locations,
        summary: {
          totalLocations: locations.length,
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          topLocation: topLocation?.locationName || 'N/A',
          topLocationRevenue: topLocation ? Math.round(topLocation.totalRevenue * 100) / 100 : 0,
        },
      },
    }
  },
  outputs: {
    locations: { type: 'json', description: 'Revenue data per location' },
    summary: { type: 'json', description: 'Summary statistics' },
  },
}
