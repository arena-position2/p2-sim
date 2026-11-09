import type { ToolConfig } from '@/tools/types'

interface OneTimeCustomer {
  customerId: string
  customerEmail: string
  customerName: string
  totalSpent: number
  orderDate: string
  currency: string
}

export interface ShopifyOneTimeCustomersParams {
  shopDomain: string
  accessToken: string
  idToken?: string
  startDate?: string
  endDate?: string
  limit?: number
}

export interface ShopifyOneTimeCustomersResponse {
  success: boolean
  error?: string
  output: {
    customers: OneTimeCustomer[]
    summary: {
      totalOneTimeCustomers: number
      totalRevenue: number
      averageOrderValue: number
      currency: string
    }
  }
}

export const shopifyOneTimeCustomersTool: ToolConfig<
  ShopifyOneTimeCustomersParams,
  ShopifyOneTimeCustomersResponse
> = {
  id: 'shopify_one_time_customers',
  name: 'Shopify One-Time Customers',
  description: 'Get customers who have only placed a single order',
  version: '1.0.0',

  oauth: {
    required: true,
    provider: 'shopify',
  },

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
      description: 'Start date (format: YYYY-MM-DD)',
    },
    endDate: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'End date (format: YYYY-MM-DD)',
    },
    limit: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Number of customers to return (default: 50)',
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
          query getOrdersForOneTimeCustomers($first: Int!, $query: String) {
            orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  createdAt
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
                    ordersCount
                  }
                  test
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
              query getOrdersForOneTimeCustomers($first: Int!, $query: String, $after: String) {
                orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
                  edges {
                    node {
                      id
                      createdAt
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
                        ordersCount
                      }
                      test
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
            totalOneTimeCustomers: 0,
            totalRevenue: 0,
            averageOrderValue: 0,
            currency: 'USD',
          },
        },
      }
    }

    const oneTimeCustomerMap = new Map<string, OneTimeCustomer>()

    for (const order of allOrders) {
      if (order.test) continue
      const customer = order.customer
      if (!customer?.id || customer.ordersCount !== 1) continue
      if (oneTimeCustomerMap.has(customer.id)) continue

      const amount = Number.parseFloat(order.totalPriceSet?.shopMoney?.amount || '0')
      const currency = order.totalPriceSet?.shopMoney?.currencyCode || 'USD'

      oneTimeCustomerMap.set(customer.id, {
        customerId: customer.id,
        customerEmail: customer.email || 'N/A',
        customerName: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'N/A',
        totalSpent: amount,
        orderDate: order.createdAt,
        currency,
      })
    }

    const customers = Array.from(oneTimeCustomerMap.values())
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, params?.limit || 50)

    const totalRevenue = customers.reduce((sum, c) => sum + c.totalSpent, 0)
    const averageOrderValue = customers.length > 0 ? totalRevenue / customers.length : 0
    const currency = customers[0]?.currency || 'USD'

    return {
      success: true,
      output: {
        customers,
        summary: {
          totalOneTimeCustomers: customers.length,
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          averageOrderValue: Math.round(averageOrderValue * 100) / 100,
          currency,
        },
      },
    }
  },

  outputs: {
    customers: {
      type: 'json',
      description: 'One-time customer data',
    },
    summary: {
      type: 'json',
      description: 'Summary statistics for one-time customers',
    },
  },
}
