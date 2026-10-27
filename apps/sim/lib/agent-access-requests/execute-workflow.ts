import { createLogger } from '@sim/logger'
import { env } from '@/lib/core/config/env'

const logger = createLogger('AgentAccessRequestWorkflow')

export function buildSimWorkflowExecuteUrl(baseUrl: string, workflowId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/v2/workflows/${workflowId}/execute`
}

interface ExecuteSimWorkflowInput {
  workflowId: string
  input: Record<string, unknown>
  signal?: AbortSignal
}

interface ExecuteSimWorkflowResult {
  ok: true
  payload: unknown
}

/**
 * Executes a Sim workflow via the shared agent base URL + API key.
 * Returns a structured failure when env/config or upstream call fails.
 */
export async function executeSimAgentWorkflow({
  workflowId,
  input,
  signal,
}: ExecuteSimWorkflowInput): Promise<
  ExecuteSimWorkflowResult | { ok: false; status: number; error: string }
> {
  const apiKey = env.SIM_WORKFLOW_API_KEY
  const baseUrl = env.SIM_AGENT_BASE_URL
  if (!apiKey || !baseUrl) {
    logger.error('Sim agent workflow env is incomplete', {
      hasApiKey: Boolean(apiKey),
      hasBaseUrl: Boolean(baseUrl),
    })
    return { ok: false, status: 500, error: 'Agent access request workflow is not configured' }
  }

  const executeUrl = buildSimWorkflowExecuteUrl(baseUrl, workflowId)
  const requestBody = { input }
  try {
    logger.info('Executing Sim agent workflow', {
      workflowId,
      executeUrl,
      inputKeys: Object.keys(input),
      hasApprovedBy: typeof input.approved_by === 'string' && input.approved_by.length > 0,
    })

    const upstream = await fetch(executeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(requestBody),
      signal,
    })

    if (!upstream.ok) {
      const bodyText = await upstream.text().catch(() => '')
      logger.error('Upstream Sim workflow failed', {
        status: upstream.status,
        workflowId,
        body: bodyText.slice(0, 500),
      })
      return { ok: false, status: 502, error: 'Upstream workflow request failed' }
    }

    return { ok: true, payload: await upstream.json() }
  } catch (error: unknown) {
    if (signal?.aborted) {
      return { ok: false, status: 499, error: 'Request cancelled' }
    }
    throw error
  }
}
