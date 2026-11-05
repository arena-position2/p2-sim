/**
 * Catalog leaves that still have no Cloud mothership handler and no Arena
 * local implementation yet. Intercept them so the model gets a clear message
 * instead of "Tool not found".
 *
 * Prefer implementing a real local executor (or dropping the leaf from the
 * Arena catalog) over growing this set.
 */
export const REMAINING_DELEGATED_STUB_TOOLS = [
  'manage_scheduled_task',
  'complete_scheduled_task',
  'update_scheduled_task_history',
  'get_scheduled_task_logs',
  'manage_credential',
  'oauth_request_access',
  'restore_resource',
  'get_platform_actions',
  'get_block_outputs',
  'get_block_upstream_references',
  'get_deployed_workflow_state',
] as const

export type RemainingDelegatedStubToolName = (typeof REMAINING_DELEGATED_STUB_TOOLS)[number]

export function isRemainingDelegatedStubToolName(
  toolName: string
): toolName is RemainingDelegatedStubToolName {
  return (REMAINING_DELEGATED_STUB_TOOLS as readonly string[]).includes(toolName)
}

export function remainingDelegatedStubMessage(toolName: RemainingDelegatedStubToolName): string {
  switch (toolName) {
    case 'manage_scheduled_task':
    case 'complete_scheduled_task':
    case 'update_scheduled_task_history':
    case 'get_scheduled_task_logs':
      return `${toolName} is not available in Arena Local Copilot yet. Manage scheduled tasks from workspace settings.`
    case 'manage_credential':
      return 'manage_credential is not available in Arena Local Copilot yet. Manage OAuth credentials from workspace settings.'
    case 'oauth_request_access':
      return 'oauth_request_access is not available in Arena Local Copilot yet. Ask the credential owner to share access from settings.'
    case 'restore_resource':
      return 'restore_resource is not available in Arena Local Copilot yet. Restore from Recently deleted in the UI.'
    case 'get_platform_actions':
      return 'get_platform_actions is not available in Arena Local Copilot yet.'
    case 'get_block_outputs':
    case 'get_block_upstream_references':
      return `${toolName} is not available in Arena Local Copilot yet. Use get_workflow_data or run_workflow and inspect block outputs from the run result.`
    case 'get_deployed_workflow_state':
      return 'get_deployed_workflow_state is not available in Arena Local Copilot yet. Use check_deployment_status and diff_workflows(ref1: "live", ref2: "draft").'
  }
}
