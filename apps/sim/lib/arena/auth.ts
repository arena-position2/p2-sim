import { env } from '@/lib/core/config/env'

export type ArenaAuthMode = 'human' | 'automation'

export const ARENA_AUTOMATION_TRIGGERS = new Set(['schedule', 'webhook'])

/** Header set by first-party tool transport from execution `_context.triggerType`. */
export const SIM_TRIGGER_TYPE_HEADER = 'x-sim-trigger-type'
export const SIM_WORKFLOW_ID_HEADER = 'x-sim-workflow-id'
export const SIM_EXECUTION_ID_HEADER = 'x-sim-execution-id'

export function isAutomationTrigger(triggerType?: string | null): boolean {
  if (!triggerType) return false
  return ARENA_AUTOMATION_TRIGGERS.has(triggerType.trim().toLowerCase())
}

export function resolveArenaAuthMode(triggerType?: string | null): ArenaAuthMode {
  return isAutomationTrigger(triggerType) ? 'automation' : 'human'
}

export type AutomationArenaHeaderOptions = {
  actingUserSysId: string
  workflowId?: string
  executionId?: string
}

/**
 * Headers for unattended Arena sol calls (schedules / webhooks).
 * Never includes a human Authorisation JWT.
 */
export function getAutomationArenaHeaders(
  options: AutomationArenaHeaderOptions
): Record<string, string> {
  const serviceKey = env.ARENA_SERVICE_KEY?.trim()
  if (!serviceKey) {
    throw new Error('ARENA_SERVICE_KEY is not configured')
  }
  const actingUserSysId = options.actingUserSysId.trim()
  if (!actingUserSysId) {
    throw new Error('X-Acting-User-Id requires a non-empty Arena sysId')
  }

  const headers: Record<string, string> = {
    'X-Arena-Service-Key': serviceKey,
    'X-Acting-User-Id': actingUserSysId,
    Accept: 'application/json',
  }
  if (options.workflowId?.trim()) {
    headers['X-Sim-Workflow-Id'] = options.workflowId.trim()
  }
  if (options.executionId?.trim()) {
    headers['X-Sim-Execution-Id'] = options.executionId.trim()
  }
  return headers
}

/** Headers for interactive Arena sol calls — human SSO access JWT only. */
export function getHumanArenaHeaders(accessToken: string): Record<string, string> {
  return {
    authorisation: accessToken,
    Accept: 'application/json',
  }
}
