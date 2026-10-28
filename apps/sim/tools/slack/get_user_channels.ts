import type { SlackGetUserChannelsParams, SlackGetUserChannelsResponse } from '@/tools/slack/types'
import { CHANNEL_OUTPUT_PROPERTIES } from '@/tools/slack/types'
import type { ToolConfig } from '@/tools/types'

/**
 * Slack `users.conversations` wrapper.
 *
 * Returns **only** the conversations the token owner is a member of — joined
 * public channels, private channels they belong to, and all of their 1:1 DMs
 * and group DMs. This is the Slack-recommended endpoint when you want a
 * user's own conversation list rather than every visible channel in the
 * workspace.
 *
 * Shape is identical to `conversations.list` (same `types`, `limit`,
 * `exclude_archived`, cursor semantics), so the response transform mirrors
 * `slack_list_channels`.
 *
 * Slack docs: https://api.slack.com/methods/users.conversations
 */
export const slackGetUserChannelsTool: ToolConfig<
  SlackGetUserChannelsParams,
  SlackGetUserChannelsResponse
> = {
  id: 'slack_get_user_channels',
  name: 'Slack Get My Channels & DMs',
  description:
    'List only the conversations the token owner belongs to via Slack users.conversations. Default behavior is channels (public/private) only; DMs are opt-in. If the user asked for 1:1 DMs set includeDMs=true (im:read). If the user asked for group DMs set includeGroupDMs=true (mpim:read).',
  version: '1.0.0',

  oauth: {
    required: true,
    provider: 'slack',
  },

  params: {
    authMethod: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Authentication method: oauth or bot_token',
    },
    botToken: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description: 'Bot token for Custom Bot',
    },
    accessToken: {
      type: 'string',
      required: false,
      visibility: 'hidden',
      description: 'OAuth access token or bot token for Slack API',
    },
    includePublic: {
      type: 'boolean',
      required: false,
      visibility: 'user-or-llm',
      description: 'Include public channels the user has joined (default: true)',
    },
    includePrivate: {
      type: 'boolean',
      required: false,
      visibility: 'user-or-llm',
      description: 'Include private channels the user belongs to (default: true)',
    },
    includeDMs: {
      type: 'boolean',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Set true to include 1:1 DMs (Slack type im). If the user asked for DMs, you must set this to true. Requires im:read scope. Default: false.',
    },
    includeGroupDMs: {
      type: 'boolean',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Set true to include group DMs (Slack type mpim). If the user asked for group DMs, you must set this to true. Requires mpim:read scope. Default: false.',
    },
    excludeArchived: {
      type: 'boolean',
      required: false,
      visibility: 'user-or-llm',
      description: 'Exclude archived channels (default: true)',
    },
    limit: {
      type: 'number',
      required: false,
      visibility: 'user-or-llm',
      description: 'Maximum number of conversations to return (default: 200, max: 200)',
    },
    cursor: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Pagination cursor from a previous response (`output.cursor`) to fetch the next page',
    },
    autoPaginate: {
      type: 'boolean',
      required: false,
      visibility: 'user-or-llm',
      description: 'Fetch all pages automatically (default: true)',
    },
  },

  request: {
    url: (params: SlackGetUserChannelsParams) => {
      const url = new URL('https://slack.com/api/users.conversations')

      // Accept both booleans and their string representations, because the
      // block wiring may forward raw form values ('true' / 'false') through
      // the tool runner depending on the caller path.
      const isTrue = (v: unknown): boolean => v === true || v === 'true'
      const isFalse = (v: unknown): boolean => v === false || v === 'false'

      // Build conversation types list. public_channel and private_channel
      // default on (opt-out); im/mpim are opt-in because they require extra
      // scopes (im:read / mpim:read).
      const types: string[] = []
      if (!isFalse(params.includePublic)) types.push('public_channel')
      if (!isFalse(params.includePrivate)) types.push('private_channel')
      if (isTrue(params.includeDMs)) types.push('im')
      if (isTrue(params.includeGroupDMs)) types.push('mpim')
      // Safety net: if the caller turned everything off, Slack would 400.
      // Fall back to public channels so we still return something useful.
      if (types.length === 0) types.push('public_channel')
      url.searchParams.append('types', types.join(','))

      // Exclude archived by default (opt-out).
      const excludeArchived = !isFalse(params.excludeArchived)
      url.searchParams.append('exclude_archived', String(excludeArchived))

      // Set limit (default 200, max 200 per Slack; use cursor for more pages).
      const limit = params.limit ? Math.min(Number(params.limit), 200) : 200
      url.searchParams.append('limit', String(limit))

      if (typeof params.cursor === 'string') {
        const c = params.cursor.trim()
        if (c) {
          url.searchParams.append('cursor', c)
        }
      }

      return url.toString()
    },
    method: 'GET',
    headers: (params: SlackGetUserChannelsParams) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.accessToken || params.botToken}`,
    }),
  },

  transformResponse: async (response: Response, params?: SlackGetUserChannelsParams) => {
    const data = await response.json()

    if (!data.ok) {
      if (data.error === 'missing_scope') {
        const needed = data.needed ? ` Missing scope: ${data.needed}.` : ''
        throw new Error(
          `Missing required permissions. Please reconnect your Slack account with the necessary scopes (channels:read for public channels, groups:read for private channels, im:read for DMs, mpim:read for group DMs).${needed}`
        )
      }
      if (data.error === 'invalid_auth') {
        throw new Error('Invalid authentication. Please check your Slack credentials.')
      }
      throw new Error(data.error || 'Failed to list user conversations from Slack')
    }

    const isTrue = (v: unknown): boolean => v === true || v === 'true'
    const isFalse = (v: unknown): boolean => v === false || v === 'false'

    const accessToken = params?.accessToken || params?.botToken
    const shouldAutoPaginate =
      params?.autoPaginate === undefined ? true : isTrue(params.autoPaginate)

    const allRaw: any[] = [...(data.channels ?? [])]

    if (shouldAutoPaginate) {
      if (!accessToken) {
        throw new Error('Missing access token for auto pagination')
      }

      let nextCursor = data.response_metadata?.next_cursor
      while (typeof nextCursor === 'string' && nextCursor.trim().length > 0) {
        const url = new URL('https://slack.com/api/users.conversations')

        const types: string[] = []
        if (!isFalse(params?.includePublic)) types.push('public_channel')
        if (!isFalse(params?.includePrivate)) types.push('private_channel')
        if (isTrue(params?.includeDMs)) types.push('im')
        if (isTrue(params?.includeGroupDMs)) types.push('mpim')
        if (types.length === 0) types.push('public_channel')
        url.searchParams.append('types', types.join(','))

        const excludeArchived = !isFalse(params?.excludeArchived)
        url.searchParams.append('exclude_archived', String(excludeArchived))

        const limit = params?.limit ? Math.min(Number(params.limit), 200) : 200
        url.searchParams.append('limit', String(limit))

        url.searchParams.append('cursor', nextCursor.trim())

        const pageResponse = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
        })

        const pageData = await pageResponse.json()
        if (!pageData.ok) {
          throw new Error(pageData.error || 'Failed to paginate Slack conversations')
        }

        allRaw.push(...(pageData.channels ?? []))
        nextCursor = pageData.response_metadata?.next_cursor
      }
    }

    const channels = allRaw.map((channel: any) => {
      const isIm = Boolean(channel.is_im)
      const isMpim = Boolean(channel.is_mpim)
      return {
        id: channel.id,
        // DMs have no `name`; fall back to a stable label so downstream
        // consumers that expect a string don't break.
        name: channel.name || (isIm ? `dm:${channel.user || ''}` : isMpim ? 'group_dm' : ''),
        is_private: channel.is_private || isIm || isMpim,
        is_archived: channel.is_archived || false,
        // users.conversations only returns conversations the caller belongs to,
        // so the implicit answer is "yes" regardless of what Slack sends back.
        is_member: channel.is_member ?? true,
        num_members: channel.num_members,
        topic: channel.topic?.value || '',
        purpose: channel.purpose?.value || '',
        created: channel.created,
        creator: channel.creator,
        is_im: isIm,
        is_mpim: isMpim,
        user: channel.user,
      }
    })

    const ids = channels.map((channel: { id: string }) => channel.id)
    const names = channels.map((channel: { name: string }) => channel.name)

    const nextCursor = shouldAutoPaginate
      ? null
      : typeof data.response_metadata?.next_cursor === 'string' &&
          data.response_metadata?.next_cursor.length > 0
        ? data.response_metadata.next_cursor
        : null

    return {
      success: true,
      output: {
        channels,
        ids,
        names,
        count: channels.length,
        cursor: nextCursor,
        hasMore: Boolean(nextCursor),
        nextCursor,
      },
    }
  },

  outputs: {
    channels: {
      type: 'array',
      description: 'Array of channel objects the token owner belongs to',
      items: {
        type: 'object',
        properties: CHANNEL_OUTPUT_PROPERTIES,
      },
    },
    ids: {
      type: 'array',
      description: 'Array of channel IDs for easy access',
      items: { type: 'string', description: 'Channel ID' },
    },
    names: {
      type: 'array',
      description: 'Array of channel names for easy access',
      items: { type: 'string', description: 'Channel name' },
    },
    count: {
      type: 'number',
      description: 'Total number of channels returned',
    },
    cursor: {
      type: 'string',
      optional: true,
      description:
        'Cursor for the next page (`response_metadata.next_cursor`); absent or null when there are no more results',
    },
    hasMore: {
      type: 'boolean',
      description: 'Whether another page of results is available',
    },
    nextCursor: {
      type: 'string',
      optional: true,
      description:
        'Cursor for the next page (`response_metadata.next_cursor`); absent or null when there are no more results',
    },
  },
}
