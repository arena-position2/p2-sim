import type { ToolConfig } from '@/tools/types'
import type { ShopifyBaseParams } from './types'

interface TopSellingProductsParams extends ShopifyBaseParams {
  startDate?: string
  endDate?: string
  limit?: number
}

interface TopProduct {
  productId: string
  productName: string
  productSku: string
  totalQuantitySold: number
  totalRevenue: number
  orderCount: number
}

interface TopSellingProductsResponse {
  success: boolean
  error?: string
  output: {
    products: TopProduct[]
    summary: {
      totalProducts: number
      totalQuantitySold: number
      totalRevenue: number
      topProduct: string
      topProductQuantity: number
    }
  }
}

export const shopifyTopSellingProductsTool: ToolConfig<
  TopSellingProductsParams,
  TopSellingProductsResponse
> = {
  id: 'shopify_top_selling_products',
  name: 'Shopify Top Selling Products',
  description: 'Get top selling products by quantity within a date range',
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
      description: 'Number of top products to return (default: 50)',
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
          query getOrdersWithLineItems($first: Int!, $query: String) {
            orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  lineItems(first: 50) {
                    edges {
                      node {
                        id
                        quantity
                        discountedTotalSet {
                          shopMoney {
                            amount
                            currencyCode
                          }
                        }
                        product {
                          id
                          title
                          variants(first: 1) {
                            edges {
                              node {
                                sku
                              }
                            }
                          }
                        }
                      }
                    }
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
              query getOrdersWithLineItems($first: Int!, $query: String, $after: String) {
                orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
                  edges {
                    node {
                      id
                      lineItems(first: 50) {
                        edges {
                          node {
                            id
                            quantity
                            discountedTotalSet {
                              shopMoney {
                                amount
                                currencyCode
                              }
                            }
                            product {
                              id
                              title
                              variants(first: 1) {
                                edges {
                                  node {
                                    sku
                                  }
                                }
                              }
                            }
                          }
                        }
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
          products: [],
          summary: {
            totalProducts: 0,
            totalQuantitySold: 0,
            totalRevenue: 0,
            topProduct: 'N/A',
            topProductQuantity: 0,
          },
        },
      }
    }

    const productQuantityMap = new Map<string, TopProduct>()

    for (const order of allOrders) {
      const lineItems = order.lineItems?.edges || []
      for (const lineItemEdge of lineItems) {
        const lineItem = lineItemEdge.node
        const product = lineItem.product

        if (!product) continue

        const productId = product.id
        const productName = product.title
        const productSku = product.variants?.edges?.[0]?.node?.sku || 'N/A'
        const quantity = lineItem.quantity || 1
        const revenue = Number.parseFloat(lineItem.discountedTotalSet?.shopMoney?.amount || '0')

        const existing = productQuantityMap.get(productId)
        if (existing) {
          existing.totalQuantitySold += quantity
          existing.totalRevenue += revenue
          existing.orderCount += 1
        } else {
          productQuantityMap.set(productId, {
            productId,
            productName,
            productSku,
            totalQuantitySold: quantity,
            totalRevenue: revenue,
            orderCount: 1,
          })
        }
      }
    }

    const products = Array.from(productQuantityMap.values())
      .sort((a, b) => b.totalQuantitySold - a.totalQuantitySold)
      .slice(0, params?.limit || 50)

    const totalQuantitySold = products.reduce((sum, p) => sum + p.totalQuantitySold, 0)
    const totalRevenue = products.reduce((sum, p) => sum + p.totalRevenue, 0)
    const topProduct = products[0]

    return {
      success: true,
      output: {
        products,
        summary: {
          totalProducts: products.length,
          totalQuantitySold,
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          topProduct: topProduct?.productName || 'N/A',
          topProductQuantity: topProduct?.totalQuantitySold || 0,
        },
      },
    }
  },
  outputs: {
    products: { type: 'json', description: 'Top selling products data' },
    summary: { type: 'json', description: 'Summary statistics' },
  },
}
