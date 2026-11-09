import { z } from 'zod'
import { requiredFieldSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format. Use YYYY-MM-DD')

const statsBackfillQuerySchema = z.object({
  startDate: requiredFieldSchema(
    'Both startDate and endDate query parameters are required (format: YYYY-MM-DD)'
  ).pipe(calendarDate),
  endDate: requiredFieldSchema(
    'Both startDate and endDate query parameters are required (format: YYYY-MM-DD)'
  ).pipe(calendarDate),
  skipExisting: z.string().optional(),
})

const statsBackfillResponseSchema = z.object({
  message: z.string(),
  datesProcessed: z.number(),
  totalProcessedWorkflows: z.number(),
  totalInsertedRecords: z.number(),
  totalSkippedWorkflows: z.number(),
  totalErrors: z.number(),
  errorDates: z.array(z.string()).optional(),
  dateRange: z.object({
    start: z.string(),
    end: z.string(),
  }),
  dates: z.array(z.string()),
})

export const statsDailyContract = defineRouteContract({
  method: 'GET',
  path: '/api/stats/daily',
  response: {
    mode: 'json',
    schema: z.object({
      message: z.string(),
      processedWorkflows: z.number(),
      totalWorkflows: z.number(),
      skippedWorkflows: z.number(),
    }),
  },
})

export const statsMonthlyContract = defineRouteContract({
  method: 'GET',
  path: '/api/stats/monthly',
  response: {
    mode: 'json',
    schema: z.object({
      message: z.string(),
      processedWorkflows: z.number(),
      totalWorkflows: z.number(),
      dateRange: z.object({
        start: z.string(),
        end: z.string(),
      }),
    }),
  },
})

export const statsPopulateDailyContract = defineRouteContract({
  method: 'GET',
  path: '/api/stats/populate/daily',
  query: statsBackfillQuerySchema,
  response: { mode: 'json', schema: statsBackfillResponseSchema },
})

export const statsPopulateMonthlyContract = defineRouteContract({
  method: 'GET',
  path: '/api/stats/populate/monthly',
  query: statsBackfillQuerySchema,
  response: { mode: 'json', schema: statsBackfillResponseSchema },
})
