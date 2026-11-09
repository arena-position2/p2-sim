import type { ToolConfig } from '@/tools/types'
import type { ShopifyBaseParams } from './types'

interface TopCustomersParams extends ShopifyBaseParams {
  startDate?: string
  endDate?: string
  limit?: number
}

interface TopCustomer {
  customerId: string
  customerEmail: string
  customerName: string
  totalRevenue: number
  orderCount: number
  averageOrderValue: number
}

interface TopCustomersResponse {
  success: boolean
  error?: string
  output: {
    customers: TopCustomer[]
    summary: {
      totalCustomers: number
      totalRevenue: number
      topCustomer: string
      topCustomerRevenue: number
      averageRevenuePerCustomer: number
    }
  }
}

export const shopifyTopCustomersTool: ToolConfig<TopCustomersParams, TopCustomersResponse> = {
  id: 'shopify_top_customers',
  name: 'Shopify Top Customers',
  description: 'Get top customers by revenue within a date range',
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
      description: 'Number of top customers to return (default: 50)',
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
                  customer {
                    id
                    email
                    firstName
                    lastName
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
                      customer {
                        id
                        email
                        firstName
                        lastName
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
          customers: [],
          summary: {
            totalCustomers: 0,
            totalRevenue: 0,
            topCustomer: 'N/A',
            topCustomerRevenue: 0,
            averageRevenuePerCustomer: 0,
          },
        },
      }
    }

    const customerRevenueMap = new Map<string, TopCustomer>()

    for (const order of allOrders) {
      const customer = order.customer
      if (!customer || !customer.id) continue

      const customerId = customer.id
      const customerEmail = customer.email || 'N/A'
      const customerName =
        [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'N/A'
      const revenue = Number.parseFloat(order.totalPriceSet?.shopMoney?.amount || '0')

      const existing = customerRevenueMap.get(customerId)
      if (existing) {
        existing.totalRevenue += revenue
        existing.orderCount += 1
        existing.averageOrderValue = existing.totalRevenue / existing.orderCount
      } else {
        customerRevenueMap.set(customerId, {
          customerId,
          customerEmail,
          customerName,
          totalRevenue: revenue,
          orderCount: 1,
          averageOrderValue: revenue,
        })
      }
    }

    const customers = Array.from(customerRevenueMap.values())
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, params?.limit || 50)

    const totalRevenue = customers.reduce((sum, c) => sum + c.totalRevenue, 0)
    const topCustomer = customers[0]
    const averageRevenuePerCustomer = customers.length > 0 ? totalRevenue / customers.length : 0

    return {
      success: true,
      output: {
        customers,
        summary: {
          totalCustomers: customers.length,
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          topCustomer: topCustomer?.customerName || 'N/A',
          topCustomerRevenue: topCustomer ? Math.round(topCustomer.totalRevenue * 100) / 100 : 0,
          averageRevenuePerCustomer: Math.round(averageRevenuePerCustomer * 100) / 100,
        },
      },
    }
  },
  outputs: {
    customers: { type: 'json', description: 'Top customers data' },
    summary: { type: 'json', description: 'Summary statistics' },
  },
}
