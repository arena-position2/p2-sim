import { z } from 'zod'
import { requiredFieldSchema, workspaceIdSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const unipileAccountOptionSourceSchema = z.enum(['public', 'personal'])

export const unipileAccountOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  source: unipileAccountOptionSourceSchema,
  externalAccountId: z.string().min(1),
  credentialId: z.string().min(1).optional(),
  canReconnect: z.boolean(),
})

export type UnipileAccountOption = z.output<typeof unipileAccountOptionSchema>

export const listUnipileAccountsQuerySchema = z.object({
  workspaceId: workspaceIdSchema,
})

export type ListUnipileAccountsQuery = z.input<typeof listUnipileAccountsQuerySchema>

export const listUnipileAccountsResponseSchema = z.object({
  success: z.boolean(),
  items: z.array(unipileAccountOptionSchema),
  error: z.string().optional(),
})

export type ListUnipileAccountsResponse = z.output<typeof listUnipileAccountsResponseSchema>

export const listUnipileAccountsContract = defineRouteContract({
  method: 'GET',
  path: '/api/unipile/accounts',
  query: listUnipileAccountsQuerySchema,
  response: {
    mode: 'json',
    schema: listUnipileAccountsResponseSchema,
  },
})

const unipilePickerItemSchema = z.object({
  id: z.string(),
  label: z.string(),
})

export const listUnipileChatsContract = defineRouteContract({
  method: 'GET',
  path: '/api/unipile/chats',
  query: z.object({
    account_id: requiredFieldSchema('account_id query parameter is required'),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      success: z.literal(true),
      items: z.array(unipilePickerItemSchema),
    }),
  },
})

export const listUnipileUserRelationsContract = defineRouteContract({
  method: 'GET',
  path: '/api/unipile/user-relations',
  query: z.object({
    account_id: requiredFieldSchema('account_id query parameter is required'),
    filter: z.string().optional(),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      success: z.literal(true),
      items: z.array(unipilePickerItemSchema),
    }),
  },
})
