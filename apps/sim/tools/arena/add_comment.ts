import { createLogger } from '@sim/logger'
import type { ArenaCommentsParams, ArenaCommentsResponse } from '@/tools/arena/types'
import type { ToolConfig } from '@/tools/types'
import { extractMentionedUserIds } from './utils'

const logger = createLogger('ArenaAddComment')

/**
 * Selector-based add comment: always uses `/api/tools/arena/comments`.
 * Task-by-number flow is `arena_comments_task_number` (separate tool).
 */
export const addComment: ToolConfig<ArenaCommentsParams, ArenaCommentsResponse> = {
  id: 'arena_comments',
  name: 'Arena Add Comment',
  description:
    'Add a comment to an Arena task using client, project, group, and task selectors. Set those on the block; you supply the comment text and optional client note.',
  version: '1.0.0',

  params: {
    'comment-client': {
      type: 'object',
      required: true,
      visibility: 'user-only',
      description: 'Client (set in the block; not an LLM argument)',
    },
    'comment-project': {
      type: 'string',
      required: true,
      visibility: 'user-only',
      description: 'Project (set in the block; not an LLM argument)',
    },
    'comment-group': {
      type: 'object',
      required: true,
      visibility: 'user-only',
      description: 'Task group (set in the block; not an LLM argument)',
    },
    'comment-task': {
      type: 'string',
      required: true,
      visibility: 'user-only',
      description: 'Target task (set in the block; not an LLM argument)',
    },
    'comment-text': {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Comment body to post.',
    },
    'comment-client-note': {
      type: 'boolean',
      required: false,
      visibility: 'user-or-llm',
      description: 'Client-facing note (optional). Default false if unsure.',
    },
  },

  request: {
    url: () => `/api/tools/arena/comments`,
    method: 'POST',
    headers: () => ({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }),
    body: (params: ArenaCommentsParams) => {
      if (!params._context?.workflowId) throw new Error('Missing required field: workflowId')

      if (!params['comment-text']) throw new Error('Missing required field: Comment Text')

      const clientNote = Boolean(params['comment-client-note'])

      const commentText = params['comment-text'] || ''

      const userMentionedIds: string[] = extractMentionedUserIds(commentText)

      if (commentText?.includes('@') && userMentionedIds.length === 0) {
        const hasMentionTag =
          commentText.includes('class="mention"') || commentText.includes("class='mention'")
        const hasDataUserId = commentText.includes('data-user-id')

        if (hasMentionTag || hasDataUserId) {
          logger.warn('Mention tags found but no user IDs extracted', {
            commentTextLength: commentText.length,
            commentTextPreview: commentText.substring(0, 300),
            hasMentionClass: hasMentionTag,
            hasDataUserId: hasDataUserId,
            extractedIds: userMentionedIds,
          })
        }
      }

      const clientValue = params['comment-client']
      const clientId = typeof clientValue === 'string' ? clientValue : clientValue?.clientId
      if (!clientId) throw new Error('Missing required field: Client')

      const projectValue = params['comment-project']
      const projectId = typeof projectValue === 'string' ? projectValue : projectValue?.sysId
      if (!projectId) throw new Error('Missing required field: Project')

      const projectName = typeof projectValue === 'string' ? '' : projectValue?.name || ''

      const taskValue = params['comment-task']
      const elementId =
        typeof taskValue === 'string' ? taskValue : taskValue?.sysId || taskValue?.id
      if (!elementId) throw new Error('Missing required field: Task')

      const body: Record<string, unknown> = {
        workflowId: params._context.workflowId,
        elementId: elementId,
        value: commentText,
        projectName: projectName,
        internal: !clientNote,
        showToClient: clientNote,
        userMentionedIds: userMentionedIds,
        name: 'pm_project_task',
        chatFor: 'project',
        parentId: '',
      }

      if (!clientNote) {
        body.element = 'WORK_NOTES'
      }

      return body
    },
  },

  transformResponse: async (response: Response): Promise<ArenaCommentsResponse> => {
    const data = await response.json()
    return {
      success: true,
      output: {
        success: true,
        output: data,
      },
    }
  },

  outputs: {
    success: { type: 'boolean', description: 'Indicates if transform was successful' },
    output: { type: 'object', description: 'Output from Arena' },
  },
}
