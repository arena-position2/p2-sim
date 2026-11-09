import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const googleSheetsCreateContract = defineRouteContract({
  method: 'POST',
  path: '/api/tools/google_sheets/create_spreadsheet',
  body: z.object({
    title: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim() : value),
      requiredFieldSchema('title is required')
    ),
    sheetTitles: z.array(z.string()).optional(),
    locale: z.string().optional(),
    timeZone: z.string().optional(),
    parentFolderId: z.string().optional(),
    accessToken: z.string().optional(),
  }),
  response: {
    mode: 'json',
    schema: z.object({
      output: z.object({
        spreadsheetId: z.string(),
        title: z.string(),
        spreadsheetUrl: z.string(),
        sheets: z.array(
          z.object({
            sheetId: z.number(),
            title: z.string(),
            index: z.number(),
          })
        ),
      }),
    }),
  },
})
