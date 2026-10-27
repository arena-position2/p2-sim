import type { SlackMessageParams, SlackMessageResponse } from '@/tools/slack/types'
import { MESSAGE_OUTPUT_PROPERTIES } from '@/tools/slack/types'
import type { InternalToolConfig } from '@/tools/types'

export const slackMessageTool: InternalToolConfig<SlackMessageParams, SlackMessageResponse> = {
  id: 'slack_message',
  name: 'Slack Message',
  description:
    'Send a Slack message. If destinationType is omitted, it is inferred: channel/channelId => channel message; dmUserId/userId => DM. If both are provided, destinationType wins (otherwise channel wins).',
  version: '1.0.0',

  oauth: {
    required: true,
    provider: 'slack',
    requiredScopes: ['chat:write'],
  },

  params: {
    authMethod: {
      type: 'string',
      required: false,
      visibility: 'user-only',
      description:
        'Authentication method: oauth (Sim Bot / bot token) or bot_token (Custom Bot / user token). Choose bot_token for user-level actions; choose oauth for bot/app actions.',
    },
    destinationType: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Optional. Destination type: channel or dm. If omitted, inferred from provided IDs.',
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
    channel: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Slack channel ID (e.g., C1234567890)',
    },
    channelId: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Alias for channel (Slack channel ID, e.g., C1234567890)',
    },
    dmUserId: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Slack user ID for direct messages (e.g., U1234567890)',
    },
    text: {
      type: 'string',
      required: true,
      visibility: 'user-or-llm',
      description: 'Message text to send (supports Slack mrkdwn formatting)',
    },
    threadTs: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Thread timestamp to reply to (creates thread reply)',
    },
    blocks: {
      type: 'json',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Block Kit layout blocks as a JSON array. When provided, text becomes the fallback notification text.',
    },
    files: {
      type: 'file[]',
      required: false,
      visibility: 'user-only',
      description: 'Files to attach to the message',
    },
  },

  operation: {
    input: (params: SlackMessageParams) => {
      const normalizeId = (value: unknown, keys: string[]): string | undefined => {
        if (typeof value === 'string') {
          const trimmed = value.trim()
          return trimmed ? trimmed : undefined
        }
        if (value && typeof value === 'object') {
          for (const key of keys) {
            const v = (value as Record<string, unknown>)[key]
            if (typeof v === 'string' && v.trim()) return v.trim()
          }
        }
        return undefined
      }

      const channel =
        normalizeId(params.channel, ['channel_id', 'id']) ??
        normalizeId((params as SlackMessageParams & { channelId?: unknown }).channelId, [
          'channel_id',
          'id',
        ])
      const dmUserId = normalizeId(params.dmUserId, ['user_id', 'id'])

      const hasChannel = Boolean(channel)
      const hasDmUser = Boolean(dmUserId)

      const destinationType: 'channel' | 'dm' = (() => {
        const explicit =
          params.destinationType === 'channel' || params.destinationType === 'dm'
            ? params.destinationType
            : null

        if (explicit === 'channel') {
          if (hasChannel) return 'channel'
          if (hasDmUser) return 'dm'
          return 'channel'
        }

        if (explicit === 'dm') {
          if (hasDmUser) return 'dm'
          if (hasChannel) return 'channel'
          return 'dm'
        }

        if (hasChannel) return 'channel'
        if (hasDmUser) return 'dm'
        return 'channel'
      })()

      const isDM = destinationType === 'dm'
      const finalChannel = isDM ? undefined : channel
      const finalUserId = isDM ? dmUserId : undefined

      if (isDM && !finalUserId) {
        throw new Error('For destinationType=dm, provide dmUserId.')
      }
      if (!isDM && !finalChannel) {
        throw new Error('For destinationType=channel, provide channel (or channelId).')
      }

      return {
        accessToken: params.accessToken || params.botToken,
        channel: finalChannel,
        userId: finalUserId,
        text: params.text,
        thread_ts: params.threadTs?.trim() || undefined,
        blocks:
          typeof params.blocks === 'string'
            ? JSON.parse(params.blocks)
            : params.blocks || undefined,
        link_names: true,
        unfurl_links: true,
        unfurl_media: true,
        files: params.files || null,
      }
    },
  },

  transformResponse: async (response: Response) => {
    const data = await response.json()
    if (!data.success) {
      throw new Error(data.error || 'Failed to send Slack message')
    }
    return {
      success: true,
      output: data.output,
    }
  },

  outputs: {
    message: {
      type: 'object',
      description: 'Complete message object with all properties returned by Slack',
      properties: MESSAGE_OUTPUT_PROPERTIES,
    },
    // Legacy properties for backward compatibility
    ts: { type: 'string', description: 'Message timestamp' },
    channel: { type: 'string', description: 'Channel ID where message was sent' },
    fileCount: {
      type: 'number',
      description: 'Number of files uploaded (when files are attached)',
    },
    files: { type: 'file[]', description: 'Files attached to the message' },
  },
}
