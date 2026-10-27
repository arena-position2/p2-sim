import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSession } from '@/lib/auth'

const logger = createLogger('AgentResolveWorkspace')

const RequestSchema = z.object({
  message: z.string().min(1),
  context: z.string().optional(),
})

/**
 * POST /api/agent/resolve-workspace
 *
 * Resolves the workspace to use for a Mothership chat turn by calling the external
 * agent workflow. The external API returns a workspaceId that is then used as the
 * target workspace for the subsequent mothership/chat call.
 */
export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session?.user?.id) {
    logger.warn('Unauthorized resolve-workspace request — no active session')
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id

  const apiKey = process.env.SIM_WORKFLOW_API_KEY
  if (!apiKey) {
    logger.error('SIM_API_KEY is not configured — cannot resolve workspace')
    return NextResponse.json({ error: 'Agent API not configured' }, { status: 500 })
  }
  const resolveUrl = `${process.env.SIM_AGENT_BASE_URL}/api/workflows/${process.env.SIM_AGENT_WORKSPACE_RESOLVE_ID}/execute`
  if (!resolveUrl) {
    logger.error('SIM_AGENT_WORKSPACE_RESOLVE_URL is not configured')
    return NextResponse.json({ error: 'Agent resolve URL not configured' }, { status: 500 })
  }

  let message: string
  let context: string | undefined
  try {
    const body = RequestSchema.parse(await req.json())
    message = body.message
    context = body.context
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid resolve-workspace request body', { errors: error.issues })
      return NextResponse.json({ error: 'Invalid request', details: error.issues }, { status: 400 })
    }
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  logger.info('Resolving workspace via external agent API', {
    userId,
    url: resolveUrl,
    messageLength: message.length,
  })

  const startTime = Date.now()

  try {
    const agentResponse = await fetch(resolveUrl, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        userId,
        context: context ?? '',
        stream: false,
        selectedOutputs: ['buildpayload.result'],
      }),
    })
    const durationMs = Date.now() - startTime
    if (!agentResponse.ok) {
      const errorText = await agentResponse.text().catch(() => '')
      logger.error('External agent API returned non-OK status', {
        userId,
        status: agentResponse.status,
        durationMs,
        error: errorText,
      })
      return NextResponse.json(
        { error: 'Failed to resolve workspace from agent API' },
        { status: agentResponse.status }
      )
    }
    logger.info('External agent API responded successfully', {
      userId,
      durationMs,
      agentResponse,
    })
    const data = await agentResponse.json()
    const result = data?.output?.result
    const workspaceId = result?.workspaceId
    const workflowId = typeof result?.workflowId === 'string' ? result.workflowId : undefined
    const selectedOutputs = Array.isArray(result?.selectedOutputs)
      ? result.selectedOutputs.filter(
          (output: unknown): output is string => typeof output === 'string'
        )
      : undefined

    const userApiKey = result?.apiKey

    if (!workspaceId) {
      logger.error('External agent API response missing workspaceId', {
        userId,
        durationMs,
        response: data,
      })
      return NextResponse.json({ error: 'Agent API did not return a workspaceId' }, { status: 502 })
    }

    logger.info('Workspace resolved successfully', {
      userId,
      workspaceId,
      workflowId,
      selectedOutputsCount: selectedOutputs?.length ?? 0,
      durationMs,
      mode: data?.result?.mode,
      isNewMessage: data?.result?.isNewMessage,
    })

    return NextResponse.json({
      workspaceId,
      ...(workflowId ? { workflowId } : {}),
      ...(selectedOutputs && selectedOutputs.length > 0 ? { selectedOutputs } : {}),
      ...(userApiKey ? { userApiKey } : {}),
    })
  } catch (error) {
    const durationMs = Date.now() - startTime
    logger.error('Unexpected error calling external agent API', {
      userId,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
