import type { ToolConfig } from '@/tools/types'
import { parseUnipilePagedBody } from '@/tools/unipile/parse_paged_body'
import type {
  UnipileListPostReactionsParams,
  UnipileListPostReactionsToolResponse,
} from '@/tools/unipile/types'

export const unipileListPostReactionsTool: ToolConfig<
  UnipileListPostReactionsParams,
  UnipileListPostReactionsToolResponse
> = {
  id: 'unipile_list_post_reactions',
  name: 'Unipile List All Post Reactions',
  description:
    'Lists every reaction on a post (`GET /api/v1/posts/{post_id}/reactions`), following Unipile paging until complete. LinkedIn: use the post social_id from GET post or list posts; see https://developer.unipile.com/docs/posts-and-comments Uses server UNIPILE_API_KEY.',
  version: '1.0.0',

  params: {
    post_id: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description:
        'Post id path param. LinkedIn: use `social_id` from the post object (GET post / list posts); the id visible in the URL may not work.',
    },
    account_id: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Unipile connected account id (query param)',
    },
    comment_id: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Optional: list reactions on a comment instead of the post. LinkedIn: comment id from the comments list.',
    },
    limit: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Optional page size per upstream request (1–100, default 100).',
    },
    max_items: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Stop after this many reactions. Omit to load every page.',
    },
  },

  request: {
    url: '/api/tools/unipile/list-post-reactions',
    method: 'POST',
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: (params) => {
      const out: Record<string, unknown> = {
        post_id: params.post_id?.trim(),
        account_id: params.account_id?.trim(),
      }
      if (typeof params.comment_id === 'string' && params.comment_id.trim() !== '') {
        out.comment_id = params.comment_id.trim()
      }
      if (
        params.limit !== undefined &&
        params.limit !== null &&
        Number.isFinite(Number(params.limit))
      ) {
        out.limit = Number(params.limit)
      }
      if (
        params.max_items !== undefined &&
        params.max_items !== null &&
        Number.isFinite(Number(params.max_items))
      ) {
        out.max_items = Number(params.max_items)
      }
      return out
    },
  },

  transformResponse: async (response: Response) => {
    const data = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : 'Unipile request failed')
    }

    return {
      success: true,
      output: parseUnipilePagedBody(data),
    }
  },

  outputs: {
    object: {
      type: 'string',
      description: 'Unipile object type (e.g. PostReactionList)',
      optional: true,
    },
    item_count: {
      type: 'number',
      description: 'Total number of reactions after loading all pages',
    },
    items: { type: 'json', description: 'Post reaction items' },
    cursor: { type: 'string', description: 'Next page cursor', optional: true },
    paging: { type: 'json', description: 'Paging metadata', optional: true },
    total_items: {
      type: 'number',
      description: 'Total items when returned by API',
      optional: true,
    },
  },
}
