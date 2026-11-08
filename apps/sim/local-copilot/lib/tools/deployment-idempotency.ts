import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

type DeploymentToolContext = Pick<ToolExecutionContext, 'messageId' | 'runId' | 'activeToolCallId'>

interface DeploymentAttemptCurrentState {
  isCurrent?: boolean
}

/**
 * Builds a retry-stable scope for one deployment intent in a Copilot run.
 * Mirrors Cloud `getCopilotDeploymentIdempotencyKey`.
 */
export function getCopilotDeploymentIdempotencyKey(
  context: DeploymentToolContext,
  operation: string
): string | undefined {
  const executionScope = context.runId ?? context.messageId
  if (executionScope) return `copilot:${executionScope}:operation:${operation}`
  return context.activeToolCallId
    ? `copilot:tool-call:${context.activeToolCallId}:operation:${operation}`
    : undefined
}

/** Rejects a replay whose persisted operation no longer describes production. */
export function getHistoricalDeploymentAttemptError(
  attempt: DeploymentAttemptCurrentState | null | undefined,
  action: string
): string | null {
  if (attempt?.isCurrent !== false) return null
  return `The ${action} operation associated with this tool call is historical and no longer describes production. Start a new tool call to create a new logical deployment operation.`
}

/** Returns an error until this call's admitted version is the active production version. */
export function getUnconfirmedDeploymentError(
  result: {
    latestDeploymentAttempt?: { status?: string } | null
    activeDeployment?: { deploymentVersionId?: string } | null
    deploymentVersionId?: string
    version?: number
    warnings?: string[]
  },
  action: string
): string | null {
  const attempt = result.latestDeploymentAttempt
  const activeVersionId = result.activeDeployment?.deploymentVersionId
  if (
    attempt?.status === 'active' &&
    result.deploymentVersionId !== undefined &&
    activeVersionId === result.deploymentVersionId
  ) {
    return null
  }

  const versionLabel = result.version === undefined ? '' : ` v${result.version}`
  const status = attempt?.status ?? 'unknown'
  const detail = result.warnings?.[0] ?? `${action}${versionLabel} is ${status}, not active.`
  return `${detail} Do not submit a new deployment; check the existing attempt's status.`
}
