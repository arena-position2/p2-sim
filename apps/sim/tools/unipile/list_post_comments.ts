import type { ToolConfig } from '@/tools/types'
import { parseUnipilePagedBody } from '@/tools/unipile/parse_paged_body'
import type {
  UnipileListPostCommentsParams,
  UnipileListPostCommentsToolResponse,
} from '@/tools/unipile/types'

export const unipileListPostCommentsTool: ToolConfig<
  UnipileListPostCommentsParams,
  UnipileListPostCommentsToolResponse
> = {
  id: 'unipile_list_post_comments',
  name: 'Unipile List Post Comments',
  description:
    'Lists comments on a post (`GET /api/v1/posts/{post_id}/comments`). Requires `account_id` query (Unipile). Optional `cursor`, `limit` (1–100), `sort_by`, `comment_id` (replies). Uses server `UNIPILE_API_KEY`.',
  version: '1.0.0',

  params: {
    post_id: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description:
        'Path `post_id`. LinkedIn: use **`social_id`** (e.g. `urn:li:activity:…`) from GET post / list posts — bare activity digits from the URL are auto-normalized to that URN. Instagram: **provider_id** only (shortcode not supported for this route).',
    },
    account_id: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Unipile connected account id (required query param)',
    },
    cursor: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Pagination cursor from a previous response',
    },
    limit: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Page size 1–100 (Unipile default 100)',
    },
    sort_by: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'MOST_RECENT or MOST_RELEVANT',
    },
    comment_id: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Optional: list replies for this comment id (LinkedIn: from comments list)',
    },
    max_items: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Stop after this many comments, following pages if needed. Omit to return one page.',
    },
  },

  request: {
    url: '/api/tools/unipile/list-post-comments',
    method: 'POST',
    headers: () => ({ 'Content-Type': 'application/json' }),
    body: (params) => {
      const out: Record<string, unknown> = {
        post_id: params.post_id?.trim(),
        account_id: params.account_id?.trim(),
      }
      if (typeof params.cursor === 'string' && params.cursor.trim() !== '') {
        out.cursor = params.cursor.trim()
      }
      if (
        params.limit !== undefined &&
        params.limit !== null &&
        Number.isFinite(Number(params.limit))
      ) {
        out.limit = Number(params.limit)
      }
      if (typeof params.sort_by === 'string' && params.sort_by.trim() !== '') {
        out.sort_by = params.sort_by.trim()
      }
      if (typeof params.comment_id === 'string' && params.comment_id.trim() !== '') {
        out.comment_id = params.comment_id.trim()
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
      description: 'Unipile object type (e.g. CommentList)',
      optional: true,
    },
    item_count: { type: 'number', description: 'Number of comments in this page' },
    items: { type: 'json', description: 'Comment items' },
    cursor: { type: 'string', description: 'Next page cursor', optional: true },
    paging: { type: 'json', description: 'Paging metadata', optional: true },
    total_items: {
      type: 'number',
      description: 'Total items when returned by API',
      optional: true,
    },
  },
}
