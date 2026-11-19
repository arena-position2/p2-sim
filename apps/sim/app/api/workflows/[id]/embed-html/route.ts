import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { V2_WORKFLOW_BILLING_EMAIL_HEADER } from '@/lib/api/contracts/v2/workflows'
import { getSession } from '@/lib/auth'

const logger = createLogger('WorkflowEmbedHtmlApi')

const RequestSchema = z.object({
  persona: z.string().trim().min(1).default('CEO'),
})

interface RouteContext {
  params: Promise<{ id: string }>
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, context: RouteContext) {
  const session = await getSession()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userEmail = session.user.email?.trim()
  if (!userEmail) {
    return NextResponse.json({ error: 'Logged-in user email is required' }, { status: 400 })
  }

  const { id: workflowId } = await context.params
  const apiKey = process.env.SIM_WORKFLOW_API_KEY
  if (!apiKey) {
    logger.error('SIM_WORKFLOW_API_KEY missing for embed-html route')
    return NextResponse.json({ error: 'Agent API not configured' }, { status: 500 })
  }

  const agentBaseUrl = process.env.SIM_AGENT_BASE_URL_HTML?.replace(/\/$/, '')

  let body: z.infer<typeof RequestSchema>
  try {
    body = RequestSchema.parse(await req.json())
  } catch {
    body = { persona: 'CEO' }
  }

  try {
    const upstream = await fetch(`${agentBaseUrl}/api/workflows/${workflowId}/execute`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        [V2_WORKFLOW_BILLING_EMAIL_HEADER]: userEmail,
      },
      body: JSON.stringify({ persona: body.persona }),
      cache: 'no-store',
    })

    if (!upstream.ok) {
      const upstreamError = await upstream.text().catch(() => '')
      logger.error('Upstream embed workflow request failed', {
        workflowId,
        status: upstream.status,
        error: upstreamError,
      })
      return NextResponse.json(
        { error: 'Failed to fetch workflow HTML' },
        { status: upstream.status }
      )
    }

    const payload = (await upstream.json()) as {
      result?: { html?: string }
    }
    const html = payload?.result?.html
    if (typeof html !== 'string' || html.trim().length === 0) {
      return NextResponse.json(
        { error: 'Workflow response did not include result.html' },
        { status: 502 }
      )
    }

    return NextResponse.json({ html })
  } catch (error) {
    logger.error('Failed to render workflow embed HTML', {
      workflowId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
