import { z } from 'zod'
import {
  defineCommunicationToolContract,
  slackBlocksSchema,
} from '@/lib/api/contracts/tools/communication/shared'
import type {
  ContractBody,
  ContractBodyInput,
  ContractJsonResponse,
} from '@/lib/api/contracts/types'
import { RawFileInputArraySchema } from '@/lib/uploads/utils/file-schemas'

export const slackSendMessageBodySchema = z
  .object({
    accessToken: z.string().min(1, 'Access token is required'),
    channel: z.string().optional().nullable(),
    userId: z.string().optional().nullable(),
    text: z.string().min(1, 'Message text is required'),
    thread_ts: z.string().optional().nullable(),
    blocks: slackBlocksSchema.optional().nullable(),
    files: RawFileInputArraySchema.optional().nullable(),
    link_names: z.boolean().optional(),
    unfurl_links: z.boolean().optional(),
    unfurl_media: z.boolean().optional(),
  })
  .refine((data) => data.channel || data.userId, {
    message: 'Either channel or userId is required',
  })

export const slackReadMessagesBodySchema = z
  .object({
    accessToken: z.string().min(1, 'Access token is required'),
    channel: z.string().optional().nullable(),
    userId: z.string().optional().nullable(),
    limit: z.coerce
      .number()
      .min(1, 'Limit must be at least 1')
      .max(200, 'Limit cannot exceed 200')
      .optional()
      .nullable(),
    oldest: z.string().optional().nullable(),
    latest: z.string().optional().nullable(),
    fromDate: z.preprocess((val) => {
      if (val === '' || val === null || val === undefined) {
        return undefined
      }
      return val
    }, z.string().optional().nullable()),
    toDate: z.preprocess((val) => {
      if (val === '' || val === null || val === undefined) {
        return undefined
      }
      return val
    }, z.string().optional().nullable()),
    cursor: z.string().optional().nullable(),
    autoPaginate: z.preprocess((val) => {
      if (val === undefined || val === null) return undefined
      if (typeof val === 'boolean') return val
      if (val === 'true') return true
      if (val === 'false') return false
      return val
    }, z.boolean().optional().default(true)),
    includeThreads: z.preprocess((val) => {
      if (val === undefined || val === null) return undefined
      if (typeof val === 'boolean') return val
      if (val === 'true') return true
      if (val === 'false') return false
      return val
    }, z.boolean().optional().default(true)),
    maxThreads: z.preprocess(
      (val) => {
        if (val === '' || val === null || val === undefined) return 10
        const num = Number(val)
        return Number.isNaN(num) || num < 1 ? 10 : Math.min(num, 50)
      },
      z.number().min(1, 'maxThreads must be at least 1').max(50, 'maxThreads cannot exceed 50')
    ),
    maxRepliesPerThread: z.preprocess(
      (val) => {
        if (val === '' || val === null || val === undefined) return 100
        const num = Number(val)
        return Number.isNaN(num) || num < 1 ? 100 : Math.min(num, 200)
      },
      z
        .number()
        .min(1, 'maxRepliesPerThread must be at least 1')
        .max(200, 'maxRepliesPerThread cannot exceed 200')
    ),
  })
  .refine((data) => data.channel || data.userId, {
    message: 'Either channel or userId is required',
  })

export const slackReactionBodySchema = z.object({
  accessToken: z.string().min(1, 'Access token is required'),
  channel: z.string().min(1, 'Channel is required'),
  timestamp: z.string().min(1, 'Message timestamp is required'),
  name: z.string().min(1, 'Emoji name is required'),
})

export const slackDeleteMessageBodySchema = z.object({
  accessToken: z.string().min(1, 'Access token is required'),
  channel: z.string().min(1, 'Channel is required'),
  timestamp: z.string().min(1, 'Message timestamp is required'),
})

export const slackUpdateMessageBodySchema = z.object({
  accessToken: z.string().min(1, 'Access token is required'),
  channel: z.string().min(1, 'Channel is required'),
  timestamp: z.string().min(1, 'Message timestamp is required'),
  text: z.string().min(1, 'Message text is required'),
  blocks: slackBlocksSchema.optional().nullable(),
})

export const slackSendEphemeralBodySchema = z.object({
  accessToken: z.string().min(1, 'Access token is required'),
  channel: z.string().min(1, 'Channel ID is required'),
  user: z.string().min(1, 'User ID is required'),
  text: z.string().min(1, 'Message text is required'),
  thread_ts: z.string().optional().nullable(),
  blocks: slackBlocksSchema.optional().nullable(),
})

export const slackDownloadBodySchema = z.object({
  accessToken: z.string().min(1, 'Access token is required'),
  fileId: z.string().min(1, 'File ID is required'),
  fileName: z.string().optional().nullable(),
})

export const slackSendMessageContract = defineCommunicationToolContract(
  '/api/tools/slack/send-message',
  slackSendMessageBodySchema
)
export const slackReadMessagesContract = defineCommunicationToolContract(
  '/api/tools/slack/read-messages',
  slackReadMessagesBodySchema
)
export const slackAddReactionContract = defineCommunicationToolContract(
  '/api/tools/slack/add-reaction',
  slackReactionBodySchema
)
export const slackRemoveReactionContract = defineCommunicationToolContract(
  '/api/tools/slack/remove-reaction',
  slackReactionBodySchema
)
export const slackDeleteMessageContract = defineCommunicationToolContract(
  '/api/tools/slack/delete-message',
  slackDeleteMessageBodySchema
)
export const slackUpdateMessageContract = defineCommunicationToolContract(
  '/api/tools/slack/update-message',
  slackUpdateMessageBodySchema
)
export const slackSendEphemeralContract = defineCommunicationToolContract(
  '/api/tools/slack/send-ephemeral',
  slackSendEphemeralBodySchema
)
export const slackDownloadContract = defineCommunicationToolContract(
  '/api/tools/slack/download',
  slackDownloadBodySchema
)

export type SlackSendMessageBody = ContractBodyInput<typeof slackSendMessageContract>
export type SlackReadMessagesBody = ContractBody<typeof slackReadMessagesContract>
export type SlackReactionBody = ContractBodyInput<typeof slackAddReactionContract>
export type SlackDeleteMessageBody = ContractBodyInput<typeof slackDeleteMessageContract>
export type SlackUpdateMessageBody = ContractBodyInput<typeof slackUpdateMessageContract>
export type SlackSendEphemeralBody = ContractBodyInput<typeof slackSendEphemeralContract>
export type SlackDownloadBody = ContractBodyInput<typeof slackDownloadContract>

export type SlackSendMessageResponse = ContractJsonResponse<typeof slackSendMessageContract>
export type SlackReadMessagesResponse = ContractJsonResponse<typeof slackReadMessagesContract>
export type SlackReactionResponse = ContractJsonResponse<typeof slackAddReactionContract>
export type SlackDeleteMessageResponse = ContractJsonResponse<typeof slackDeleteMessageContract>
export type SlackUpdateMessageResponse = ContractJsonResponse<typeof slackUpdateMessageContract>
export type SlackSendEphemeralResponse = ContractJsonResponse<typeof slackSendEphemeralContract>
export type SlackDownloadResponse = ContractJsonResponse<typeof slackDownloadContract>
