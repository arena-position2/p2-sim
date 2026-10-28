import { db } from '@sim/db'
import { user } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { inArray } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'
import { generateRequestId } from '@/lib/core/utils/request'

const logger = createLogger('ValidateEmailsAPI')

const validateEmailsSchema = z.object({
  emails: z.array(z.string().email()).min(1, 'At least one email is required'),
})

/**
 * POST /api/users/validate-emails
 * Validate if emails exist in the user database
 */
export async function POST(request: NextRequest) {
  const requestId = generateRequestId()

  try {
    const session = await getSession()
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { emails } = validateEmailsSchema.parse(body)

    // Query database for existing users
    const existingUsers = await db
      .select({ email: user.email })
      .from(user)
      .where(inArray(user.email, emails))

    const existingEmails = new Set(existingUsers.map((u) => u.email.toLowerCase()))
    const missingEmails = emails.filter((email) => !existingEmails.has(email.toLowerCase()))

    return NextResponse.json({
      valid: missingEmails.length === 0,
      existingEmails: Array.from(existingEmails),
      missingEmails,
    })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      logger.warn(`[${requestId}] Invalid request body`, { errors: error.issues })
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 })
    }

    logger.error(`[${requestId}] Error validating emails`, error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
