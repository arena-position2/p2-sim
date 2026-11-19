import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { z } from 'zod'
import { generateRequestId } from '@/lib/core/utils/request'

const logger = createLogger('GmailAPI')

/**
 * Schema for email result payload
 */
const EmailResultSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  subject: z.string(),
  from: z.string(),
  to: z.string(),
  date: z.string(),
  content: z.string(),
})

const GmailPayloadSchema = z.object({
  results: z.array(EmailResultSchema),
})

/**
 * POST - Summarize all emails in the results list using OpenAI
 */
export async function POST(req: NextRequest) {
  const requestId = generateRequestId()

  try {
    const body = await req.json()

    // Validate request payload
    let validatedData
    try {
      validatedData = GmailPayloadSchema.parse(body)
    } catch (validationError) {
      if (validationError instanceof z.ZodError) {
        logger.warn(`[${requestId}] Invalid request payload`, {
          errors: validationError.issues,
        })
        return NextResponse.json(
          { error: 'Invalid request data', details: validationError.issues },
          { status: 400 }
        )
      }
      throw validationError
    }

    // Check if results array is empty
    if (!validatedData.results || validatedData.results.length === 0) {
      logger.warn(`[${requestId}] Empty results array`)
      return NextResponse.json({ error: 'Results array cannot be empty' }, { status: 400 })
    }

    // Get OpenAI API key from environment
    const openaiApiKey = process.env.OPENAI_API_KEY
    if (!openaiApiKey) {
      logger.error(`[${requestId}] OpenAI API key not configured`)
      return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 })
    }

    // Initialize OpenAI client
    const openai = new OpenAI({ apiKey: openaiApiKey })

    logger.info(`[${requestId}] Summarizing ${validatedData.results.length} email(s)`)

    // Combine all emails into a single prompt
    const emailsText = validatedData.results
      .map(
        (email, index) =>
          `Email ${index + 1}:\nSubject: ${email.subject}\nFrom: ${email.from}\nTo: ${email.to}\nDate: ${email.date}\n\nContent:\n${email.content}\n\n---\n`
      )
      .join('\n')

    // Prepare the user prompt with all email content
    const userPrompt = `Summarise these emails -\n\n${emailsText}`

    // Call OpenAI API once for all emails
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are an excellent Email Summariser.',
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    })

    const summary = completion.choices[0]?.message?.content || ''

    logger.info(`[${requestId}] Successfully summarized ${validatedData.results.length} email(s)`)

    return NextResponse.json({
      success: true,
      summary,
      emailCount: validatedData.results.length,
    })
  } catch (error) {
    logger.error(`[${requestId}] Error processing request`, error)
    return NextResponse.json(
      {
        error: 'Failed to process request',
        message: error instanceof Error ? error.message : 'Unknown error occurred',
      },
      { status: 500 }
    )
  }
}
