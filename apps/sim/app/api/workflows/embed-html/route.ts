import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { V2_WORKFLOW_BILLING_EMAIL_HEADER } from '@/lib/api/contracts/v2/workflows'
import { getSession } from '@/lib/auth'
import { generateInternalToken } from '@/lib/auth/internal'
import { getBaseUrl, getInternalApiBaseUrl } from '@/lib/core/utils/urls'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'

const logger = createLogger('WorkflowEmbedHtmlApi')

const RequestSchema = z.object({
  persona: z.string().trim().min(1).optional(),
})

type AgentExecuteResponse<T> = {
  output?: { result?: T }
  result?: T
  error?: string
  success?: boolean
}

type EmbedResolveResult = {
  workflow_id?: string | null
  api_key?: string | null
  workflowId?: string | null
  apiKey?: string | null
}

type EmbedHtmlResult = {
  html?: string
}

type UpstreamAuth = { type: 'apiKey'; apiKey: string } | { type: 'internalJwt'; userId: string }

function parseEmbedWorkflowId(result: EmbedResolveResult | undefined): string | null {
  if (!result) return null
  if (typeof result.workflow_id === 'string' && result.workflow_id.trim()) {
    return result.workflow_id.trim()
  }
  if (typeof result.workflowId === 'string' && result.workflowId.trim()) {
    return result.workflowId.trim()
  }
  return null
}

function buildExecuteUrl(agentBaseUrl: string, workflowId: string): string {
  return `${agentBaseUrl}/api/workflows/${workflowId}/execute`
}

/**
 * Prefer the in-cluster / same-deployment base URL when the configured agent host
 * matches this app, so internal JWT auth works for loopback execute calls.
 */
function resolveExecuteBaseUrl(agentBaseUrl: string): string {
  try {
    const configured = new URL(agentBaseUrl)
    const app = new URL(getBaseUrl())
    if (configured.host === app.host) {
      return getInternalApiBaseUrl().replace(/\/$/, '')
    }
  } catch {
    // fall through to the configured agent base URL
  }
  return agentBaseUrl
}

/**
 * Upstream execute auth failures must not surface as the caller's session 401.
 */
function mapUpstreamStatus(status: number): number {
  if (status === 401 || status === 403) return 502
  return status
}

function responseForLog<T>(data: AgentExecuteResponse<T>): AgentExecuteResponse<T> {
  const result = data.output?.result ?? data.result
  if (
    result &&
    typeof result === 'object' &&
    'html' in result &&
    typeof (result as EmbedHtmlResult).html === 'string'
  ) {
    const html = (result as EmbedHtmlResult).html as string
    const truncatedResult = { ...result, html: `[truncated ${html.length} chars]` }
    if (data.output?.result) {
      return { ...data, output: { result: truncatedResult as T } }
    }
    return { ...data, result: truncatedResult as T }
  }
  return data
}

async function buildUpstreamHeaders(
  auth: UpstreamAuth,
  userEmail: string
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [V2_WORKFLOW_BILLING_EMAIL_HEADER]: userEmail,
  }

  if (auth.type === 'apiKey') {
    headers['X-API-Key'] = auth.apiKey
    return headers
  }

  const token = await generateInternalToken(auth.userId)
  headers.Authorization = `Bearer ${token}`
  return headers
}

async function executeAgentWorkflow<T>(params: {
  agentBaseUrl: string
  workflowId: string
  auth: UpstreamAuth
  userEmail: string
  body: Record<string, unknown>
  logLabel: string
}): Promise<
  { ok: true; data: AgentExecuteResponse<T> } | { ok: false; status: number; error: string }
> {
  const url = buildExecuteUrl(params.agentBaseUrl, params.workflowId)

  logger.info(`Embed HTML upstream request: ${params.logLabel}`, {
    url,
    workflowId: params.workflowId,
    authType: params.auth.type,
    body: params.body,
  })

  const upstream = await fetch(url, {
    method: 'POST',
    headers: await buildUpstreamHeaders(params.auth, params.userEmail),
    body: JSON.stringify(params.body),
    cache: 'no-store',
  })

  if (!upstream.ok) {
    const error = await upstream.text().catch(() => '')
    logger.error(`Embed HTML upstream request failed: ${params.logLabel}`, {
      url,
      workflowId: params.workflowId,
      authType: params.auth.type,
      status: upstream.status,
      response: error,
    })
    return { ok: false, status: mapUpstreamStatus(upstream.status), error }
  }

  const data = (await upstream.json()) as AgentExecuteResponse<T>
  logger.info(`Embed HTML upstream response: ${params.logLabel}`, {
    url,
    workflowId: params.workflowId,
    authType: params.auth.type,
    response: responseForLog(data),
  })
  return { ok: true, data }
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withRouteHandler(async (req: NextRequest) => {
  const session = await getSession()
  if (!session?.user?.id) {
    logger.warn('Embed HTML rejected: missing Better Auth session', {
      hasCookieHeader: Boolean(req.headers.get('cookie')),
      origin: req.headers.get('origin'),
    })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userEmail = session.user.email?.trim()
  if (!userEmail) {
    return NextResponse.json({ error: 'Logged-in user email is required' }, { status: 400 })
  }

  const resolveWorkflowId = process.env.SIM_AGENT_EMBED_WORKFLOW_ID
  const resolveApiKey = process.env.SIM_AGENT_EMBED_KEY
  const agentBaseUrl = process.env.SIM_AGENT_BASE_URL_HTML?.replace(/\/$/, '')

  if (!resolveWorkflowId || !resolveApiKey || !agentBaseUrl) {
    logger.error('Embed HTML resolver env configuration missing', {
      hasResolveWorkflowId: Boolean(resolveWorkflowId),
      hasResolveApiKey: Boolean(resolveApiKey),
      hasAgentBaseUrl: Boolean(agentBaseUrl),
    })
    return NextResponse.json({ error: 'Embed HTML API not configured' }, { status: 500 })
  }

  let body: z.infer<typeof RequestSchema> = {}
  try {
    // boundary-raw-json: tolerant body parse — invalid/missing JSON falls back to empty object + default persona
    const rawBody = await req.json()
    body = RequestSchema.parse(rawBody)
  } catch {
    body = {}
  }

  const persona = body.persona?.trim() || 'CEO'
  const executeBaseUrl = resolveExecuteBaseUrl(agentBaseUrl)

  try {
    const resolveResult = await executeAgentWorkflow<EmbedResolveResult>({
      agentBaseUrl: executeBaseUrl,
      workflowId: resolveWorkflowId,
      auth: { type: 'apiKey', apiKey: resolveApiKey },
      userEmail,
      body: { userId: session.user.id, email: session.user.email },
      logLabel: 'resolve-credentials',
    })

    if (!resolveResult.ok) {
      logger.error('Embed credential resolver workflow failed', {
        resolveWorkflowId,
        status: resolveResult.status,
        error: resolveResult.error,
      })
      return NextResponse.json(
        { error: 'Failed to resolve embed workflow credentials' },
        { status: resolveResult.status }
      )
    }

    const resolvePayload = resolveResult.data
    const htmlWorkflowId = parseEmbedWorkflowId(
      resolvePayload.output?.result ?? resolvePayload.result
    )

    logger.info('Embed HTML resolved workflow', {
      workflowId: htmlWorkflowId,
    })

    if (!htmlWorkflowId) {
      logger.error('Embed credential resolver returned no workflow_id', {
        resolveWorkflowId,
        response: resolvePayload,
      })
      return NextResponse.json({ error: 'Agent API did not return workflow_id' }, { status: 502 })
    }

    // Resolve workflows often return a stale/invalid api_key. For same-deployment
    // loopback executes, authenticate as the logged-in user with an internal JWT.
    const htmlResult = await executeAgentWorkflow<EmbedHtmlResult>({
      agentBaseUrl: executeBaseUrl,
      workflowId: htmlWorkflowId,
      auth: { type: 'internalJwt', userId: session.user.id },
      userEmail,
      body: {
        persona,
        userId: session.user.id,
        email: session.user.email,
      },
      logLabel: 'render-html',
    })

    if (!htmlResult.ok) {
      logger.error('Upstream embed workflow request failed', {
        workflowId: htmlWorkflowId,
        status: htmlResult.status,
        error: htmlResult.error,
      })
      return NextResponse.json(
        { error: 'Failed to fetch workflow HTML' },
        { status: htmlResult.status }
      )
    }

    const htmlPayload = htmlResult.data
    if (htmlPayload.success === false && htmlPayload.error) {
      logger.error('Upstream embed workflow executed with error', {
        workflowId: htmlWorkflowId,
        error: htmlPayload.error,
      })
      return NextResponse.json({ error: htmlPayload.error }, { status: 502 })
    }

    const html = htmlPayload.output?.result?.html ?? htmlPayload.result?.html
    if (typeof html !== 'string' || html.trim().length === 0) {
      return NextResponse.json(
        { error: 'Workflow response did not include result.html' },
        { status: 502 }
      )
    }

    return NextResponse.json({ html })
  } catch (error) {
    logger.error('Failed to render workflow embed HTML', {
      error: toError(error).message,
    })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
})
